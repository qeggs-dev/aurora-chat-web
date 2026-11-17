/**
 * Base URL 归一化与协议路径拼接（规格 §7）。
 *
 * 规则：trim → 校验 http(s) 且不含 query/hash → 去结尾斜杠 → 剥掉粘贴的完整端点 →
 * 末尾不是版本段则补 /v1（versionPath 可改）→ 再按协议拼 /chat/completions、
 * /messages、/responses。Azure OpenAI 的版本段不是 /v1，用 versionPath:'never' +
 * endpointTemplate + query 逃生。
 */

import { providerConfigError } from './errors.js'
import type { Protocol, ProviderProfile, VersionPathMode } from './types.js'

/** 协议端点路径（规格 §7.2 拼接表） */
export const PROTOCOL_PATHS: Readonly<Record<Protocol, string>> = {
  'openai-chat': '/chat/completions',
  'anthropic-messages': '/messages',
  'openai-responses': '/responses',
}

/** 校验等共用接口的路径 */
export const MODELS_PATH = '/models'

export type NormalizeBaseUrlOptions = {
  versionPath?: VersionPathMode
  /** 设置后不补版本段：完整 URL 由模板接管（Azure 等） */
  endpointTemplate?: string
}

/** 用户可能粘贴的完整端点；按最长匹配剥掉，避免出现 /v1/chat/completions/chat/completions */
const ENDPOINT_SUFFIXES = [
  '/chat/completions',
  '/responses',
  '/messages',
  '/completions',
  '/models',
] as const

/** 版本段：v1、v1beta、v1alpha、v2…；只看最后一段，/anthropic 这类前缀原样保留 */
const VERSION_SEGMENT = /^v\d+[a-z0-9]*$/i

const stripTrailingSlashes = (value: string): string => value.replace(/\/+$/, '')

/**
 * 归一化成「版本化 API 根」，供协议路径拼接。
 * 注意：只做「缺版本段则补」，绝不把用户已有的 /v1 去重。
 */
export const normalizeBaseUrl = (raw: string, options: NormalizeBaseUrlOptions = {}): string => {
  const trimmed = raw.trim()
  if (!trimmed) {
    throw providerConfigError('baseUrl 不能为空')
  }

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw providerConfigError(`baseUrl 不是合法的 URL：${raw}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw providerConfigError(`baseUrl 必须以 http:// 或 https:// 开头：${raw}`)
  }
  if (parsed.search || parsed.hash) {
    throw providerConfigError('baseUrl 不能包含查询参数或锚点，请改用 profile.query')
  }
  if (parsed.pathname.includes('//')) {
    throw providerConfigError(`baseUrl 路径里不能有连续斜杠：${raw}`)
  }

  let base = stripTrailingSlashes(trimmed)
  const lower = base.toLowerCase()
  const suffix = ENDPOINT_SUFFIXES.find((candidate) => lower.endsWith(candidate))
  if (suffix) {
    base = stripTrailingSlashes(base.slice(0, -suffix.length))
  }

  // 有模板时版本段由模板负责（Azure 的 api-version 不是版本路径），不做自动补全
  if (options.endpointTemplate) {
    return base
  }

  const lastSegment = new URL(base).pathname.split('/').filter(Boolean).at(-1) ?? ''
  if (VERSION_SEGMENT.test(lastSegment)) {
    return base
  }
  if ((options.versionPath ?? 'auto') === 'never') {
    return base
  }
  return `${base}/v1`
}

/** Profile 的归一化 base（版本段策略与逃生口都来自 Profile） */
export const resolveBaseUrl = (profile: ProviderProfile): string =>
  normalizeBaseUrl(profile.baseUrl, {
    versionPath: profile.versionPath,
    endpointTemplate: profile.endpointTemplate,
  })

const appendQuery = (url: string, query: Record<string, string> | undefined): string => {
  if (!query) {
    return url
  }
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value !== '') {
      params.append(key, value)
    }
  }
  const serialized = params.toString()
  if (!serialized) {
    return url
  }
  return `${url}${url.includes('?') ? '&' : '?'}${serialized}`
}

/**
 * 完整端点 URL。
 * - 默认：归一化 base + 协议路径
 * - endpointTemplate：模板替换 {base}/{model}/{protocol}/{path}，忽略默认拼接
 * - profile.query：显式追加（Azure api-version 等）
 */
export const buildEndpointUrl = (
  profile: ProviderProfile,
  protocol: Protocol = profile.protocol
): string => {
  const base = resolveBaseUrl(profile)
  const path = PROTOCOL_PATHS[protocol]
  const template = profile.endpointTemplate
  const url = template
    ? template
        .replaceAll('{base}', base)
        .replaceAll('{model}', profile.model)
        .replaceAll('{protocol}', protocol)
        .replaceAll('{path}', path)
    : `${base}${path}`
  return appendQuery(url, profile.query)
}

/** 校验 / 预热用 URL：{base}/models（Anthropic 官方也支持） */
export const buildModelsUrl = (profile: ProviderProfile): string =>
  appendQuery(`${resolveBaseUrl(profile)}${MODELS_PATH}`, profile.query)
