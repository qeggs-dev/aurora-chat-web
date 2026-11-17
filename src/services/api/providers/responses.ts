/**
 * OpenAI Responses 协议适配（规格 §5、§6.4、§6.5）。
 *
 * 编译：input item 数组（message / function_call / function_call_output）、instructions、
 * max_output_tokens、reasoning.effort；统一走「无状态 + 完整 input」，store:false
 * （规格 §5.5，不依赖 previous_response_id）。
 * 解析：response.created / output_item.added / content_part.added / output_text.delta|done /
 * response.completed|incomplete|failed / error、reasoning_summary_text.delta、
 * url_citation 注解（start_index/end_index）。
 *
 * 思考是摘要（reasoning_summary_text），无 signature；引用是正文字符区间，
 * 通过 NormalizedCitation.startOffset/endOffset 交给 view 层；output_index 直接当稳定块索引。
 */

import type { ServerSentEvent } from '../sse.js'
import {
  assertIntegerAtLeast,
  assertNumberInRange,
  createInterruptedError,
  createStreamError,
  providerConfigError,
  readNestedErrorPayload,
  readResponsesStreamError,
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
  toolResultText,
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

const PROTOCOL = 'openai-responses' as const

const numberOr = (value: unknown, fallback: number): number => readNumber(value) ?? fallback

// ---------- 请求编译 ----------

const toInputTextPart = (text: string) => ({ type: 'input_text', text })

/**
 * 编译 Responses 请求体。assistant 历史：text→output_text、tool_use→function_call、
 * tool_result→function_call_output；thinking 与跨协议 provider_block 丢弃。
 */
export const compileResponsesRequest = (
  profile: ProviderProfile,
  req: CanonicalRequest
): CompiledRequest => {
  const capabilities = resolveCapabilities(profile)
  const warnings: string[] = []
  const model = req.model || profile.model
  if (!model) {
    throw providerConfigError('model 不能为空')
  }
  if (req.maxOutputTokens !== undefined) {
    assertIntegerAtLeast('maxOutputTokens', req.maxOutputTokens, 1)
  }
  assertNumberInRange('temperature', req.temperature, 0, capabilities.sampling.temperatureMax)
  assertNumberInRange('topP', req.topP, 0, 1)

  if (req.topK !== undefined) {
    warnings.push('Responses 不支持 topK，已忽略')
  }
  if (req.stop !== undefined) {
    warnings.push('Responses 不支持 stop 序列，已忽略')
  }
  if (req.seed !== undefined) {
    warnings.push('Responses 不支持 seed，已忽略')
  }
  if (req.presencePenalty !== undefined || req.frequencyPenalty !== undefined) {
    warnings.push('Responses 不支持 penalties，已忽略')
  }

  const instructionParts: string[] = []
  if (req.system?.trim()) {
    instructionParts.push(req.system)
  }

  const input: Record<string, unknown>[] = []
  const flushAssistantMessage = (parts: Record<string, unknown>[]): void => {
    if (parts.length > 0) {
      // 必须复制：后续 tool_use / tool_result 会继续复用 parts 数组
      input.push({ type: 'message', role: 'assistant', content: [...parts] })
      parts.length = 0
    }
  }
  for (const message of req.messages) {
    switch (message.role) {
      case 'system':
        if (message.content.trim()) {
          instructionParts.push(message.content)
        }
        break
      case 'reminder':
        // 官方 Responses 没有 reminder 角色：降级为同位置 developer 消息
        input.push({
          type: 'message',
          role: 'developer',
          content: [toInputTextPart(message.content)],
        })
        break
      case 'user': {
        if (message.files?.length) {
          warnings.push(`P0 适配层不发送附件，已忽略 ${message.files.length} 个文件块`)
        }
        const toolResults = message.toolResults ?? []
        if (toolResults.length === 0) {
          input.push({
            type: 'message',
            role: 'user',
            content: [toInputTextPart(message.content)],
          })
          break
        }
        // 工具结果作为 function_call_output item 紧跟对应的 function_call；
        // 有正文时再补一条 user 消息（工具结果与正文不属于同一个 input item）。
        if (message.content.trim()) {
          input.push({
            type: 'message',
            role: 'user',
            content: [toInputTextPart(message.content)],
          })
        }
        for (const result of toolResults) {
          input.push({
            type: 'function_call_output',
            call_id: result.toolUseId,
            output: result.content,
          })
        }
        break
      }
      case 'assistant': {
        const parts: Record<string, unknown>[] = []
        for (const block of message.blocks) {
          switch (block.type) {
            case 'text':
              if (block.text !== '') {
                parts.push({ type: 'output_text', text: block.text })
              }
              break
            case 'tool_use':
              flushAssistantMessage(parts)
              input.push({
                type: 'function_call',
                call_id: block.id,
                name: block.name,
                arguments: toolArgumentsJson(block.input),
              })
              break
            case 'tool_result':
              flushAssistantMessage(parts)
              input.push({
                type: 'function_call_output',
                call_id: block.toolUseId,
                output: toolResultText(block.content),
              })
              break
            case 'thinking':
              // 思考 item 需要 encrypted_content 才能跨请求保留，统一模型默认只展示不回传
              break
            case 'provider_block':
              if (block.protocol === PROTOCOL && isRecord(block.payload)) {
                flushAssistantMessage(parts)
                input.push(block.payload)
              } else if (block.protocol !== PROTOCOL) {
                warnings.push(`provider_block 来自 ${block.protocol}，跨协议不回传，已忽略`)
              }
              break
          }
        }
        flushAssistantMessage(parts)
        break
      }
    }
  }

  const instructions = instructionParts.join('\n\n')
  const body: Record<string, unknown> = {
    model,
    input,
    stream: true,
    // 无状态：不依赖服务端保存响应（规格 §5.5）
    store: false,
  }
  if (instructions) {
    body.instructions = instructions
  }
  if (req.maxOutputTokens !== undefined) {
    body.max_output_tokens = req.maxOutputTokens
  }
  if (req.temperature !== undefined) {
    body.temperature = req.temperature
  }
  if (req.topP !== undefined) {
    body.top_p = req.topP
  }
  if (req.thinking?.enabled) {
    body.reasoning = { effort: req.thinking.effort ?? 'medium' }
  }
  // 客户端工具：Responses 用 [{type:'function', name, description, parameters}]
  const tools = req.tools?.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
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
      ...responsesHeaders(profile),
    },
    body,
    warnings,
  }
}

