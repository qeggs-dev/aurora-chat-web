/**
 * 协议感知的错误分类与流式请求公共底座（规格 §8）。
 *
 * 与现有 api/errors.ts 的关系：本文件不 import client.ts，避免适配层把 __API_ORIGIN__
 * 等构建期常量拖进来；HTTP 状态兜底逻辑与 classifyStatus 保持一致，等 P2 收敛到 api/errors.ts。
 * 错误体解析同时覆盖三种 wire 形态：
 *   1. OpenAI Chat / Responses：{ error: { message, type, param, code } }
 *   2. Anthropic：{ type: "error", error: { type, message } }
 *   3. 纯文本 / 网关 HTML：整体当 message
 */

import {
  isRecord,
  readNumber,
  readString,
  type ProviderErrorKind,
  type ProviderErrorLike,
  type ProviderErrorProvider,
  type Protocol,
} from './types.js'

/** 统一分类枚举（与现有 ApiErrorCondition 同名同值）；更细的 forbidden/badRequest 等暂不引入 */
export type ProviderErrorCondition =
  | 'unauthorized'
  | 'insufficientBalance'
  | 'tooLarge'
  | 'rateLimited'
  | 'serverBusy'
  | 'network'
  | 'other'

/** 规格 §8.1 的旧名字，方便直接替换 import */
export type ApiErrorCondition = ProviderErrorCondition

export type ProviderErrorClassification = {
  condition: ProviderErrorCondition
  retryable: boolean
  retryAfterMs?: number
}

type ProviderErrorInit = {
  status?: number
  provider?: ProviderErrorProvider
  retryAfterMs?: number
  cause?: unknown
}

/** 适配层统一抛出的错误；provider 字段保留协议原始 type / code / message 供分类与日志使用 */
export class ProviderError extends Error implements ProviderErrorLike {
  readonly kind: ProviderErrorKind
  readonly status?: number
  readonly provider?: ProviderErrorProvider
  readonly retryAfterMs?: number

  constructor(kind: ProviderErrorKind, message: string, init: ProviderErrorInit = {}) {
    super(
      message,
      init.cause === undefined
        ? undefined
        : { cause: init.cause instanceof Error ? init.cause : String(init.cause) }
    )
    this.name = 'ProviderError'
    this.kind = kind
    this.status = init.status
    this.provider = init.provider
    this.retryAfterMs = init.retryAfterMs
  }
}

/** 非 2xx 响应；status / provider / retryAfterMs 都带上，供上层重试与文案区分 */
export class ProviderHttpError extends ProviderError {
  constructor(message: string, init: ProviderErrorInit & { status: number }) {
    super('http', message, init)
    this.name = 'ProviderHttpError'
  }
}

export const isProviderError = (value: unknown): value is ProviderError =>
  value instanceof ProviderError

const ERROR_KINDS: ReadonlySet<string> = new Set<ProviderErrorKind>([
  'http',
  'stream',
  'network',
  'interrupted',
  'protocol',
  'config',
])

/** 结构化判定，允许上层传入自定义错误对象（不强制 instanceof） */
export const isProviderErrorLike = (value: unknown): value is ProviderErrorLike => {
  if (!isRecord(value)) {
    return false
  }
  return (
    typeof value.kind === 'string' &&
    ERROR_KINDS.has(value.kind) &&
    typeof value.message === 'string'
  )
}

/** 非法 Profile / 请求参数：编译期直接抛，不发请求 */
export const providerConfigError = (message: string): ProviderError =>
  new ProviderError('config', message)

// ---------- 错误体解析 ----------

/** 从三种错误体里提取的协议原始错误信息 */
export type ParsedProviderError = {
  type?: string
  code?: string
  message: string
}

const MAX_MESSAGE_LENGTH = 2000

const truncateMessage = (message: string): string =>
  message.length > MAX_MESSAGE_LENGTH ? `${message.slice(0, MAX_MESSAGE_LENGTH)}…` : message

/**
 * 读取 { error: { message, type, code } } 形态；Anthropic 的 { type: "error", error: {...} }
 * 与 Chat / Responses 的 HTTP 错误体共用。DeepSeek 的无名 data error 帧也是这个形状。
 */
export const readNestedErrorPayload = (value: unknown): ParsedProviderError | null => {
  if (!isRecord(value) || !isRecord(value.error)) {
    return null
  }
  const error = value.error
  const message = readString(error.message) ?? readString(value.message) ?? ''
  return {
    type: readString(error.type),
    code: readString(error.code),
    message: truncateMessage(message),
  }
}

/** Responses 的流内错误有两种：event:error 扁平 {type:"error",code,message} 与 response.failed */
export const readResponsesStreamError = (value: unknown): ParsedProviderError | null => {
  if (!isRecord(value)) {
    return null
  }
  if (value.type === 'error') {
    return {
      code: readString(value.code),
      message: truncateMessage(readString(value.message) ?? ''),
    }
  }
  if (
    value.type === 'response.failed' &&
    isRecord(value.response) &&
    isRecord(value.response.error)
  ) {
    const error = value.response.error
    return {
      code: readString(error.code),
      message: truncateMessage(readString(error.message) ?? ''),
    }
  }
  return null
}

