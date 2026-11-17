/**
 * 三协议 API 适配层入口（规格 §6.2 / §6.9）。
 *
 * createClient(profile) 按 profile.protocol 选择适配器，向上只暴露：
 *   stream(req, signal): AsyncIterable<Delta>   —— 统一流式增量
 *   verify(signal?)                              —— GET {base}/models 预热/校验
 *
 * 本文件承载所有协议共用的流式底座：fetch（可注入）、HTTP 错误体解析、
 * text/event-stream 校验、SSE 解码（复用 sse.ts）与终止/断流判定。
 */

import { readServerSentEvents } from '../sse.js'
import { anthropicAdapter } from './anthropic.js'
import {
  createHttpError,
  createNetworkError,
  createProtocolError,
  providerConfigError,
  type ProviderHttpError,
} from './errors.js'
import { buildModelsUrl } from './normalize.js'
import { openAIChatAdapter } from './openai.js'
import { responsesAdapter } from './responses.js'
import type {
  CanonicalRequest,
  ChatClient,
  CompiledRequest,
  Delta,
  FetchLike,
  Protocol,
  ProtocolAdapter,
  ProviderProfile,
  StreamRequestOptions,
} from './types.js'

const ADAPTERS: Record<Protocol, ProtocolAdapter> = {
  'anthropic-messages': anthropicAdapter,
  'openai-chat': openAIChatAdapter,
  'openai-responses': responsesAdapter,
}

/** 按协议取适配器；未知协议属于 Profile 配置错误，直接抛 config 错误 */
export const getProtocolAdapter = (protocol: Protocol): ProtocolAdapter => {
  const adapter = ADAPTERS[protocol]
  if (!adapter) {
    throw providerConfigError(`未知的协议：${String(protocol)}`)
  }
  return adapter
}

/**
 * 中止检查：fetch 被 abort 时原样抛出（Store 依赖 AbortError 判定 stopped），
 * 读取阶段被取消时补一个标准的 AbortError，绝不吞掉。
 */
const throwIfAborted = (signal: AbortSignal | undefined): void => {
  if (!signal?.aborted) {
    return
  }
  const reason: unknown = signal.reason
  if (reason instanceof Error) {
    throw reason
  }
  throw new DOMException('The operation was aborted.', 'AbortError')
}

const readHttpError = async (
  response: Response,
  protocol: Protocol
): Promise<ProviderHttpError> => {
  const body = await response.text().catch(() => '')
  return createHttpError({
    status: response.status,
    statusText: response.statusText,
    body,
    retryAfter: response.headers.get('retry-after'),
    protocol,
  })
}

/** 发出流式请求：非 2xx 解析三种错误体后抛 ProviderHttpError；非 SSE 响应抛 protocol 错误 */
const postEventStream = async (
  profile: ProviderProfile,
  compiled: CompiledRequest,
  options: StreamRequestOptions
): Promise<Response> => {
  const fetchImpl: FetchLike = options.fetch ?? globalThis.fetch
  throwIfAborted(options.signal)
  let response: Response
  try {
    response = await fetchImpl(compiled.url, {
      method: 'POST',
      headers: compiled.headers,
      body: JSON.stringify(compiled.body),
      signal: options.signal,
    })
  } catch (error) {
    if (options.signal.aborted) {
      throw error
    }
    throw createNetworkError(error, profile.protocol)
  }
  if (!response.ok) {
    throw await readHttpError(response, profile.protocol)
  }
  const contentType = response.headers.get('content-type') ?? ''
  if (!response.body || !contentType.includes('text/event-stream')) {
    const text = await response.text().catch(() => '')
    throw createProtocolError(
      text.trim() || `响应不是 text/event-stream（HTTP ${response.status}）`,
      profile.protocol
    )
  }
  return response
}

/**
 * 归一化请求 → 归一化增量流。终止语义：
 * - 正常：解析器发出 finish（恰好一次），收到协议终止事件后结束；
 * - 断流：解析器 end() 抛 ProviderError('interrupted')（finish 可能已发出，由上层按
 *   stopReason 决定是否算完成，对应 store.ts 既有行为）；
 * - 流内错误：先发 {type:'error'}，迭代器随后正常结束，不会再有 finish。
 */
