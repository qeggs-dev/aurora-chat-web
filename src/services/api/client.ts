import { translate, type TranslationMessage } from '../../i18n/index.js'
import { useSettings } from '../settings.js'
import {
  DEFAULT_PRESET_BASE_URL,
  getActiveResolvedPreset,
  type ResolvedPreset,
} from '../preset/index.js'
import { isSkippedFileId, SKIPPED_FILE_PREFIX } from './files.js'
import { readMessageEvent } from './parseEvent.js'
import {
  buildEndpointUrl,
  classifyProviderError,
  createClient,
  isProviderErrorLike,
  resolveCapabilities,
  type CanonicalAssistantBlock,
  type CanonicalBlock,
  type CanonicalMessage,
  type CanonicalRequest,
  type Capabilities,
  type Delta,
  type FinishReason,
  type NormalizedCitation,
  type Protocol,
  type ProviderErrorCondition,
  type ProviderProfile,
  type ProviderUsage,
} from './providers/index.js'
import type { CanonicalTool, CanonicalToolResult } from './providers/types.js'
import { readServerSentEvents } from './sse.js'
import type {
  ApiErrorBody,
  ClientToolParam,
  CreateMessageRequest,
  FileBlockParam,
  FileObject,
  FilePurpose,
  MessageParam,
  MessageStreamEvent,
  MessageUsage,
  OutputBlockStart,
  StopReason,
  TextBlockParam,
  TextCitation,
  ToolResultBlockParam,
} from './types.js'

/** 构建期 API 地址，默认 https://api.deepseek.com；本地开发支持开发服务器代理 */
export const API_ORIGIN = __API_ORIGIN__
/** Anthropic 兼容接口的前缀（未启用预设时的默认端点，与默认预设解析出的 base_url 相同） */
const ANTHROPIC_BASE_URL = DEFAULT_PRESET_BASE_URL
/** 引用 Files API 上传的图片、调用 Anthropic 兼容 Files API 时必须携带 */
const FILES_BETA = 'files-api-2025-04-14'
/** DeepSeek 的 Anthropic 兼容端点挂在 /anthropic 下；预设只写域名时由这里补全 */
const DEEPSEEK_HOST = 'deepseek.com'
const ANTHROPIC_SEGMENT = /\/anthropic(\/|$)/i

export type ApiErrorKind =
  /** 非 2xx 响应 */
  | 'http'
  /** 流中返回的错误帧（如等待生成超时），随后连接关闭 */
  | 'stream'
  /** 请求没有到达服务端（断网、跨域被拦截等） */
  | 'network'
  /** 流在 message_stop 之前结束 */
  | 'interrupted'
  /** 响应不符合协议（如非 SSE 响应） */
  | 'protocol'

export class ApiError extends Error {
  readonly localMessage?: TranslationMessage

  constructor(
    readonly kind: ApiErrorKind,
    message: string | TranslationMessage,
    readonly status?: number
  ) {
    super(typeof message === 'string' ? message : translate(message.key, message.params))
    this.name = 'ApiError'
    this.localMessage = typeof message === 'string' ? undefined : message
  }
}

const isErrorBody = (value: unknown): value is ApiErrorBody =>
  typeof value === 'object' &&
  value !== null &&
  'error' in value &&
  typeof (value as ApiErrorBody).error?.message === 'string'

const readErrorResponse = async (
  response: Response,
  kind: 'http' | 'protocol' = 'http',
  fallback = response.statusText
): Promise<ApiError> => {
  const text = await response.text().catch(() => '')
  let message = text || fallback
  try {
    const body: unknown = JSON.parse(text)
    if (isErrorBody(body)) {
      message = body.error.message
    }
  } catch {
    // 非 JSON 响应体直接展示原文
  }
  return new ApiError(kind, message, response.status)
}

export const request = async (url: string, init: RequestInit): Promise<Response> => {
  let response: Response
  try {
    response = await fetch(url, init)
  } catch (error) {
    if (init.signal?.aborted) {
      throw error
    }
    throw new ApiError('network', error instanceof Error ? error.message : String(error))
  }
  if (!response.ok) {
    throw await readErrorResponse(response)
  }
  return response
}

const anthropicHeaders = (apiKey: string, beta: boolean): Record<string, string> => ({
  // DeepSeek 兼容接口的鉴权方式，也可使用 Authorization: Bearer。
  'x-api-key': apiKey,
  // Files API 和通过 file_id 引用图片时必传；纯文本聊天无需携带。
  ...(beta ? { 'anthropic-beta': FILES_BETA } : {}),
})

const hasFile = (body: CreateMessageRequest) =>
  body.messages.some(
    (message) =>
      typeof message.content !== 'string' &&
      message.content.some((block) => block.type === 'image' || block.type === 'document')
  )