/** Responses 与 Chat 同为 Bearer 鉴权 */
export const responsesHeaders = (profile: ProviderProfile): Record<string, string> => ({
  ...(profile.apiKey ? { authorization: `Bearer ${profile.apiKey}` } : {}),
  ...profile.extraHeaders,
})

// ---------- usage / 引用 ----------

/** Responses usage → 统一用量（规格 §6.7）：input_tokens 含缓存命中，需减去 cached_tokens */
export const normalizeResponsesUsage = (raw: Record<string, unknown>): ProviderUsage => {
  const input = numberOr(raw.input_tokens, 0)
  const inputDetails = isRecord(raw.input_tokens_details) ? raw.input_tokens_details : {}
  const cached = numberOr(inputDetails.cached_tokens, 0)
  const output = numberOr(raw.output_tokens, 0)
  const outputDetails = isRecord(raw.output_tokens_details) ? raw.output_tokens_details : {}
  const reasoning = readNumber(outputDetails.reasoning_tokens)
  const total = readNumber(raw.total_tokens)
  return {
    inputTokens: Math.max(0, input - cached),
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
    outputTokens: output,
    ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
    ...(total === undefined ? {} : { totalTokens: total }),
  }
}

/** url_citation 注解：start_index / end_index 相对该 output_text part 的正文 */
export const toResponsesCitation = (value: unknown): NormalizedCitation | null => {
  if (!isRecord(value) || value.type !== 'url_citation') {
    return null
  }
  const url = readString(value.url)
  if (!url) {
    return null
  }
  const startOffset = readInteger(value.start_index)
  const endOffset = readInteger(value.end_index)
  return {
    url,
    title: readString(value.title) ?? null,
    ...(startOffset === undefined ? {} : { startOffset }),
    ...(endOffset === undefined ? {} : { endOffset }),
  }
}