/** Retry-After 支持秒数与 HTTP-date；解析不出时返回 undefined */
export const parseRetryAfter = (value: string | null | undefined): number | undefined => {
  const trimmed = value?.trim()
  if (!trimmed) {
    return undefined
  }
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000
  }
  const timestamp = Date.parse(trimmed)
  if (Number.isNaN(timestamp)) {
    return undefined
  }
  return Math.max(0, timestamp - Date.now())
}

export type HttpErrorInput = {
  status: number
  statusText: string
  /** 响应体原文（可能为空 / HTML） */
  body: string
  retryAfter?: string | null
  protocol: Protocol
}

/** 构造非 2xx 错误：优先用响应体里的协议错误信息，回退状态文本 */
export const createHttpError = ({
  status,
  statusText,
  body,
  retryAfter,
  protocol,
}: HttpErrorInput): ProviderHttpError => {
  let parsed: ParsedProviderError | null = null
  const text = body.trim()
  try {
    parsed = readNestedErrorPayload(JSON.parse(text))
  } catch {
    // 非 JSON 响应体直接展示原文
  }
  const fallback = text || statusText || `HTTP ${status}`
  const message = truncateMessage(parsed?.message || fallback)
  return new ProviderHttpError(message, {
    status,
    provider: { protocol, type: parsed?.type, code: parsed?.code, message },
    retryAfterMs: parseRetryAfter(retryAfter),
  })
}

/** 请求没到达服务端（断网、CORS 被拦、DNS 失败等） */
export const createNetworkError = (cause: unknown, protocol: Protocol): ProviderError => {
  const message = cause instanceof Error ? cause.message : String(cause)
  return new ProviderError('network', message, {
    cause,
    provider: { protocol, message },
  })
}

/** 流在协议终止事件之前结束；已发出的内容不回滚，上层按已有内容决定是否算完成 */
export const createInterruptedError = (protocol: Protocol): ProviderError =>
  new ProviderError('interrupted', '', {
    provider: { protocol, message: 'stream interrupted before terminal event' },
  })

/** 响应不是可消费的 SSE（200 但 Content-Type 不对、缺少 body 等） */
export const createProtocolError = (message: string, protocol: Protocol): ProviderError =>
  new ProviderError('protocol', message, {
    provider: { protocol, message },
  })

/** 流内错误帧：保留协议原始 type / code；HTTP 状态不存在，分类靠 type/code */
export const createStreamError = (
  protocol: Protocol,
  parsed: ParsedProviderError
): ProviderError => {
  const message = truncateMessage(parsed.message || 'stream error')
  return new ProviderError('stream', message, {
    provider: { protocol, type: parsed.type, code: parsed.code, message },
  })
}

// ---------- 分类 ----------

const RETRYABLE_CONDITIONS: ReadonlySet<ProviderErrorCondition> = new Set([
  'network',
  'rateLimited',
  'serverBusy',
])

const CONDITION_BY_STATUS = (status: number): ProviderErrorCondition => {
  if (status === 401) {
    return 'unauthorized'
  }
  if (status === 402) {
    return 'insufficientBalance'
  }
  if (status === 413) {
    return 'tooLarge'
  }
  if (status === 429) {
    return 'rateLimited'
  }
  if (status >= 500) {
    return 'serverBusy'
  }
  return 'other'
}

/** 余额 / 额度耗尽：OpenAI 走 429，Anthropic 官方历史上走 400，必须靠文案与 code 兜住 */
const QUOTA_PATTERN =
  /insufficient_quota|credit_balance_exhausted|spend_limit_exceeded|billing_hard_limit_reached|credit balance is too low|insufficient balance|quota exceeded|exceeded your current quota|余额不足|余额已用尽|额度不足/i

/** 请求过大 / 上下文超限 */
const TOO_LARGE_PATTERN =
  /context_length_exceeded|maximum context length|context window|prompt is too long|request_too_large|too many tokens|string too long|input is too long|request exceeds/i

const AUTH_PATTERN =
  /authentication_error|invalid_api_key|invalid x-api-key|invalid authentication|incorrect api key|unauthorized/i

const RATE_LIMIT_PATTERN =
  /rate_limit_error|rate_limit_exceeded|rate limit|too many requests|slow_down|throttl/i

const SERVER_BUSY_PATTERN =
  /overloaded_error|overloaded|server_error|api_error|internal_server_error|service_unavailable|bad_gateway|gateway_timeout|insufficient_system_resource|try again/i

/** 各协议流内错误的已知 code → 分类；状态码不存在时优先用它，避免误判重试 */
const STREAM_CODE_CONDITIONS: Readonly<
  Record<Protocol, ReadonlyArray<readonly [RegExp, ProviderErrorCondition]>>
