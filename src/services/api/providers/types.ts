/**
 * 三协议 API 适配层的统一类型（规格 §6.2）。
 *
 * 上层（store / reply / view）只依赖本文件的 ProviderProfile、CanonicalRequest 与 Delta，
 * 不出现任何 wire 协议类型；协议差异被收敛到 providers/*.ts 的编译与解析实现里。
 */

import type { ServerSentEvent } from '../sse.js'

/** wire 协议标识，命名以规格 §6.2 为准 */
export type Protocol = 'anthropic-messages' | 'openai-chat' | 'openai-responses'

/** 规格早期名称，保留别名方便调用方迁移 */
export type ApiProtocol = Protocol

// ---------- 配置 ----------

/**
 * 协议能力矩阵：请求编译与 UI 开关据此降级，禁止静默丢字段。
 * 字段含义见规格 §6.2；未描述的取值在对应协议实现里按同名语义使用。
 */
export type Capabilities = {
  /** 思考文本的形态：Anthropic 带签名、Chat 纯文本、Responses 摘要 */
  thinking: 'native-signature' | 'text-only' | 'summary-only' | 'none'
  /** 思考控制参数：thinking 块 / reasoning_effort / 两者都支持 */
  thinkingControl: 'thinking-block' | 'reasoning-effort' | 'both'
  /** 可回传的思考状态：签名 / 加密 item / 不可回传 */
  thinkingReplay: 'signature' | 'encrypted-item' | 'none'
  /** 引用形态：块级 citations_delta / 正文字符区间 / 无 */
  citations: 'block' | 'char-range' | 'none'
  /** 服务端工具块：Anthropic 原生块 / Responses tool item / 无 */
  serverTools: 'native-blocks' | 'tool-items' | 'none'
  /** 附件：厂商 Files API / 内联 base64 / 不支持 */
  files: 'files-api' | 'inline-base64' | 'none'
  /** 续写：原生 prefill / 厂商扩展 / 不支持 */
  prefill: 'native' | 'extension' | 'none'
  stopSequences: boolean
  sampling: {
    /** 协议允许的 temperature 上限 */
    temperatureMax: 1 | 2
    topK: boolean
    seed: boolean
    penalties: boolean
  }
  titleGeneration: 'provider-extension' | 'none'
  usageCacheTokens: boolean
}

/** Profile 级能力覆写：sampling 允许只写需要改的字段 */
export type CapabilityOverrides = Omit<Partial<Capabilities>, 'sampling'> & {
  sampling?: Partial<Capabilities['sampling']>
}

/** 版本段策略：auto=缺则补 /v1；never=不补（Azure、自定义）；always=强制补 */
export type VersionPathMode = 'auto' | 'never' | 'always'

/**
 * 一个可切换的 Provider 配置。baseUrl 保存用户原始输入，
 * 运行时一律经 normalizeBaseUrl() 归一化后再拼接协议路径（规格 §7）。
 */
export type ProviderProfile = {
  id: string
  label: string
  protocol: Protocol
  /** 原始输入（UI 展示与排查用），请求用归一化结果 */
  baseUrl: string
  apiKey: string
  model: string
  /** 以协议原生请求体浅合并的扩展字段（DeepSeek 的 safety_check / title / thinking 等） */
  extraBody?: Record<string, unknown>
  extraHeaders?: Record<string, string>
  versionPath?: VersionPathMode
  /** 逃生口：完整 URL 模板，占位符 {base} / {model} / {protocol} / {path}，设置后忽略默认拼接 */
  endpointTemplate?: string
  /** 显式 query（如 Azure api-version），不写进 baseUrl，避免 key 进日志 */
  query?: Record<string, string>
  capabilities?: CapabilityOverrides
  /**
   * Anthropic 专有扩展：reminder 消息映射为 DeepSeek 的 latest_reminder 角色（默认），
   * 或降级并入顶层 system（官方 Anthropic 不接受 latest_reminder 角色）。
   */
  reminderRole?: 'latest_reminder' | 'system'
  /** 协议缺省输出上限；Anthropic 的 max_tokens 必填，未给时用它兜底 */
  defaultMaxOutputTokens?: number
}

const ANTHROPIC_CAPABILITIES: Capabilities = {
  thinking: 'native-signature',
  thinkingControl: 'thinking-block',
  thinkingReplay: 'signature',
  citations: 'block',
  serverTools: 'native-blocks',
  files: 'files-api',
  prefill: 'native',
  stopSequences: true,
  sampling: { temperatureMax: 1, topK: true, seed: false, penalties: false },
  titleGeneration: 'none',
  usageCacheTokens: true,
}

const OPENAI_CHAT_CAPABILITIES: Capabilities = {
  thinking: 'text-only',
  thinkingControl: 'reasoning-effort',
  thinkingReplay: 'none',
  citations: 'none',
  serverTools: 'none',
  files: 'inline-base64',
  prefill: 'none',
  stopSequences: true,
  sampling: { temperatureMax: 2, topK: false, seed: true, penalties: true },
  titleGeneration: 'none',
  usageCacheTokens: true,
}

