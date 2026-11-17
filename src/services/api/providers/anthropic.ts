/**
 * Anthropic Messages 协议适配（规格 §4、§6.4、§6.5）。
 *
 * 编译：system 独立顶层字段、max_tokens 必填、thinking / stop_sequences / top_k；
 * 解析：message_start / content_block_* / message_delta / message_stop / ping / error。
 *
 * 可回传状态：thinking 的 signature 原样保留（只有带签名的思考块才回传）；
 * server_tool_use / web_search_tool_result / web_fetch_tool_result 是 DeepSeek 在
 * Anthropic 形状里的扩展块，作为 provider_block 透传原始 wire payload，不在这里解释语义。
 */

import type { ServerSentEvent } from '../sse.js'
import {
  assertIntegerAtLeast,
  assertNumberInRange,
  createInterruptedError,
  createStreamError,
  providerConfigError,
  readNestedErrorPayload,
  readStopSequences,
  type ParsedProviderError,
} from './errors.js'
import { buildEndpointUrl } from './normalize.js'
import {
  isRecord,
  readInteger,
  readNumber,
  readString,
  resolveCapabilities,
  type CanonicalAssistantBlock,
  type CanonicalRequest,
  type CompiledRequest,
  type Delta,
  type FinishReason,
  type NormalizedCitation,
  type ProtocolAdapter,
  type ProviderProfile,
  type ProviderUsage,
  type StreamParser,
} from './types.js'

const PROTOCOL = 'anthropic-messages' as const

/** 未配置 defaultMaxOutputTokens 时的兜底；Anthropic 的 max_tokens 必填 */
const DEFAULT_MAX_OUTPUT_TOKENS = 4096
/** thinking.budget_tokens 缺省值；需同时满足 >=1024 且 < max_tokens */
const DEFAULT_THINKING_BUDGET = 2048
/** Anthropic / DeepSeek 文档的停止序列上限 */
const MAX_STOP_SEQUENCES = 16

// ---------- 请求编译 ----------

const numberOr = (value: unknown, fallback: number): number => readNumber(value) ?? fallback

const toNumberRecord = (value: Record<string, unknown>): Record<string, number> | undefined => {
  const entries: [string, number][] = []
  for (const [key, item] of Object.entries(value)) {
    const number = readNumber(item)
    if (number !== undefined) {
      entries.push([key, number])
    }
  }
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

/**
 * Anthropic usage → 统一用量（规格 §6.7）：
 * input_tokens 不含缓存命中，cache 两项单列；message_delta 的 output_tokens 是累计值。
 * previous 传入 message_start 的输入侧用量，用于补齐 message_delta 里缺失的输入字段。
 */
export const normalizeAnthropicUsage = (
  raw: Record<string, unknown>,
  previous?: ProviderUsage
): ProviderUsage => {
  const input = numberOr(raw.input_tokens, previous?.inputTokens ?? 0)
  const cacheRead = numberOr(raw.cache_read_input_tokens, previous?.cacheReadTokens ?? 0)
  const cacheWrite = numberOr(raw.cache_creation_input_tokens, previous?.cacheWriteTokens ?? 0)
  const output = numberOr(raw.output_tokens, previous?.outputTokens ?? 0)
  const serverToolUse = isRecord(raw.server_tool_use)
    ? toNumberRecord(raw.server_tool_use)
    : previous?.serverToolUse
  return {
    inputTokens: input,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    outputTokens: output,
    ...(serverToolUse === undefined ? {} : { serverToolUse }),
    totalTokens: input + cacheRead + cacheWrite + output,
  }
}

const toAssistantWireContent = (
  blocks: CanonicalAssistantBlock[],
  warnings: string[]
): Record<string, unknown>[] => {
  const content: Record<string, unknown>[] = []
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        if (block.text !== '') {
          content.push({ type: 'text', text: block.text })
        }
        break
      case 'thinking':
        // 没有签名的思考块跨轮次不可回放（历史轮次也会被服务端丢弃），只回传带签名的
        if (block.signature) {
          content.push({ type: 'thinking', thinking: block.text, signature: block.signature })
        }
        break
      case 'tool_use':
        content.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input })
        break
      case 'tool_result':
        // tool_result 必须出现在 user 消息里（见 compileAnthropicRequest 的 user 分支）；
        // assistant 消息携带它属于内部表示的兼容写法，这里忽略而不是发到错误位置。
        warnings.push('Anthropic 适配层忽略 assistant 消息内的 tool_result（应位于 user 消息）')
        break
      case 'provider_block':
        if (block.protocol !== PROTOCOL) {
          warnings.push(`provider_block 来自 ${block.protocol}，跨协议不回传，已忽略`)
        } else if (isRecord(block.payload)) {
          content.push(block.payload)
        }
        break
    }
  }
  return content
}