/**
 * 去掉占位附件块：占位 id 只存在于本地，切回 DeepSeek 兼容预设后不能发给服务端。
 * 去掉后内容为空的用户消息整条丢弃：Anthropic 不接受空 content 数组 / 空字符串（400），
 * 这种消息在 store / reply 层已经不会产生，这里只作为最后一道防线。
 */
const stripSkippedFiles = (body: CreateMessageRequest): CreateMessageRequest => {
  const messages: MessageParam[] = []
  for (const message of body.messages) {
    if (message.role !== 'user') {
      messages.push(message)
      continue
    }
    if (typeof message.content === 'string') {
      if (message.content.trim() !== '') {
        messages.push(message)
      }
      continue
    }
    const content = message.content.filter((block) => {
      // 文本与客户端工具结果原样保留；只有文件块可能引用本地占位 file_id
      if (block.type === 'text' || block.type === 'tool_result') {
        return true
      }
      return !isSkippedFileId(block.source.file_id)
    })
    if (content.length > 0) {
      messages.push({ ...message, content })
    }
  }
  return { ...body, messages }
}

// ---------- 能力降级提示 ----------

const warned = new Set<string>()

/**
 * 不支持的能力按规格「静默降级、只提示一次」：控制台提示便于排查，且不打断聊天。
 * no-console 规则在这里显式豁免：降级不告警会让用户以为功能坏了。
 */
const warnOnce = (key: string, message: string) => {
  if (warned.has(key)) {
    return
  }
  warned.add(key)
  // oxlint-disable-next-line no-console
  console.warn(`[preset] ${message}`)
}

// ---------- 预设 → Profile ----------

const PROTOCOL_BY_PRESET: Readonly<Record<ResolvedPreset['protocol'], Protocol>> = {
  anthropic: 'anthropic-messages',
  openai: 'openai-chat',
  responses: 'openai-responses',
}

const isDeepseekBaseUrl = (raw: string): boolean => {
  try {
    const host = new URL(raw).hostname.toLowerCase()
    return host === DEEPSEEK_HOST || host.endsWith(`.${DEEPSEEK_HOST}`)
  } catch {
    return false
  }
}

/**
 * DeepSeek 兼容端点：只有 anthropic + DeepSeek 域名保留 Files 附件、DeepSeek 私有字段
 * （safety_check / title / 服务端工具）与 latest_reminder 角色。
 */
const isAnthropicDeepseekPreset = (preset: ResolvedPreset | null): boolean =>
  preset !== null && preset.protocol === 'anthropic' && isDeepseekBaseUrl(preset.base_url)

/** DeepSeek 的 Anthropic 兼容接口在 /anthropic 下；预设只给域名时补全，已带则原样保留 */
const deepseekCompatBase = (baseUrl: string): string =>
  ANTHROPIC_SEGMENT.test(baseUrl) ? baseUrl : `${baseUrl.replace(/\/+$/, '')}/anthropic`

// ---------- 兼容模式（不发送 DeepSeek 私有扩展） ----------

/**
 * 兼容模式开关：请求层每次发送前同步读取，不订阅设置变化。
 * 开启后不发送 safety_check / title / DeepSeek 服务端工具 / latest_reminder 角色 / thinking.effort，
 * 标准采样参数与消息体结构保持不变；关闭时不做任何处理，请求与改动前完全一致。
 */
const isCompatibilityMode = (): boolean => useSettings.getState().compatibilityMode

/** DeepSeek 服务端工具（扩展模式）的类型名：兼容模式下从 tools 里移除 */
const DEEPSEEK_SERVER_TOOL_TYPES: ReadonlySet<string> = new Set([
  'deepseek_web_search',
  'deepseek_read_url',
])

const isDeepseekServerTool = (tool: unknown): boolean =>
  typeof tool === 'object' &&
  tool !== null &&
  DEEPSEEK_SERVER_TOOL_TYPES.has(String((tool as { type?: unknown }).type))

/**
 * 兼容模式：从「已构造好的线上请求体」里移除 DeepSeek 私有扩展。
 * 只删这几个键 / 工具 / 角色，不重排、不改写标准字段（model / messages / system / thinking.type /
 * temperature / top_p / max_tokens / stop_sequences 等原样保留），因此兼容模式下的请求体是默认请求体
 * 去掉私有扩展后的结果。返回新对象，不修改传入的 body。
 */
export const stripDeepseekExtensions = (body: Record<string, unknown>): Record<string, unknown> => {
  const rest: Record<string, unknown> = { ...body }
  delete rest.safety_check
  delete rest.title
  if (Array.isArray(rest.tools)) {
    const tools = rest.tools.filter((tool) => !isDeepseekServerTool(tool))
    if (tools.length > 0) {
      rest.tools = tools
    } else {
      delete rest.tools
    }
  }
  if (Array.isArray(rest.messages)) {
    rest.messages = rest.messages.filter(
      (message) => (message as { role?: unknown }).role !== 'latest_reminder'
    )
  }
  if (typeof rest.thinking === 'object' && rest.thinking !== null) {
    // 保留 thinking.type（由用户的深度思考开关决定），只去掉 DeepSeek 的 thinking.effort
    const thinking: Record<string, unknown> = { ...(rest.thinking as Record<string, unknown>) }
    delete thinking.effort
    rest.thinking = thinking
  }
  return rest
}