const mapIncompleteReason = (reason: string | undefined): FinishReason => {
  switch (reason) {
    case 'max_output_tokens':
      return 'max_tokens'
    case 'content_filter':
      return 'refusal'
    default:
      return 'end_turn'
  }
}

// ---------- 流解析 ----------

type ResponsesBlockKind = 'text' | 'thinking' | 'tool_use'

/**
 * Responses 语义化 SSE 状态机。output_index 直接作为稳定块索引：
 * reasoning item → thinking 块，message item → text 块；引用按字符区间下发。
 */
export class ResponsesStreamParser implements StreamParser {
  private started = false
  private readonly kinds = new Map<number, ResponsesBlockKind>()
  private readonly active = new Set<number>()
  private finished = false
  terminal = false

  push(event: ServerSentEvent): Delta[] {
    if (this.terminal) {
      return []
    }
    let payload: unknown
    try {
      payload = JSON.parse(event.data)
    } catch {
      return []
    }
    const nested = readNestedErrorPayload(payload)
    if (nested) {
      return this.fail(nested)
    }
    const streamError = readResponsesStreamError(payload)
    if (streamError) {
      return this.fail(streamError)
    }
    if (!isRecord(payload)) {
      return []
    }
    const out: Delta[] = []
    const type = readString(payload.type) ?? event.event
    switch (type) {
      case 'response.created': {
        const response = isRecord(payload.response) ? payload.response : {}
        this.ensureStarted(out, readString(response.id), readString(response.model))
        break
      }
      case 'response.in_progress':
        this.ensureStarted(out)
        break
      case 'response.output_item.added': {
        const index = readInteger(payload.output_index)
        const item = payload.item
        if (index === undefined || !isRecord(item)) {
          break
        }
        if (item.type === 'function_call') {
          // 客户端工具调用：块索引用 output_index，meta 带 call_id / name（上层落成 tool_use 块）
          const id = readString(item.call_id) ?? readString(item.id) ?? ''
          const name = readString(item.name) ?? ''
          this.ensureBlock(index, 'tool_use', out, { id, name })
          break
        }
        const kind =
          item.type === 'reasoning' ? 'thinking' : item.type === 'message' ? 'text' : undefined
        // web_search_call 等服务端工具 item P0 不消费，忽略其生命周期
        if (kind) {
          this.ensureBlock(index, kind, out, item)
        }
        break
      }
      case 'response.function_call_arguments.delta': {
        const index = readInteger(payload.output_index)
        const json = readString(payload.delta)
        if (index !== undefined && json !== undefined) {
          this.ensureBlock(index, 'tool_use', out)
          out.push({ type: 'tool_call_delta', index, json })
        }
        break
      }
      case 'response.content_part.added': {
        const index = readInteger(payload.output_index)
        const part = payload.part
        if (index === undefined || !isRecord(part)) {
          break
        }
        // output_text / refusal 都归到正文块
        if (part.type === 'output_text' || part.type === 'refusal') {
          this.ensureBlock(index, 'text', out, part)
        }
        break
      }
      case 'response.output_text.delta':
      case 'response.refusal.delta': {
        const index = readInteger(payload.output_index)
        const text = readString(payload.delta)
        if (index !== undefined && text !== undefined) {
          this.ensureBlock(index, 'text', out)
          out.push({ type: 'text', index, text })
        }
        break
      }
      case 'response.reasoning_summary_text.delta': {
        const index = readInteger(payload.output_index)
        const text = readString(payload.delta)
        if (index !== undefined && text !== undefined) {
          this.ensureBlock(index, 'thinking', out)
          out.push({ type: 'thinking', index, text })
        }
        break
      }
      case 'response.output_text.annotation.added': {
        const index = readInteger(payload.output_index)
        const citation = toResponsesCitation(payload.annotation)
        if (index !== undefined && citation) {
          this.ensureBlock(index, 'text', out)
          out.push({ type: 'citation', index, citation })
        }
        break
      }
      case 'response.output_item.done': {
        const index = readInteger(payload.output_index)
        if (index !== undefined) {
          this.closeBlock(index, out)
        }
        break
      }
      case 'response.completed': {
        const response = isRecord(payload.response) ? payload.response : undefined
        this.finishWithResponse(out, response)
        break
      }
      case 'response.incomplete': {
        const response = isRecord(payload.response) ? payload.response : undefined
        const reason =
          response && isRecord(response.incomplete_details)
            ? readString(response.incomplete_details.reason)
            : undefined
        this.finishWithResponse(out, response, mapIncompleteReason(reason), reason)
        break
      }
      case 'response.failed': {
        const error = readResponsesStreamError({
          type: 'response.failed',
          response: payload.response,
        })
        return this.fail(error ?? { message: 'response failed' })
      }
      case 'error': {
        const error = readResponsesStreamError(payload)
        return this.fail(error ?? { message: 'stream error' })
      }
      case 'response.output_text.done':
      case 'response.reasoning_summary_text.done':
      case 'response.reasoning_summary_part.added':
      case 'response.reasoning_summary_part.done':
      case 'response.content_part.done':
      default:
        // 已完成内容不做二次累加；未知事件忽略
        this.ensureStarted(out)
        break
    }
    return out
  }

