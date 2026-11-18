/**
 * OpenAI Chat Completions 协议适配（规格 §3、§6.4、§6.5）。
 *
 * 编译：system 进 messages、max_completion_tokens、stop（≤4）、penalties、seed、
 * stream_options.include_usage；采样/停止等参数按 capabilities 降级并记 warnings。
 * 解析：data: [DONE]、choices[].delta.content / reasoning_content、finish_reason、usage
 * （兼容「独立空 choices 的 usage 块」与「附在最后内容块」两种变体）。
 *
 * Chat 没有块概念：适配层在首个 reasoning_content 惰性开 thinking 块、首个 content
 * 开 text 块，切换时自动 block_stop；思考块没有 signature（规格 §6.3）。
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
  toolArgumentsJson,
  type CanonicalAssistantBlock,
  type CanonicalRequest,
  type CompiledRequest,
  type Delta,
  type FinishReason,
  type ProtocolAdapter,
  type ProviderProfile,
  type ProviderUsage,
  type StreamParser,
} from './types.js'

const PROTOCOL = 'openai-chat' as const

/** OpenAI 文档的 stop 上限；DeepSeek 支持更多，按最保守的 4 处理 */
const MAX_STOP_SEQUENCES = 4

const numberOr = (value: unknown, fallback: number): number => readNumber(value) ?? fallback

// ---------- 请求编译 ----------

/** assistant 正文：只有文本块进入 content；思考 / provider_block 不回传 */
const toAssistantContent = (blocks: CanonicalAssistantBlock[]): string =>
  blocks.map((block) => (block.type === 'text' ? block.text : '')).join('')

/** assistant 工具调用：tool_use → tool_calls[{id,type:'function',function:{name,arguments}}] */
const toAssistantToolCalls = (blocks: CanonicalAssistantBlock[]): Record<string, unknown>[] =>
  blocks.flatMap((block) =>
    block.type === 'tool_use'
      ? [
          {
            id: block.id,
            type: 'function',
            function: { name: block.name, arguments: toolArgumentsJson(block.input) },
          },
        ]
      : []
  )

/**
 * 编译 Chat Completions 请求体。
 * 思考块丢弃（reasoning_content 不进入上下文）；tool_use / provider_block P0 不消费。
 */