const toProfile = (preset: ResolvedPreset, apiKey: string): ProviderProfile => ({
  id: preset.id,
  label: preset.name,
  protocol: PROTOCOL_BY_PRESET[preset.protocol],
  baseUrl: preset.base_url,
  apiKey,
  model: preset.model,
  // 适配层只承载官方 Anthropic（DeepSeek 兼容端点走旧路径并保留 latest_reminder 私有角色）
  ...(preset.protocol === 'anthropic' ? { reminderRole: 'system' as const } : {}),
})

const deepseekAnthropicProfile = (preset: ResolvedPreset, apiKey: string): ProviderProfile => ({
  ...toProfile(preset, apiKey),
  baseUrl: deepseekCompatBase(preset.base_url),
})

/** Files API 只在「无预设（默认 DeepSeek 兼容端点）」或「anthropic + DeepSeek」时可用 */
export const supportsFileUpload = (): boolean => {
  const preset = getActiveResolvedPreset()
  return preset === null || isAnthropicDeepseekPreset(preset)
}

/** Files 端点与 messages 端点同目录：把 /messages 换成 /files */
const filesEndpointUrl = (profile: ProviderProfile): string => {
  const messages = buildEndpointUrl(profile)
  return messages.includes('/messages')
    ? messages.replace(/\/messages$/, '/files')
    : `${messages}/files`
}

// ---------- 错误映射（providers/errors.ts → 现有 ApiError） ----------

const isAbortError = (error: unknown): boolean =>
  (error instanceof DOMException && error.name === 'AbortError') ||
  (error instanceof Error && error.name === 'AbortError')

/**
 * 适配层错误换算成现有 ApiError，保持 classifyApiError / describeReply 的既有文案：
 * 分类用 providers/errors.ts 的 classifyProviderError，再把「状态码与条件不一致」的情况
 * 折算成 api/errors.ts 能识别的状态（例如 429 insufficient_quota → 402 余额不足、流内限流 → 429）。
 */
const STATUS_BY_CONDITION: Readonly<Partial<Record<ProviderErrorCondition, number>>> = {
  unauthorized: 401,
  insufficientBalance: 402,
  tooLarge: 413,
  rateLimited: 429,
  serverBusy: 503,
}

const toApiError = (error: unknown, protocol: Protocol): unknown => {
  if (isAbortError(error) || !isProviderErrorLike(error)) {
    return error
  }
  const { condition } = classifyProviderError(error, protocol)
  const status = STATUS_BY_CONDITION[condition] ?? error.status
  switch (error.kind) {
    case 'network':
      return new ApiError('network', error.message)
    case 'interrupted':
      return new ApiError('interrupted', '')
    case 'protocol':
    case 'config':
      return new ApiError('protocol', error.message)
    case 'stream':
      return new ApiError('stream', error.message, status)
    default:
      return new ApiError('http', error.message, status)
  }
}

// ---------- 附件 / 校验 / 密钥 ----------

/** 用 GET /models 校验 API Key（不产生费用）；启用预设时按预设端点与协议校验 */
export const verifyApiKey = async (apiKey: string, signal?: AbortSignal): Promise<void> => {
  const preset = getActiveResolvedPreset()
  if (!preset) {
    await request(`${API_ORIGIN}/models`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal,
    })
    return
  }
  // DeepSeek 的 /anthropic 兼容端点没有 /models，沿用默认端点的校验方式
  if (isAnthropicDeepseekPreset(preset)) {
    await request(`${API_ORIGIN}/models`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal,
    })
    return
  }
  const profile = toProfile(preset, apiKey)
  try {
    await createClient(profile).verify(signal)
  } catch (error) {
    throw toApiError(error, profile.protocol)
  }
}

/** 从 /models 响应里提取模型 id（兼容 OpenAI { data: [{ id }] } 与 Anthropic { data: [{ id }] }） */
const parseModelIds = (payload: unknown): string[] => {
  if (!payload || typeof payload !== 'object') {
    return []
  }
  const record = payload as Record<string, unknown>
  const list = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.models)
      ? record.models
      : []
  const ids: string[] = []
  for (const item of list) {
    if (typeof item === 'string') {
      ids.push(item)
      continue
    }
    if (item && typeof item === 'object') {
      const id = (item as { id?: unknown }).id
      const name = (item as { name?: unknown }).name
      if (typeof id === 'string') {
        ids.push(id)
      } else if (typeof name === 'string') {
        ids.push(name)
      }
    }
  }
  return [...new Set(ids)]
}

/**
 * 按当前预设的协议与端点获取模型列表（GET /models，不产生费用）。
 * - 未启用预设 / DeepSeek 的 Anthropic 兼容端点：走默认端点的 /models（Bearer）
 * - Anthropic 协议：{base_url}/models，携带 x-api-key 与 anthropic-version
 * - OpenAI / Responses 协议：{base_url}/models，Bearer
 */