/**
 * 编译 Anthropic Messages 请求体。
 * reminderRole='system' 时 reminder 降级并入顶层 system；默认保留 DeepSeek 的 latest_reminder 角色。
 */
export const compileAnthropicRequest = (
  profile: ProviderProfile,
  req: CanonicalRequest
): CompiledRequest => {
  const capabilities = resolveCapabilities(profile)
  const warnings: string[] = []
  const model = req.model || profile.model
  if (!model) {
    throw providerConfigError('model 不能为空')
  }

  const maxTokens =
    req.maxOutputTokens ?? profile.defaultMaxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS
  assertIntegerAtLeast('maxOutputTokens', maxTokens, 1)
  assertNumberInRange('temperature', req.temperature, 0, capabilities.sampling.temperatureMax)
  assertNumberInRange('topP', req.topP, 0, 1)
  let topK: number | undefined
  if (req.topK !== undefined) {
    if (capabilities.sampling.topK) {
      topK = assertIntegerAtLeast('topK', req.topK, 1)
    } else {
      warnings.push('Anthropic 协议默认不支持 topK，已忽略')
    }
  }
  if (req.seed !== undefined && !capabilities.sampling.seed) {
    warnings.push('Anthropic 协议不支持 seed，已忽略')
  }
  if (
    (req.presencePenalty !== undefined || req.frequencyPenalty !== undefined) &&
    !capabilities.sampling.penalties
  ) {
    warnings.push('Anthropic 协议不支持 penalties，已忽略')
  }

  let thinking: Record<string, unknown> | undefined
  if (req.thinking) {
    if (req.thinking.enabled) {
      const budget =
        req.thinking.budgetTokens ??
        Math.min(DEFAULT_THINKING_BUDGET, Math.max(1024, Math.floor(maxTokens / 2)))
      assertIntegerAtLeast('thinking.budgetTokens', budget, 1024)
      if (budget >= maxTokens) {
        throw providerConfigError(
          `thinking.budgetTokens 必须小于 maxOutputTokens（${budget} >= ${maxTokens}）`
        )
      }
      thinking = { type: 'enabled', budget_tokens: budget }
    } else {
      thinking = { type: 'disabled' }
    }
  }
  // 开启思考时部分模型拒收采样参数（规格 §6.4「置 1 或省略」）；这里选择省略并告警
  const temperature = req.thinking?.enabled ? undefined : req.temperature
  if (req.thinking?.enabled && req.temperature !== undefined) {
    warnings.push('开启思考时 Anthropic 不接受 temperature，已省略')
  }

  const stopSequences = readStopSequences('stop', req.stop, MAX_STOP_SEQUENCES, warnings)

  // system 独立字段；messages 只保留 user / assistant（以及 DeepSeek 的 latest_reminder）
  const systemParts: string[] = []
  if (req.system?.trim()) {
    systemParts.push(req.system)
  }
  const reminderRole = profile.reminderRole ?? 'latest_reminder'
  const messages: Record<string, unknown>[] = []
  for (const message of req.messages) {
    switch (message.role) {
      case 'system':
        if (message.content.trim()) {
          systemParts.push(message.content)
        }
        break
      case 'reminder':
        if (reminderRole === 'system') {
          // 官方 Anthropic 不接受 latest_reminder 角色：降级并入 system（位置信息丢失，P0 可接受）
          systemParts.push(message.content)
        } else {
          messages.push({ role: 'latest_reminder', content: message.content })
        }
        break
      case 'user': {
        if (message.files?.length) {
          warnings.push(`P0 适配层不发送附件，已忽略 ${message.files.length} 个文件块`)
        }
        const toolResults = message.toolResults ?? []
        if (toolResults.length === 0) {
          messages.push({ role: 'user', content: message.content })
          break
        }
        // 客户端工具结果：正文在前，tool_result 块在后（Anthropic 要求 tool_result 在 user 消息内）
        const content: Record<string, unknown>[] = []
        if (message.content) {
          content.push({ type: 'text', text: message.content })
        }
        for (const result of toolResults) {
          content.push({
            type: 'tool_result',
            tool_use_id: result.toolUseId,
            content: result.content,
            ...(result.isError ? { is_error: true } : {}),
          })
        }
        messages.push({ role: 'user', content })
        break
      }
      case 'assistant': {
        const content = toAssistantWireContent(message.blocks, warnings)
        if (content.length > 0) {
          messages.push({ role: 'assistant', content })
        }
        break
      }
    }
  }
  const system = systemParts.join('\n\n')

  const body: Record<string, unknown> = {
    model,
    max_tokens: maxTokens,
    messages,
    stream: true,
  }
  if (system) {
    body.system = system
  }
  if (temperature !== undefined) {
    body.temperature = temperature
  }
  if (req.topP !== undefined) {
    body.top_p = req.topP
  }
  if (topK !== undefined) {
    body.top_k = topK
  }
  if (stopSequences) {
    body.stop_sequences = stopSequences
  }
  if (thinking) {
    body.thinking = thinking
  }
  // 客户端工具：Anthropic 用 name / description / input_schema；服务端工具不经过本适配层
  const tools = req.tools?.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }))
  if (tools && tools.length > 0) {
    body.tools = tools
    if (req.toolChoice) {
      body.tool_choice = { type: req.toolChoice }
    }
  }
  if (profile.extraBody) {
    Object.assign(body, profile.extraBody)
  }

  return {
    url: buildEndpointUrl(profile, PROTOCOL),
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      ...anthropicHeaders(profile),
    },
    body,
    warnings,
  }
}