export const compileOpenAIChatRequest = (
  profile: ProviderProfile,
  req: CanonicalRequest
): CompiledRequest => {
  const capabilities = resolveCapabilities(profile)
  const warnings: string[] = []
  const model = req.model || profile.model
  if (!model) {
    throw providerConfigError('model 不能为空')
  }
  assertIntegerAtLeast('maxOutputTokens', req.maxOutputTokens, 1)
  assertNumberInRange('temperature', req.temperature, 0, capabilities.sampling.temperatureMax)
  assertNumberInRange('topP', req.topP, 0, 1)
  assertNumberInRange('presencePenalty', req.presencePenalty, -2, 2)
  assertNumberInRange('frequencyPenalty', req.frequencyPenalty, -2, 2)

  if (req.topK !== undefined) {
    warnings.push('Chat Completions 不支持 topK，已忽略')
  }
  const stop = readStopSequences('stop', req.stop, MAX_STOP_SEQUENCES, warnings)

  const messages: Record<string, unknown>[] = []
  // system 进 messages：顶部 system 放在最前，reminder 降级为同位置 system 消息
  if (req.system?.trim()) {
    messages.push({ role: 'system', content: req.system })
  }
  for (const message of req.messages) {
    switch (message.role) {
      case 'system':
        messages.push({ role: 'system', content: message.content })
        break
      case 'reminder':
        // latest_reminder 是 DeepSeek 私有角色，Chat 降级为同位置 system 消息
        messages.push({ role: 'system', content: message.content })
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
        // 工具结果必须是独立的 tool 消息，且紧跟在 assistant 的 tool_calls 之后；
        // 只有存在正文时（例如等待工具结果期间用户又补充了问题）才再发一条 user 消息。
        if (message.content.trim()) {
          messages.push({ role: 'user', content: message.content })
        }
        for (const result of toolResults) {
          messages.push({
            role: 'tool',
            tool_call_id: result.toolUseId,
            content: result.content,
          })
        }
        break
      }
      case 'assistant': {
        // 思考 / provider 块不回传；正文进 content，客户端工具调用进 tool_calls
        const content = toAssistantContent(message.blocks)
        const toolCalls = toAssistantToolCalls(message.blocks)
        if (toolCalls.length > 0) {
          messages.push({ role: 'assistant', content: content === '' ? null : content, tool_calls: toolCalls })
        } else if (content !== '') {
          messages.push({ role: 'assistant', content })
        }
        break
      }
    }
  }

  const body: Record<string, unknown> = {
    model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  }
  if (req.maxOutputTokens !== undefined) {
    body.max_completion_tokens = req.maxOutputTokens
  }
  if (req.temperature !== undefined) {
    body.temperature = req.temperature
  }
  if (req.topP !== undefined) {
    body.top_p = req.topP
  }
  if (stop) {
    body.stop = stop
  }
  if (req.presencePenalty !== undefined && capabilities.sampling.penalties) {
    body.presence_penalty = req.presencePenalty
  }
  if (req.frequencyPenalty !== undefined && capabilities.sampling.penalties) {
    body.frequency_penalty = req.frequencyPenalty
  }
  if (
    (req.presencePenalty !== undefined || req.frequencyPenalty !== undefined) &&
    !capabilities.sampling.penalties
  ) {
    warnings.push('Chat Completions 不支持 penalties，已忽略')
  }
  if (req.seed !== undefined) {
    if (!Number.isSafeInteger(req.seed)) {
      throw providerConfigError('seed 必须是整数')
    }
    if (capabilities.sampling.seed) {
      body.seed = req.seed
    } else {
      warnings.push('Chat Completions 不支持 seed，已忽略')
    }
  }
  // 开启思考：Chat 用 reasoning_effort（模型相关）；DeepSeek 的 thinking.type 由 extraBody 提供
  if (req.thinking?.enabled && req.thinking.effort !== undefined) {
    body.reasoning_effort = req.thinking.effort
  }
  // 客户端工具：Chat 用 [{type:'function', function:{name, description, parameters}}]
  const tools = req.tools?.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }))
  if (tools && tools.length > 0) {
    body.tools = tools
    if (req.toolChoice) {
      body.tool_choice = req.toolChoice
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
      ...openAIChatHeaders(profile),
    },
    body,
    warnings,
  }
}

/** Chat / Responses 共用 Bearer 鉴权头 */
export const openAIChatHeaders = (profile: ProviderProfile): Record<string, string> => ({
  ...(profile.apiKey ? { authorization: `Bearer ${profile.apiKey}` } : {}),
  ...profile.extraHeaders,
})

// ---------- usage / 结束原因 ----------

/**
 * Chat usage → 统一用量（规格 §6.7）：
 * prompt_tokens 含缓存命中，inputTokens 要减去 cached_tokens；DeepSeek 用
 * prompt_cache_hit_tokens 表达同一含义，一并兼容。
 */
export const normalizeChatUsage = (raw: Record<string, unknown>): ProviderUsage => {
  const prompt = numberOr(raw.prompt_tokens, 0)
  const promptDetails = isRecord(raw.prompt_tokens_details) ? raw.prompt_tokens_details : {}
  const cached =
    readNumber(promptDetails.cached_tokens) ?? readNumber(raw.prompt_cache_hit_tokens) ?? 0
  const completion = numberOr(raw.completion_tokens, 0)
  const completionDetails = isRecord(raw.completion_tokens_details)
    ? raw.completion_tokens_details
    : {}
  const reasoning = readNumber(completionDetails.reasoning_tokens)
  const total = readNumber(raw.total_tokens)
  return {
    inputTokens: Math.max(0, prompt - cached),
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
    outputTokens: completion,
    ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
    ...(total === undefined ? {} : { totalTokens: total }),
  }
}