export const listModels = async (apiKey: string, signal?: AbortSignal): Promise<string[]> => {
  const preset = getActiveResolvedPreset()
  const read = async (url: string, headers: Record<string, string>) => {
    const response = await request(url, { method: 'GET', headers, signal })
    return parseModelIds(await response.json())
  }
  if (!preset || isAnthropicDeepseekPreset(preset)) {
    return read(`${API_ORIGIN}/models`, { Authorization: `Bearer ${apiKey}` })
  }
  const base = preset.base_url.replace(/\/+$/, '')
  if (preset.protocol === 'anthropic') {
    return read(`${base}/models`, {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    })
  }
  return read(`${base}/models`, { Authorization: `Bearer ${apiKey}` })
}

let skippedFileSequence = 0

/**
 * POST Files API 上传附件（不设过期时间，会话里的历史附件一直可用）。
 * purpose 为 null 时不传该字段（图片）；purpose 必须排在 file 之前。
 *
 * 不支持 Files 的预设（Chat / Responses / 非 DeepSeek 的 Anthropic）直接降级：返回占位对象、
 * 只 warn 一次、不抛错，避免输入框因上传失败而阻塞发送；request 转换时这些附件会被跳过。
 */
export const uploadFile = async (
  apiKey: string,
  file: File,
  purpose: FilePurpose | null,
  signal?: AbortSignal
): Promise<FileObject> => {
  const preset = getActiveResolvedPreset()
  if (preset && !isAnthropicDeepseekPreset(preset)) {
    warnOnce(
      'files',
      `当前预设协议（${preset.protocol}）不支持 Files 附件，附件 ${file.name} 已跳过`
    )
    skippedFileSequence += 1
    return {
      id: `${SKIPPED_FILE_PREFIX}${skippedFileSequence}`,
      type: 'file',
      size_bytes: file.size,
      created_at: new Date().toISOString(),
      filename: file.name,
      mime_type: file.type,
    }
  }
  const url = preset
    ? filesEndpointUrl(deepseekAnthropicProfile(preset, apiKey))
    : `${ANTHROPIC_BASE_URL}/files`
  const form = new FormData()
  if (purpose) {
    form.append('purpose', purpose)
  }
  form.append('file', file)
  const response = await request(url, {
    method: 'POST',
    headers: anthropicHeaders(apiKey, true),
    body: form,
    signal,
  })
  return (await response.json()) as FileObject
}

/** DELETE Files API 文件；不支持 Files 的预设没有可删对象，直接跳过 */
export const deleteFile = async (apiKey: string, fileId: string): Promise<void> => {
  const preset = getActiveResolvedPreset()
  if (preset && !isAnthropicDeepseekPreset(preset)) {
    return
  }
  const url = preset
    ? `${filesEndpointUrl(deepseekAnthropicProfile(preset, apiKey))}/${encodeURIComponent(fileId)}`
    : `${ANTHROPIC_BASE_URL}/files/${encodeURIComponent(fileId)}`
  await request(url, {
    method: 'DELETE',
    headers: anthropicHeaders(apiKey, true),
  })
}

// ---------- 旧 Anthropic 兼容路径（无预设 / DeepSeek anthropic 预设） ----------

/**
 * 预设参数写进 DeepSeek Anthropic 兼容请求体：只带预设显式覆盖的字段
 * （默认预设留空的字段不补默认值，请求体与无预设时完全一致），
 * 且只带该协议支持的字段，penalties / seed / topK 等非 Anthropic 字段不发送（避免 400）。
 */
export const presetAnthropicBody = (
  body: CreateMessageRequest,
  preset: ResolvedPreset
): Record<string, unknown> => {
  const { params, overrides } = preset
  // DeepSeek 兼容端点的硬约束：客户端工具（记忆工具）必须与 thinking 同时使用，否则返回
  // "client tools can only be used together with ... in thinking mode"。
  // 只有客户端工具会触发这条约束；title / safety_check / 服务端工具存在时不强制 thinking。
  // 兼容模式会移除服务端工具，但客户端工具仍在时该 400 约束依旧成立，故保留这处必需的强制。
  const hasClientTools =
    Array.isArray(body.tools) && body.tools.some((tool) => 'input_schema' in tool)
  const forceThinking = hasClientTools && body.thinking?.type !== 'enabled'
  const wire: Record<string, unknown> = { ...body }
  if (overrides.model) {
    wire.model = preset.model
  }
  wire.stream = true
  // 采样参数只有预设显式填写时才写进请求体；留空 = 省略，交给接口自己的默认值
  if (params.max_tokens !== undefined) {
    wire.max_tokens = params.max_tokens
  }
  if (params.top_p !== undefined) {
    wire.top_p = params.top_p
  }
  if (forceThinking) {
    wire.thinking = { type: 'enabled' as const }
  }
  // 开启思考时部分模型拒收 temperature（与适配层一致：省略而不是置 1）
  if (body.thinking?.type !== 'enabled' && !forceThinking && params.temperature !== undefined) {
    wire.temperature = params.temperature
  }
  if (params.stop !== undefined && params.stop.length > 0) {
    wire.stop_sequences = params.stop
  }
  return wire
}