> = {
  'anthropic-messages': [
    [/overloaded_error/, 'serverBusy'],
    [/rate_limit_error/, 'rateLimited'],
    [/authentication_error/, 'unauthorized'],
    [/invalid_request_error|request_too_large/, 'other'],
  ],
  'openai-chat': [
    [/rate_limit_exceeded|rate_limit_error/, 'rateLimited'],
    [/server_error|insufficient_system_resource|api_error/, 'serverBusy'],
    [/invalid_api_key|authentication_error/, 'unauthorized'],
  ],
  'openai-responses': [
    [/rate_limit_exceeded/, 'rateLimited'],
    [/server_error|api_error/, 'serverBusy'],
    [/invalid_prompt|invalid_request_error/, 'other'],
  ],
}

const toClassification = (
  condition: ProviderErrorCondition,
  retryAfterMs?: number
): ProviderErrorClassification => ({
  condition,
  retryable: RETRYABLE_CONDITIONS.has(condition),
  ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
})

/**
 * 协议感知分类：先看错误体里的 type / code / 文案，再回退 HTTP 状态。
 *
 * 与旧 classifyStatus 的差异（规格 §8.3）：
 * - 429 + insufficient_quota → insufficientBalance 且不可重试，避免对余额耗尽做指数退避；
 * - Anthropic 400 的「credit balance is too low」→ insufficientBalance；
 * - 529 overloaded_error → serverBusy（状态兜底 >=500 已经覆盖，但文案更明确）。
 */
export const classifyProviderError = (
  error: unknown,
  protocol: Protocol
): ProviderErrorClassification => {
  if (!isProviderErrorLike(error)) {
    if (!isRecord(error)) {
      return toClassification('other')
    }
    const status = readNumber(error.status)
    return status === undefined
      ? toClassification('other')
      : toClassification(CONDITION_BY_STATUS(status))
  }

  const status = error.status
  const retryAfterMs = error.retryAfterMs
  const type = error.provider?.type ?? ''
  const code = error.provider?.code ?? ''
  const message = error.provider?.message || error.message || ''
  const codes = `${type} ${code}`.toLowerCase()
  const haystack = `${codes} ${message}`.toLowerCase()

  // 1) 协议错误码 / 文案优先于状态码：配额与长度类必须先于 429 / 400 的默认映射
  if (QUOTA_PATTERN.test(haystack)) {
    return toClassification('insufficientBalance', retryAfterMs)
  }
  if (TOO_LARGE_PATTERN.test(haystack)) {
    return toClassification('tooLarge', retryAfterMs)
  }
  if (AUTH_PATTERN.test(codes)) {
    return toClassification('unauthorized', retryAfterMs)
  }
  if (error.kind === 'network') {
    return toClassification('network', retryAfterMs)
  }

  // 2) HTTP 状态兜底
  if (status !== undefined) {
    return toClassification(CONDITION_BY_STATUS(status), retryAfterMs)
  }

  // 3) 流内错误帧没有状态码：按协议已知 code，再按文案特征
  for (const [pattern, condition] of STREAM_CODE_CONDITIONS[protocol]) {
    if (pattern.test(codes)) {
      return toClassification(condition, retryAfterMs)
    }
  }
  if (RATE_LIMIT_PATTERN.test(haystack)) {
    return toClassification('rateLimited', retryAfterMs)
  }
  if (SERVER_BUSY_PATTERN.test(haystack)) {
    return toClassification('serverBusy', retryAfterMs)
  }
  return toClassification('other', retryAfterMs)
}

/** 重试可能成功：网络、限流、服务端繁忙；余额 / 参数 / 鉴权类重试无用 */
export const isRetryableProviderError = (error: unknown, protocol: Protocol): boolean =>
  classifyProviderError(error, protocol).retryable

// ---------- 请求参数校验 ----------

export const assertNumberInRange = (
  name: string,
  value: number | undefined,
  min: number,
  max: number
): void => {
  if (value === undefined) {
    return
  }
  if (!Number.isFinite(value) || value < min || value > max) {
    throw providerConfigError(`${name} 必须在 ${min}–${max} 之间（当前 ${String(value)}）`)
  }
}

/** 整数下限；返回校验过的值，便于直接写进请求体 */
export const assertIntegerAtLeast = (
  name: string,
  value: number | undefined,
  min: number
): number | undefined => {
  if (value === undefined) {
    return undefined
  }
  if (!Number.isSafeInteger(value) || value < min) {
    throw providerConfigError(`${name} 必须是不小于 ${min} 的整数（当前 ${String(value)}）`)
  }
  return value
}

/**
 * 停止序列校验：非空字符串数组；超过上限截断并告警（Anthropic 16、Chat 4）。
 * 返回 undefined 表示不发送该字段。
 */
export const readStopSequences = (
  name: string,
  stop: string[] | undefined,
  max: number,
  warnings: string[]
): string[] | undefined => {
  if (stop === undefined) {
    return undefined
  }
  if (!Array.isArray(stop) || stop.some((item) => typeof item !== 'string' || item === '')) {
    throw providerConfigError(`${name} 必须是非空字符串数组`)
  }
  if (stop.length === 0) {
    return undefined
  }
  if (stop.length > max) {
    warnings.push(`${name} 最多 ${max} 个，已截断（丢弃 ${stop.length - max} 个）`)
    return stop.slice(0, max)
  }
  return stop
}