// ---------- 流解析 ----------

/** 基础鉴权头；DeepSeek 兼容端点两种鉴权都收，默认 x-api-key，extraHeaders 可覆写 */
export const anthropicHeaders = (profile: ProviderProfile): Record<string, string> => ({
  ...(profile.apiKey ? { 'x-api-key': profile.apiKey } : {}),
  'anthropic-version': '2023-06-01',
  ...profile.extraHeaders,
})

/** stop_reason → 统一结束原因（规格 §6.6） */
export const mapAnthropicStopReason = (reason: string): FinishReason => {
  switch (reason) {
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'max_tokens'
    case 'tool_use':
      return 'tool_use'
    case 'refusal':
      return 'refusal'
    case 'stop_sequence':
      return 'stop_sequence'
    default:
      // end_turn / pause_turn / 未知值都按正常结束处理，避免 UI 多分支
      return 'end_turn'
  }
}

/** citations_delta 的 citation → 统一引用；没有 url 的形态（char_location 等）P0 忽略 */
export const toAnthropicCitation = (value: unknown): NormalizedCitation | null => {
  if (!isRecord(value)) {
    return null
  }
  const url = readString(value.url)
  if (!url) {
    return null
  }
  const citedText = readString(value.cited_text)
  return {
    url,
    title: readString(value.title) ?? null,
    ...(citedText === undefined ? {} : { citedText }),
  }
}

const isServerToolBlockType = (type: string): boolean =>
  type === 'server_tool_use' ||
  type === 'web_search_tool_result' ||
  type === 'web_fetch_tool_result'

type AnthropicBlockKind = 'text' | 'thinking' | 'tool_use' | 'provider_block'

/**
 * Anthropic SSE 状态机。index 直接用协议 index（上层按协议 index 映射到内部块序号），
 * 未知块类型只记录生命周期、不发 delta，不抛错。
 */
export class AnthropicStreamParser implements StreamParser {
  private started = false
  private readonly kinds = new Map<number, AnthropicBlockKind>()
  private readonly active = new Set<number>()
  private startUsage: ProviderUsage | undefined
  private finished = false
  terminal = false