/**
 * POST Anthropic 兼容 /messages（stream: true），逐个产出流式事件，收到 message_stop 时结束。
 * ping、保活注释与无法解析的内容不产出；中止请求时抛出 signal 的 AbortError。
 * preset 为 null 时与接入预设前完全一致；非 null 时只替换预设显式覆盖的端点 / model 与参数。
 */
async function* streamAnthropicCompat(
  apiKey: string,
  body: CreateMessageRequest,
  signal: AbortSignal,
  preset: ResolvedPreset | null
): AsyncGenerator<MessageStreamEvent> {
  // 预设没有覆盖 base_url 时保持默认端点 URL（默认预设留空 = 系统默认）
  const profile =
    preset !== null && preset.overrides.base_url ? deepseekAnthropicProfile(preset, apiKey) : null
  const url = profile ? buildEndpointUrl(profile) : `${ANTHROPIC_BASE_URL}/messages`
  const compatBody = stripSkippedFiles(body)
  const wireBody: Record<string, unknown> = preset
    ? presetAnthropicBody(compatBody, preset)
    : { ...compatBody, stream: true }
  // 兼容模式：在最终线上请求体上移除 DeepSeek 私有扩展；关闭时 wireBody 原样发送
  const finalBody = isCompatibilityMode() ? stripDeepseekExtensions(wireBody) : wireBody
  const response = await request(url, {
    method: 'POST',
    headers: {
      ...anthropicHeaders(apiKey, hasFile(compatBody)),
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify(finalBody),
    signal,
  })
  const contentType = response.headers.get('Content-Type') ?? ''
  if (!response.body || !contentType.includes('text/event-stream')) {
    throw await readErrorResponse(response, 'protocol', '')
  }
  for await (const { event: eventName, data } of readServerSentEvents(response.body, signal)) {
    let payload: unknown
    try {
      payload = JSON.parse(data)
    } catch {
      if (eventName !== 'error') {
        continue
      }
    }
    if (isErrorBody(payload)) {
      throw new ApiError('stream', payload.error.message)
    }
    if (eventName === 'error') {
      throw new ApiError('stream', data)
    }
    const event = readMessageEvent(payload)
    if (!event) {
      continue
    }
    yield event
    if (event.type === 'message_stop') {
      return
    }
  }
  // 服务端没有提供错误内容时保持为空，不推测断流原因。
  throw new ApiError('interrupted', '')
}

/**
 * 旧导出名：无预设（默认 DeepSeek Anthropic 兼容端点）的流式请求。
 * 保留签名兼容，避免外部调用方（及离线测试）改动。
 */
export async function* streamMessage(
  apiKey: string,
  body: CreateMessageRequest,
  signal: AbortSignal
): AsyncGenerator<MessageStreamEvent> {
  yield* streamAnthropicCompat(apiKey, body, signal, null)
}

// ---------- CanonicalRequest 转换 ----------

const toCanonicalBlock = (block: FileBlockParam): CanonicalBlock => {
  const fileId = block.source.file_id
  if (block.type === 'image') {
    // Files API 不返回 MIME；适配层在本协议内只按 file_id 引用，MIME 仅作为占位
    return { type: 'image', mimeType: 'application/octet-stream', fileId }
  }
  return {
    type: 'document',
    mimeType: 'application/octet-stream',
    filename: fileId,
    fileId,
  }
}

const toCanonicalUserMessage = (
  content: string | (FileBlockParam | TextBlockParam | ToolResultBlockParam)[]
): CanonicalMessage => {
  if (typeof content === 'string') {
    return { role: 'user', content }
  }
  const texts: string[] = []
  const files: CanonicalBlock[] = []
  const toolResults: CanonicalToolResult[] = []
  for (const block of content) {
    if (block.type === 'text') {
      texts.push(block.text)
      continue
    }
    if (block.type === 'tool_result') {
      // 客户端工具结果：保留 JSON 原文，由各协议编译成 tool_result / tool / function_call_output
      toolResults.push({
        toolUseId: block.tool_use_id,
        content: block.content,
        ...(block.is_error ? { isError: true } : {}),
      })
      continue
    }
    if (isSkippedFileId(block.source.file_id)) {
      // 不支持 Files 的预设返回的占位附件只在本地存在，不进入任何协议的请求
      continue
    }
    files.push(toCanonicalBlock(block))
  }
  return {
    role: 'user',
    content: texts.join('\n\n'),
    ...(files.length > 0 ? { files } : {}),
    ...(toolResults.length > 0 ? { toolResults } : {}),
  }
}

const toCanonicalAssistantMessage = (
  message: Extract<MessageParam, { role: 'assistant' }>
): CanonicalMessage => {
  const blocks: CanonicalAssistantBlock[] = []
  for (const block of message.content) {
    switch (block.type) {
      case 'text':
        blocks.push({ type: 'text', text: block.text })
        break
      case 'thinking':
        blocks.push({ type: 'thinking', text: block.thinking, signature: block.signature })
        break
      case 'tool_use':
        blocks.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input })
        break
      case 'server_tool_use':
      case 'web_search_tool_result':
      case 'web_fetch_tool_result':
        blocks.push({
          type: 'provider_block',
          protocol: 'anthropic-messages',
          payload: block,
        })
        break
    }
  }
  return { role: 'assistant', blocks }
}