const OPENAI_RESPONSES_CAPABILITIES: Capabilities = {
  thinking: 'summary-only',
  thinkingControl: 'reasoning-effort',
  thinkingReplay: 'none',
  citations: 'char-range',
  serverTools: 'tool-items',
  files: 'inline-base64',
  prefill: 'none',
  stopSequences: false,
  sampling: { temperatureMax: 2, topK: false, seed: false, penalties: false },
  titleGeneration: 'none',
  usageCacheTokens: true,
}

/** 协议默认能力矩阵（规格 §6.8）；Profile 可逐项覆写 */
export const PROTOCOL_CAPABILITIES: Readonly<Record<Protocol, Capabilities>> = {
  'anthropic-messages': ANTHROPIC_CAPABILITIES,
  'openai-chat': OPENAI_CHAT_CAPABILITIES,
  'openai-responses': OPENAI_RESPONSES_CAPABILITIES,
}

/** 合并 Profile 覆写后的实际能力；sampling 逐字段合并 */
export const resolveCapabilities = (profile: ProviderProfile): Capabilities => {
  const base = PROTOCOL_CAPABILITIES[profile.protocol]
  const override = profile.capabilities
  return {
    ...base,
    ...override,
    sampling: { ...base.sampling, ...override?.sampling },
  }
}

// ---------- 归一化请求 ----------

export type CanonicalBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; dataUrl?: string; fileId?: string }
  | { type: 'document'; mimeType: string; filename: string; dataUrl?: string; fileId?: string }

/** 可回传的 assistant 块；provider_block 只在同协议回传时保留 */
export type CanonicalAssistantBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string; signature?: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: unknown }
  | { type: 'provider_block'; protocol: Protocol; payload: unknown }

/**
 * 客户端工具定义（三协议共用）：Anthropic 编译为 `{name, description, input_schema}`，
 * Chat Completions 编译为 `[{type:'function', function:{name, description, parameters}}]`，
 * Responses 编译为 `[{type:'function', name, description, parameters}]`。
 */
export type CanonicalTool = {
  name: string
  description: string
  /** 合法 JSON Schema（对象根；properties / required 等） */
  parameters: Record<string, unknown>
}

/** 工具选择策略：auto 由模型决定，none 禁止调用（各协议原生映射） */
export type CanonicalToolChoice = 'auto' | 'none'

/**
 * 客户端工具结果：必须作为独立的 user 消息回传（Anthropic 的 tool_result 块 /
 * Chat 的 tool 消息 / Responses 的 function_call_output item），不能塞进 assistant 消息。
 */
export type CanonicalToolResult = {
  toolUseId: string
  /** 工具执行结果原文；记忆工具为 runMemoryTool 返回的 JSON 字符串 */
  content: string
  /** 结构化错误（如 runMemoryTool 返回 ok:false）映射为各协议的 error 标记 */
  isError?: boolean
}

export type CanonicalMessage =
  | { role: 'user'; content: string; files?: CanonicalBlock[]; toolResults?: CanonicalToolResult[] }
  | { role: 'assistant'; blocks: CanonicalAssistantBlock[] }
  | { role: 'system'; content: string }
  /** 原 latest_reminder：插在对应 user 之前，由各协议映射或降级 */
  | { role: 'reminder'; content: string }

export type CanonicalRequest = {
  model: string
  system?: string
  messages: CanonicalMessage[]
  /** 客户端工具；为空/缺省时请求体不出现 tools 字段（记忆关闭时保持原行为） */
  tools?: CanonicalTool[]
  toolChoice?: CanonicalToolChoice
  maxOutputTokens?: number
  temperature?: number
  topP?: number
  topK?: number
  stop?: string[]
  seed?: number
  presencePenalty?: number
  frequencyPenalty?: number
  thinking?: { enabled: boolean; budgetTokens?: number; effort?: string }
  /** 适配层只处理流式请求；保留字面量约束，避免误传 false */
  stream?: true
}

// ---------- 归一化增量 ----------

export type FinishReason =
  | 'end_turn'
  | 'max_tokens'
  | 'tool_use'
  | 'refusal'
  | 'stop_sequence'
  /** 用户中止；适配层实际不发它（abort 时直接抛 AbortError），保留以对齐规格 */
  | 'stopped'
  /** 流内错误；随后不会再出现 finish */
  | 'error'
  /** 收到无法归类的 incomplete 原因：回答不完整，不能当成正常结束 */
  | 'incomplete'

export type BlockKind = 'text' | 'thinking' | 'tool_use' | 'provider_block'

export type NormalizedCitation = {
  url: string
  title: string | null
  citedText?: string
  /** Responses 的字符区间（相对当前文本块/part）；其他协议为 undefined */
  startOffset?: number
  endOffset?: number
}