  /** 没有 response.completed / incomplete 就 EOF：按规格判定断流 */
  end(): Delta[] {
    if (this.terminal) {
      return []
    }
    throw createInterruptedError(PROTOCOL)
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

  private ensureBlock(index: number, kind: ResponsesBlockKind, out: Delta[], meta?: unknown): void {
    if (this.kinds.has(index)) {
      return
    }
    this.kinds.set(index, kind)
    this.active.add(index)
    out.push({ type: 'block_start', index, kind, ...(meta === undefined ? {} : { meta }) })
  }

  private closeBlock(index: number, out: Delta[]): void {
    if (!this.active.has(index)) {
      return
    }
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

  private finishWithResponse(
    out: Delta[],
    response: Record<string, unknown> | undefined,
    reason?: FinishReason,
    rawReason?: string
  ): void {
    out.push(...this.closeActiveBlocks())
    if (response && isRecord(response.usage)) {
      out.push({ type: 'usage', usage: normalizeResponsesUsage(response.usage), final: true })
    }
    if (!this.finished) {
      out.push({
        type: 'finish',
        reason: reason ?? this.finishReasonFromOutput(response),
        ...(rawReason === undefined ? {} : { raw: rawReason }),
      })
      this.finished = true
    }
    this.terminal = true
  }

  private finishReasonFromOutput(response: Record<string, unknown> | undefined): FinishReason {
    const output = response && Array.isArray(response.output) ? response.output : []
    for (const item of output) {
      if (!isRecord(item)) {
        continue
      }
      if (item.type === 'function_call') {
        return 'tool_use'
      }
      if (
        item.type === 'message' &&
        Array.isArray(item.content) &&
        item.content.some((part) => isRecord(part) && part.type === 'refusal')
      ) {
        return 'refusal'
      }
    }
    return 'end_turn'
  }

  private fail(parsed: ParsedProviderError): Delta[] {
    this.terminal = true
    return [{ type: 'error', error: createStreamError(PROTOCOL, parsed) }]
  }

  /** 最近一次终止事件名（排查用） */
  raw: string | undefined
}

export const responsesAdapter: ProtocolAdapter = {
  protocol: PROTOCOL,
  compile: compileResponsesRequest,
  createParser: () => new ResponsesStreamParser(),
  headers: responsesHeaders,
}