/**
 * 把现有 Anthropic 形状的消息转成归一化消息：
 * text / thinking 保留；服务端工具块作为同协议 provider_block 透传（跨协议由适配层丢弃）；
 * file 块转成 image / document（仅支持 Files API 的协议能发出去，其余由适配层 warn 后跳过）。
 * latest_reminder 转成 reminder，由适配层映射为同位置 system/developer（Chat/Responses）。
 */
const toCanonicalMessage = (message: MessageParam): CanonicalMessage => {
  switch (message.role) {
    case 'latest_reminder':
      return { role: 'reminder', content: message.content }
    case 'user':
      return toCanonicalUserMessage(message.content)
    case 'assistant':
      return toCanonicalAssistantMessage(message)
  }
}

/** 客户端工具：带 input_schema 的定义；服务端工具（DeepSeek 扩展）只在兼容端点有效 */
const isClientTool = (tool: CreateMessageRequest['tools'][number]): tool is ClientToolParam =>
  'input_schema' in tool

const warnDroppedDeepseekFields = (
  request: CreateMessageRequest,
  preset: ResolvedPreset,
  serverToolCount: number
) => {
  if (serverToolCount > 0 || request.safety_check || request.title?.enabled) {
    warnOnce(
      'deepseek-fields',
      `当前预设协议（${preset.protocol}）不发送 DeepSeek 私有字段（safety_check / title / 服务端工具），已跳过`
    )
  }
}

const warnUnsupportedParams = (
  preset: ResolvedPreset,
  capabilities: Capabilities,
  stop: string[]
) => {
  const { params } = preset
  if (typeof params.seed === 'number' && !capabilities.sampling.seed) {
    warnOnce('seed', `当前预设协议不支持 seed，已忽略（${preset.name}）`)
  }
  if (
    (params.presence_penalty !== undefined || params.frequency_penalty !== undefined) &&
    !capabilities.sampling.penalties
  ) {
    warnOnce('penalties', `当前预设协议不支持 penalties，已忽略（${preset.name}）`)
  }
  if (stop.length > 0 && !capabilities.stopSequences) {
    warnOnce('stop', `当前预设协议不支持 stop 序列，已忽略（${preset.name}）`)
  }
}

/**
 * CreateMessageRequest（Anthropic 形状）→ CanonicalRequest。
 * 采样参数只带预设显式填写过的字段：留空 = 请求体不出现该字段，由接口使用自己的默认值；
 * 不支持的能力只 warn 一次并由适配层降级。
 * compatible 为兼容模式：不生成 reminder 消息，也不带 thinking.effort（thinking.enabled 照旧）。
 */
export const buildCanonicalRequest = (
  request: CreateMessageRequest,
  preset: ResolvedPreset,
  profile: ProviderProfile,
  compatible: boolean
): CanonicalRequest => {
  const { params } = preset
  const capabilities = resolveCapabilities(profile)
  const stop = (params.stop ?? []).filter((item) => item.trim() !== '')
  warnUnsupportedParams(preset, capabilities, stop)
  // 客户端工具（记忆工具）走统一适配层；服务端工具（DeepSeek 扩展）由 warnDroppedDeepseekFields 提示丢弃
  const clientTools: CanonicalTool[] = request.tools.filter(isClientTool).map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.input_schema,
  }))
  const thinkingEnabled = request.thinking?.type === 'enabled'
  const system = request.system?.trim() ? request.system : undefined
  // 去掉占位附件后没有任何内容、文件块与工具结果的 user 消息：空 content 会被服务端拒绝（400）
  const messages = (
    compatible
      ? request.messages.filter((message) => message.role !== 'latest_reminder')
      : request.messages
  )
    .map(toCanonicalMessage)
    .filter(
      (message) =>
        message.role !== 'user' ||
        message.content.trim() !== '' ||
        (message.files?.length ?? 0) > 0 ||
        (message.toolResults?.length ?? 0) > 0
    )
  return {
    model: preset.model,
    ...(system === undefined ? {} : { system }),
    messages,
    ...(clientTools.length > 0 ? { tools: clientTools, toolChoice: 'auto' as const } : {}),
    // 未填写的采样参数一律省略，交给接口提供方自己的默认值
    ...(params.max_tokens === undefined ? {} : { maxOutputTokens: params.max_tokens }),
    ...(params.temperature === undefined ? {} : { temperature: params.temperature }),
    ...(params.top_p === undefined ? {} : { topP: params.top_p }),
    ...(stop.length === 0 ? {} : { stop }),
    ...(typeof params.seed === 'number' ? { seed: params.seed } : {}),
    ...(params.presence_penalty === undefined ? {} : { presencePenalty: params.presence_penalty }),
    ...(params.frequency_penalty === undefined
      ? {}
      : { frequencyPenalty: params.frequency_penalty }),
    thinking: {
      enabled: thinkingEnabled,
      ...(thinkingEnabled && !compatible && typeof params.reasoning_effort === 'string'
        ? { effort: params.reasoning_effort }
        : {}),
    },
    stream: true,
  }
}