/** finish_reason → 统一结束原因（规格 §6.6） */
export const mapChatFinishReason = (reason: string): FinishReason => {
  switch (reason) {
    case 'length':
      return 'max_tokens'
    case 'tool_calls':
    case 'function_call':
      return 'tool_use'
    case 'content_filter':
      return 'refusal'
    case 'stop':
      return 'end_turn'
    default:
      // DeepSeek 的 insufficient_system_resource / aborted 等异常值按 error 收尾
      return 'error'
  }
}

// ---------- 流解析 ----------

type ChatBlockKind = 'text' | 'thinking'

/** reasoning 字段名在网关间不统一：DeepSeek/vLLM 用 reasoning_content，OpenRouter 用 reasoning */
const readReasoning = (delta: Record<string, unknown>): string | undefined =>
  readString(delta.reasoning_content) ?? readString(delta.reasoning)

/**
 * Chat SSE 状态机。chunk 没有块概念，索引由适配层分配：
 * thinking 与 text 各自惰性开块，kind 切换时自动 block_stop（保证上层块生命周期完整）。
 */
export class OpenAIChatStreamParser implements StreamParser {
  private started = false
  private nextIndex = 0
  private active: { index: number; kind: ChatBlockKind } | null = null
  /** tool_call.index（wire）→ 适配层分配的块 index */
  private readonly toolBlocks = new Map<number, number>()
  /**
   * 参数 / 名称可能分片到达：先攒在 wire index 上，name 齐了才开块。
   * 已开块的 arguments 分片直接转 tool_call_delta。
   */
  private readonly pendingToolCalls = new Map<number, { id: string; name: string; args: string }>()
  private finished = false
  terminal = false

  push(event: ServerSentEvent): Delta[] {
    if (this.terminal) {
      return []
    }
    const data = event.data.trim()
    if (data === '[DONE]') {
      this.terminal = true
      // 部分网关不发 finish_reason：已开出工具块说明本轮是工具调用，按 tool_use 收尾
      const sawToolCalls = this.toolBlocks.size > 0
      const out = this.closeAll()
      if (!this.finished) {
        out.push({
          type: 'finish',
          reason: sawToolCalls ? 'tool_use' : 'end_turn',
          raw: '[DONE]',
        })
        this.finished = true
      }
      return out
    }

    let payload: unknown
    try {
      payload = JSON.parse(data)
    } catch {
      return []
    }
    const nested = readNestedErrorPayload(payload)
    if (nested) {
      return this.fail(nested)
    }
    if (!isRecord(payload)) {
      return []
    }

    const out: Delta[] = []
    this.ensureStarted(out, payload)
    const choices = Array.isArray(payload.choices) ? payload.choices : []
    for (const choice of choices) {
      if (!isRecord(choice)) {
        continue
      }
      // P0 只消费单条回答（index 0）
      if ((readInteger(choice.index) ?? 0) !== 0) {
        continue
      }
      const delta = isRecord(choice.delta) ? choice.delta : {}
      const reasoning = readReasoning(delta)
      if (reasoning) {
        out.push({ type: 'thinking', index: this.openBlock(out, 'thinking'), text: reasoning })
      }
      const content = readString(delta.content)
      if (content) {
        out.push({ type: 'text', index: this.openBlock(out, 'text'), text: content })
      }
      const refusal = readString(delta.refusal)
      if (refusal) {
        // P0 把拒答文本当正文，避免上层出现新的块类型
        out.push({ type: 'text', index: this.openBlock(out, 'text'), text: refusal })
      }
      // 客户端工具调用：同一响应内可有多个 tool_call，按 wire index 各自开块；
      // 参数分片用 tool_call_delta 累积，由上层解析成完整 input。
      const toolCalls = Array.isArray(delta.tool_calls)
        ? delta.tool_calls
        : // 旧版单函数调用字段（function_call）按 index 0 处理
          isRecord(delta.function_call)
          ? [{ index: 0, function: delta.function_call }]
          : []
      for (const item of toolCalls) {
        if (!isRecord(item)) {
          continue
        }
        this.pushToolCall(out, item)
      }

      const finishReason = readString(choice.finish_reason)
      if (finishReason && !this.finished) {
        out.push(...this.closeAll())
        out.push({ type: 'finish', reason: mapChatFinishReason(finishReason), raw: finishReason })
        this.finished = true
      }
    }

    // usage 可能来自独立空 choices 块（OpenAI include_usage），也可能附在最后内容块（DeepSeek）
    if (isRecord(payload.usage)) {
      out.push({ type: 'usage', usage: normalizeChatUsage(payload.usage), final: true })
    }
    return out
  }