export async function* streamProvider(
  profile: ProviderProfile,
  req: CanonicalRequest,
  options: StreamRequestOptions
): AsyncGenerator<Delta, void, void> {
  const adapter = getProtocolAdapter(profile.protocol)
  throwIfAborted(options.signal)
  const compiled = adapter.compile(profile, req)
  const response = await postEventStream(profile, compiled, options)
  const parser = adapter.createParser()
  const body = response.body
  if (!body) {
    throw createProtocolError('响应没有可读取的流', profile.protocol)
  }
  for await (const event of readServerSentEvents(body, options.signal)) {
    throwIfAborted(options.signal)
    for (const delta of parser.push(event)) {
      yield delta
    }
    if (parser.terminal) {
      return
    }
  }
  throwIfAborted(options.signal)
  for (const delta of parser.end()) {
    yield delta
  }
}

/** GET {base}/models 校验 Key / 端点；部分网关未实现 models 时由上层决定是否改用最小请求 */
const verifyProvider = async (
  profile: ProviderProfile,
  adapter: ProtocolAdapter,
  signal?: AbortSignal
): Promise<void> => {
  throwIfAborted(signal)
  let response: Response
  try {
    response = await globalThis.fetch(buildModelsUrl(profile), {
      method: 'GET',
      headers: { accept: 'application/json', ...adapter.headers(profile) },
      signal,
    })
  } catch (error) {
    if (signal?.aborted) {
      throw error
    }
    throw createNetworkError(error, profile.protocol)
  }
  if (!response.ok) {
    throw await readHttpError(response, profile.protocol)
  }
}

/** 按 Profile 创建客户端；上层按 profile.id 缓存即可（无内部状态） */
export const createClient = (profile: ProviderProfile): ChatClient => {
  const adapter = getProtocolAdapter(profile.protocol)
  return {
    verify: (signal) => verifyProvider(profile, adapter, signal),
    stream: (req, signal) => streamProvider(profile, req, { signal }),
  }
}

export { PROTOCOL_CAPABILITIES, resolveCapabilities } from './types.js'
export type {
  ApiProtocol,
  BlockKind,
  CanonicalAssistantBlock,
  CanonicalBlock,
  CanonicalMessage,
  CanonicalRequest,
  Capabilities,
  CapabilityOverrides,
  ChatClient,
  CompiledRequest,
  Delta,
  FetchLike,
  FinishReason,
  NormalizedCitation,
  NormalizedUsage,
  Protocol,
  ProtocolAdapter,
  ProviderErrorKind,
  ProviderErrorLike,
  ProviderErrorProvider,
  ProviderProfile,
  ProviderUsage,
  StreamParser,
  StreamRequestOptions,
  VersionPathMode,
} from './types.js'

export {
  ProviderError,
  ProviderHttpError,
  classifyProviderError,
  createHttpError,
  createInterruptedError,
  createNetworkError,
  createProtocolError,
  createStreamError,
  isProviderError,
  isProviderErrorLike,
  isRetryableProviderError,
  parseRetryAfter,
  providerConfigError,
} from './errors.js'
export type {
  ApiErrorCondition,
  ParsedProviderError,
  ProviderErrorClassification,
  ProviderErrorCondition,
} from './errors.js'

export {
  MODELS_PATH,
  PROTOCOL_PATHS,
  buildEndpointUrl,
  buildModelsUrl,
  normalizeBaseUrl,
  resolveBaseUrl,
} from './normalize.js'

export {
  AnthropicStreamParser,
  anthropicAdapter,
  anthropicHeaders,
  compileAnthropicRequest,
  mapAnthropicStopReason,
  normalizeAnthropicUsage,
  toAnthropicCitation,
} from './anthropic.js'
export {
  OpenAIChatStreamParser,
  compileOpenAIChatRequest,
  mapChatFinishReason,
  normalizeChatUsage,
  openAIChatAdapter,
  openAIChatHeaders,
} from './openai.js'
export {
  ResponsesStreamParser,
  compileResponsesRequest,
  normalizeResponsesUsage,
  responsesAdapter,
  responsesHeaders,
  toResponsesCitation,
} from './responses.js'