// ---------- Delta → MessageStreamEvent ----------

/**
 * 统一结束原因 → 现有 StopReason。
 * stop_sequence / stopped 属于正常收尾；error（流内错误收尾）不能静默当成 end_turn，
 * 映射为 incomplete：界面会提示回答不完整，后续请求也不把它当作可用回答回传。
 */
export const mapFinishReasonToStopReason = (reason: FinishReason): StopReason => {
  switch (reason) {
    case 'max_tokens':
      return 'max_tokens'
    case 'tool_use':
      return 'tool_use'
    case 'refusal':
      return 'refusal'
    case 'error':
    case 'incomplete':
      return 'incomplete'
    default:
      return 'end_turn'
  }
}

const toMessageUsage = (usage: ProviderUsage): MessageUsage => ({
  input_tokens: usage.inputTokens,
  cache_creation_input_tokens: usage.cacheWriteTokens,
  cache_read_input_tokens: usage.cacheReadTokens,
  output_tokens: usage.outputTokens,
  ...(usage.reasoningTokens === undefined ? {} : { reasoning_tokens: usage.reasoningTokens }),
  ...(usage.serverToolUse === undefined
    ? {}
    : {
        server_tool_use: {
          web_search_requests: usage.serverToolUse.web_search_requests ?? 0,
          tool_search: usage.serverToolUse.tool_search ?? 0,
        },
      }),
})

const toTextCitation = (citation: NormalizedCitation): TextCitation => ({
  type: 'web_search_result_location',
  url: citation.url,
  title: citation.title,
  cited_text: citation.citedText ?? '',
  encrypted_index: '',
})

const readMetaRecord = (meta: unknown): Record<string, unknown> | null =>
  meta !== null && typeof meta === 'object' ? (meta as Record<string, unknown>) : null

/** block_start 的 Delta 没有正文内容；Anthropic 的 meta 带初始 wire 块，用于保留块级引用等 */
const toBlockStart = (delta: Extract<Delta, { type: 'block_start' }>): OutputBlockStart => {
  const meta = readMetaRecord(delta.meta)
  switch (delta.kind) {
    case 'text':
      return { type: 'text', text: typeof meta?.text === 'string' ? meta.text : '' }
    case 'thinking':
      return {
        type: 'thinking',
        thinking: typeof meta?.thinking === 'string' ? meta.thinking : '',
        signature: typeof meta?.signature === 'string' ? meta.signature : '',
      }
    case 'tool_use':
      return {
        type: 'tool_use',
        id: typeof meta?.id === 'string' ? meta.id : '',
        name: typeof meta?.name === 'string' ? meta.name : '',
        input: meta?.input ?? {},
      }
    case 'provider_block':
    default:
      // 服务端工具块在 Anthropic 适配层原样透传；无法识别时给一个空文本块由上层丢弃
      return (meta ?? { type: 'text', text: '' }) as OutputBlockStart
  }
}

/**
 * 三协议适配层路径：createClient(profile).stream() 的 Delta 还原成现有 MessageStreamEvent 序列，
 * 让 reply.ts 的 applyEvent 保持不变（message_start / content_block_* / message_delta / message_stop）。
 * finish 与 usage 谁后到都行：两者都齐了（或流收尾）再发 message_delta，保证 usage 不丢。
 */