  /**
   * 没有 [DONE] 就 EOF：已收到 finish_reason 视为正常结束（部分网关不发 [DONE]）；
   * 连 finish_reason 都没有则按规格判定断流。
   */
  end(): Delta[] {
    if (this.terminal || this.finished) {
      return []
    }
    throw createInterruptedError(PROTOCOL)
  }

  private openBlock(out: Delta[], kind: ChatBlockKind): number {
    if (this.active?.kind === kind) {
      return this.active.index
    }
    if (this.active) {
      out.push({ type: 'block_stop', index: this.active.index })
      this.active = null
    }
    const index = this.nextIndex++
    this.active = { index, kind }
    out.push({ type: 'block_start', index, kind })
    return index
  }

  private closeActive(): Delta[] {
    const active = this.active
    if (!active) {
      return []
    }
    this.active = null
    return [{ type: 'block_stop', index: active.index }]
  }

  /** 结束本次回答的所有块：正文 / 思考 + 全部工具调用块（按开块顺序） */
  private closeAll(): Delta[] {
    const out = this.closeActive()
    for (const index of this.toolBlocks.values()) {
      out.push({ type: 'block_stop', index })
    }
    this.toolBlocks.clear()
    this.pendingToolCalls.clear()
    return out
  }

  /**
   * 处理一个 tool_calls 分片：name 齐了才开块（部分网关先发 arguments），
   * 之后参数分片以 tool_call_delta 发出；块结束时由上层解析成完整 input。
   */
  private pushToolCall(out: Delta[], call: Record<string, unknown>): void {
    const callIndex = readInteger(call.index) ?? 0
    const fn = isRecord(call.function) ? call.function : {}
    const pending = this.pendingToolCalls.get(callIndex) ?? { id: '', name: '', args: '' }
    const id = readString(call.id)
    const name = readString(fn.name)
    const args = readString(fn.arguments)
    if (id) {
      pending.id = id
    }
    if (name) {
      pending.name = name
    }
    if (args) {
      pending.args += args
    }
    this.pendingToolCalls.set(callIndex, pending)

    const existing = this.toolBlocks.get(callIndex)
    if (existing === undefined) {
      if (pending.name === '') {
        // 名称还没到：先攒参数，等名称到了再开块
        return
      }
      const index = this.openToolBlock(out, pending.id, pending.name)
      this.toolBlocks.set(callIndex, index)
      if (pending.args) {
        out.push({ type: 'tool_call_delta', index, json: pending.args })
      }
      return
    }
    if (args) {
      out.push({ type: 'tool_call_delta', index: existing, json: args })
    }
  }

  private openToolBlock(out: Delta[], id: string, name: string): number {
    // 正文 / 思考块与工具调用不共存：出现工具调用前先结束它们
    if (this.active) {
      out.push({ type: 'block_stop', index: this.active.index })
      this.active = null
    }
    const index = this.nextIndex++
    out.push({ type: 'block_start', index, kind: 'tool_use', meta: { id, name } })
    return index
  }

  private ensureStarted(out: Delta[], payload: Record<string, unknown>): void {
    if (this.started) {
      return
    }
    this.started = true
    const messageId = readString(payload.id)
    const model = readString(payload.model)
    out.push({
      type: 'start',
      ...(messageId === undefined ? {} : { messageId }),
      ...(model === undefined ? {} : { model }),
    })
  }

  private fail(parsed: ParsedProviderError): Delta[] {
    this.terminal = true
    return [{ type: 'error', error: createStreamError(PROTOCOL, parsed) }]
  }
}

export const openAIChatAdapter: ProtocolAdapter = {
  protocol: PROTOCOL,
  compile: compileOpenAIChatRequest,
  createParser: () => new OpenAIChatStreamParser(),
  headers: openAIChatHeaders,
}