/** 统一用量（规格 §6.7）：inputTokens 统一为「不含缓存命中」，对齐 Anthropic 语义 */
export type ProviderUsage = {
  inputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
  reasoningTokens?: number
  totalTokens?: number
  serverToolUse?: Record<string, number>
}

/** 规格名称别名 */
export type NormalizedUsage = ProviderUsage

export type ProviderErrorKind =
  | 'http'
  | 'stream'
  | 'network'
  | 'interrupted'
  | 'protocol'
  | 'config'

export type ProviderErrorProvider = {
  protocol: Protocol
  type?: string
  code?: string
  message: string
}

/**
 * 错误对象的结构契约。errors.ts 的 ProviderError 实现它；
 * Delta['error'] 用它而不是具体类，避免 types 与 errors 循环依赖。
 */
export type ProviderErrorLike = {
  readonly kind: ProviderErrorKind
  readonly message: string
  readonly status?: number
  readonly provider?: ProviderErrorProvider
  readonly retryAfterMs?: number
}

/**
 * 统一流式增量（规格 §6.2 / 6.3）。
 *
 * - index 由适配层分配且稳定：Anthropic 直接用协议 index，Responses 用 output_index，
 *   Chat 由适配层惰性分配；上层用 Map<wireIndex, blockIndex> 即可复用现有块生命周期。
 * - start 至多一次；finish 恰好一次；error 之后不再有 finish。
 * - usage 最多两发：Anthropic 先 final:false（输入侧）再 final:true；Chat/Responses 只发 final:true。
 */
export type Delta =
  | { type: 'start'; messageId?: string; model?: string }
  | {
      type: 'block_start'
      index: number
      kind: BlockKind
      /** 原始 wire 块（Anthropic 服务端工具块、初始 text/citations 等），上层可原样透传 */
      meta?: unknown
    }
  | { type: 'text'; index: number; text: string }
  | { type: 'thinking'; index: number; text: string }
  | { type: 'signature'; index: number; signature: string }
  | { type: 'citation'; index: number; citation: NormalizedCitation }
  /**
   * 客户端工具参数增量（Anthropic input_json_delta / Chat tool_calls.function.arguments /
   * Responses function_call_arguments.delta）：按 index 拼接到对应 tool_use 块的 input JSON，
   * 块结束时解析成完整 input。
   */
  | { type: 'tool_call_delta'; index: number; json: string }
  | { type: 'block_stop'; index: number }
  | { type: 'usage'; usage: ProviderUsage; final: boolean }
  | { type: 'finish'; reason: FinishReason; stopSequence?: string | null; raw?: string }
  | { type: 'error'; error: ProviderErrorLike }

// ---------- 客户端与适配器契约 ----------

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/** 底层流式请求选项；fetch 可注入，便于脱离网络做整链路验证 */
export type StreamRequestOptions = {
  signal: AbortSignal
  fetch?: FetchLike
}

/** 编译后的 wire 请求；warnings 不进请求体，只用于排查被降级的参数 */
export type CompiledRequest = {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
  warnings: string[]
}

/**
 * 有状态流解析器：一个响应一个实例。
 * push 返回要向上发出的 Delta；end 在 EOF（未收到终止事件）时收尾或抛 interrupted。
 */
export type StreamParser = {
  push(event: ServerSentEvent): Delta[]
  end(): Delta[]
  /** 是否已收到协议终止事件；为 true 时调用方应停止读取 */
  readonly terminal: boolean
}

export type ProtocolAdapter = {
  readonly protocol: Protocol
  compile(profile: ProviderProfile, req: CanonicalRequest): CompiledRequest
  createParser(): StreamParser
  /** 基础鉴权头（不含 Content-Type / Accept），verify 与协议请求共用 */
  headers(profile: ProviderProfile): Record<string, string>
}

/** 上层只依赖这个契约：把归一化请求变成归一化增量流 */
export type ChatClient = {
  /** 预热 / 校验：成功 resolve，失败抛 ProviderError */
  verify(signal?: AbortSignal): Promise<void>
  stream(req: CanonicalRequest, signal: AbortSignal): AsyncIterable<Delta>
}

// ---------- 通用运行时断言 ----------

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

export const readString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined

export const readNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

export const readInteger = (value: unknown): number | undefined => {
  const number = readNumber(value)
  return number !== undefined && Number.isSafeInteger(number) ? number : undefined
}

/** 工具参数 → wire JSON 字符串（Chat / Responses 都要求 arguments 是字符串） */
export const toolArgumentsJson = (input: unknown): string => {
  if (typeof input === 'string') {
    return input
  }
  try {
    return JSON.stringify(input ?? {})
  } catch {
    return '{}'
  }
}

/** 工具结果 → wire 字符串；记忆工具的结果本来就是 JSON 字符串，其他工具兜底序列化 */
export const toolResultText = (content: unknown): string => {
  if (typeof content === 'string') {
    return content
  }
  try {
    return JSON.stringify(content ?? '')
  } catch {
    return ''
  }
}