async function* streamProviderAsEvents(
  preset: ResolvedPreset,
  apiKey: string,
  request: CreateMessageRequest,
  signal: AbortSignal
): AsyncGenerator<MessageStreamEvent> {
  const profile = toProfile(preset, apiKey)
  const hasAttachments = request.messages.some(
    (message) =>
      typeof message.content !== 'string' &&
      message.content.some((block) => block.type === 'image' || block.type === 'document')
  )
  if (hasAttachments) {
    warnOnce(
      'files',
      `当前预设协议（${preset.protocol}）不支持 Files 附件，已跳过 ${preset.name} 请求里的附件`
    )
  }
  const compatible = isCompatibilityMode()
  if (!compatible) {
    // 兼容模式是用户主动要求不发送私有字段，不需要再打降级告警
    warnDroppedDeepseekFields(
      request,
      preset,
      request.tools.filter((tool) => !isClientTool(tool)).length
    )
  }
  const canonical = buildCanonicalRequest(request, preset, profile, compatible)
  const client = createClient(profile)
  let started = false
  let usage: ProviderUsage | undefined
  let finish: { reason: FinishReason; stopSequence?: string | null } | undefined
  let deltaSent = false

  const startEvent = (messageId?: string, model?: string): MessageStreamEvent => ({
    type: 'message_start',
    message: { id: messageId ?? '', model: model ?? preset.model },
  })
  /**
   * finish 与 usage 谁先到都可能：chat 的 usage 常跟在 finish_reason 之后，先别急着发
   * message_delta，等 usage 到了再发；流结束（force）时即使没有 usage 也补齐。
   */
  const flushFinish = (force: boolean): MessageStreamEvent | null => {
    if (deltaSent || finish === undefined || (!force && usage === undefined)) {
      return null
    }
    deltaSent = true
    return {
      type: 'message_delta',
      delta: {
        stop_reason: mapFinishReasonToStopReason(finish.reason),
        stop_sequence: null,
      },
      ...(usage === undefined ? {} : { usage: toMessageUsage(usage) }),
    }
  }

  try {
    for await (const delta of client.stream(canonical, signal)) {
      switch (delta.type) {
        case 'start':
          if (!started) {
            started = true
            yield startEvent(delta.messageId, delta.model)
          }
          break
        case 'block_start':
          if (!started) {
            started = true
            yield startEvent()
          }
          yield {
            type: 'content_block_start',
            index: delta.index,
            content_block: toBlockStart(delta),
          }
          break
        case 'text':
          yield {
            type: 'content_block_delta',
            index: delta.index,
            delta: { type: 'text_delta', text: delta.text },
          }
          break
        case 'thinking':
          yield {
            type: 'content_block_delta',
            index: delta.index,
            delta: { type: 'thinking_delta', thinking: delta.text },
          }
          break
        case 'signature':
          yield {
            type: 'content_block_delta',
            index: delta.index,
            delta: { type: 'signature_delta', signature: delta.signature },
          }
          break
        case 'citation':
          yield {
            type: 'content_block_delta',
            index: delta.index,
            delta: { type: 'citations_delta', citation: toTextCitation(delta.citation) },
          }
          break
        case 'tool_call_delta':
          // 客户端工具参数分片：reply.applyEvent 按块拼成完整 input，块结束时解析
          yield {
            type: 'content_block_delta',
            index: delta.index,
            delta: { type: 'input_json_delta', partial_json: delta.json },
          }
          break
        case 'block_stop':
          yield { type: 'content_block_stop', index: delta.index }
          break
        case 'usage':
          if (delta.final) {
            usage = delta.usage
          }
          break
        case 'finish':
          finish = {
            reason: delta.reason,
            ...(delta.stopSequence === undefined ? {} : { stopSequence: delta.stopSequence }),
          }
          break
        case 'error': {
          const mapped = toApiError(delta.error, profile.protocol)
          throw mapped === delta.error ? delta.error : mapped
        }
      }
      const finalDelta = flushFinish(false)
      if (finalDelta) {
        yield finalDelta
      }
    }
  } catch (error) {
    const mapped = toApiError(error, profile.protocol)
    throw mapped === error ? error : mapped
  }
  if (!started) {
    yield startEvent()
  }
  const finalDelta = flushFinish(true)
  if (finalDelta) {
    yield finalDelta
  }
  yield { type: 'message_stop' }
}

// ---------- 统一入口 ----------

/**
 * 聊天请求入口：按当前启用预设选择协议。
 * - 未启用预设，或「默认预设 + 没有填写任何覆盖字段」：保持改动前的 DeepSeek Anthropic
 *   兼容端点与请求体（含 title / Files 附件 / safety_check / 服务端工具），二者完全等价。
 * - anthropic + DeepSeek 域名：同样走兼容路径，只替换预设显式覆盖的 base_url / model / 参数，
 *   保留 thinking、服务端工具、safety_check 与 Files 附件（适配层 P0 不发附件，故不经过它）。
 * - 其它（openai / responses / 官方 anthropic）：createClient(profile).stream()，
 *   请求体经 CanonicalRequest 归一，流经 Delta 还原成 MessageStreamEvent。
 * apiKey 沿用应用的 API Key 设置（预设不含密钥）。
 */
export async function* streamChat(
  request: CreateMessageRequest,
  signal: AbortSignal,
  apiKey = ''
): AsyncGenerator<MessageStreamEvent> {
  const preset = getActiveResolvedPreset()
  if (preset === null || isAnthropicDeepseekPreset(preset)) {
    yield* streamAnthropicCompat(apiKey, request, signal, preset)
    return
  }
  yield* streamProviderAsEvents(preset, apiKey, request, signal)
}