  push(event: ServerSentEvent): Delta[] {
    if (this.terminal) {
      return []
    }
    const out: Delta[] = []
    let payload: unknown
    try {
      payload = JSON.parse(event.data)
    } catch {
      // 非 JSON 的 error 事件按流内错误处理；其他帧忽略
      return event.event === 'error' ? this.fail(out, { message: event.data }) : out
    }
    const nested = readNestedErrorPayload(payload)
    if (nested) {
      return this.fail(out, nested)
    }
    if (!isRecord(payload)) {
      return out
    }
    const type = readString(payload.type) ?? event.event
    if (type !== 'ping' && type !== 'message_start') {
      this.ensureStarted(out)
    }
    switch (type) {
      case 'message_start': {
        const message = isRecord(payload.message) ? payload.message : {}
        this.ensureStarted(out, readString(message.id), readString(message.model))
        if (isRecord(message.usage)) {
          this.startUsage = normalizeAnthropicUsage(message.usage)
          out.push({ type: 'usage', usage: this.startUsage, final: false })
        }
        break
      }
      case 'content_block_start': {
        const index = readInteger(payload.index)
        const block = payload.content_block
        if (index === undefined || index < 0 || !isRecord(block)) {
          break
        }
        const blockType = readString(block.type) ?? ''
        const kind = this.toBlockKind(blockType)
        if (!kind) {
          // 未知块：不占位、不抛错；其后续 delta 因找不到映射被忽略
          break
        }
        this.kinds.set(index, kind)
        this.active.add(index)
        out.push({ type: 'block_start', index, kind, meta: block })
        break
      }
      case 'content_block_delta': {
        const index = readInteger(payload.index)
        const kind = index === undefined ? undefined : this.kinds.get(index)
        const delta = payload.delta
        if (index === undefined || kind === undefined || !isRecord(delta)) {
          break
        }
        switch (readString(delta.type)) {
          case 'text_delta': {
            const text = readString(delta.text)
            if (kind === 'text' && text !== undefined) {
              out.push({ type: 'text', index, text })
            }
            break
          }
          case 'thinking_delta': {
            const text = readString(delta.thinking)
            if (kind === 'thinking' && text !== undefined) {
              out.push({ type: 'thinking', index, text })
            }
            break
          }
          case 'signature_delta': {
            const signature = readString(delta.signature)
            if (kind === 'thinking' && signature !== undefined) {
              out.push({ type: 'signature', index, signature })
            }
            break
          }
          case 'citations_delta': {
            const citation = toAnthropicCitation(delta.citation)
            if (kind === 'text' && citation) {
              out.push({ type: 'citation', index, citation })
            }
            break
          }
          case 'input_json_delta': {
            // 客户端工具参数分片；服务端工具（provider_block）在 block_start 已携带完整 input
            const json = readString(delta.partial_json)
            if (kind === 'tool_use' && json !== undefined) {
              out.push({ type: 'tool_call_delta', index, json })
            }
            break
          }
          default:
            break
        }
        break
      }
      case 'content_block_stop': {
        const index = readInteger(payload.index)
        if (index === undefined || !this.active.has(index)) {
          break
        }
        this.closeBlock(index, out)
        break
      }
      case 'message_delta': {
        out.push(...this.closeActiveBlocks())
        const usage = isRecord(payload.usage)
          ? normalizeAnthropicUsage(payload.usage, this.startUsage)
          : undefined
        if (usage) {
          out.push({ type: 'usage', usage, final: true })
        }
        const delta = isRecord(payload.delta) ? payload.delta : {}
        const stopReason = readString(delta.stop_reason)
        if (!this.finished && stopReason) {
          const stopSequence =
            readString(delta.stop_sequence) ?? (delta.stop_sequence === null ? null : undefined)
          out.push({
            type: 'finish',
            reason: mapAnthropicStopReason(stopReason),
            ...(stopSequence === undefined ? {} : { stopSequence }),
            raw: stopReason,
          })
          this.finished = true
        }
        break
      }
      case 'message_stop': {
        out.push(...this.closeActiveBlocks())
        if (!this.finished) {
          out.push({ type: 'finish', reason: 'end_turn', raw: 'message_stop' })
          this.finished = true
        }
        this.terminal = true
        break
      }
      case 'ping':
      default:
        break
    }
    return out
  }

  /**
   * 没有 message_stop 就 EOF：按规格 §6.5 判定断流并抛 interrupted。
   * 若 message_delta 已给出 stop_reason，finish delta 已在流里发出，上层可沿用
   * 「interrupted 且已有结束原因 → 按完成收尾」的既有行为（store.ts）。
   */
  end(): Delta[] {
    if (this.terminal) {
      return []
    }
    throw createInterruptedError(PROTOCOL)
  }

  private toBlockKind(type: string): AnthropicBlockKind | undefined {
    if (type === 'text') {
      return 'text'
    }
    if (type === 'thinking') {
      return 'thinking'
    }
    if (type === 'tool_use') {
      return 'tool_use'
    }
    if (isServerToolBlockType(type)) {
      return 'provider_block'
    }
    return undefined
  }

  private ensureStarted(out: Delta[], messageId?: string, model?: string): void {
    if (this.started) {
      return
    }
    this.started = true
    out.push({
      type: 'start',
      ...(messageId === undefined ? {} : { messageId }),
      ...(model === undefined ? {} : { model }),
    })
  }

  private closeBlock(index: number, out: Delta[]): void {
    this.active.delete(index)
    this.kinds.delete(index)
    out.push({ type: 'block_stop', index })
  }

  private closeActiveBlocks(): Delta[] {
    const out: Delta[] = []
    for (const index of this.active) {
      this.kinds.delete(index)
      out.push({ type: 'block_stop', index })
    }
    this.active.clear()
    return out
  }

  private fail(out: Delta[], parsed: ParsedProviderError): Delta[] {
    this.terminal = true
    out.push({ type: 'error', error: createStreamError(PROTOCOL, parsed) })
    return out
  }
}

export const anthropicAdapter: ProtocolAdapter = {
  protocol: PROTOCOL,
  compile: compileAnthropicRequest,
  createParser: () => new AnthropicStreamParser(),
  headers: anthropicHeaders,
}
