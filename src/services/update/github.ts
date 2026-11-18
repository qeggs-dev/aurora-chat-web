/**
 * GitHub Release 读取与资产地址规范化。
 *
 * 网络策略（重要）：
 * 1. 优先直连 `https://api.github.com/...`，失败（网络错误 / 超时 / 403 限流 / 5xx）再按顺序尝试镜像；
 * 2. 镜像只用于「匿名 GET 公开内容」：release 元数据、安装包下载。请求头只带 Accept / User-Agent，
 *    **绝不**携带 Authorization、Cookie、token 等任何凭据；镜像也不得用于 push 或任何写操作；
 * 3. 只允许 https，镜像域名是代码内常量白名单（不从远端读取）；
 * 4. 镜像返回的内容做校验：非 JSON、HTML 错误页、大小不符都视为失败继续下一个候选。
 *
 * 资产下载地址不直接信任 API 响应（镜像会改写域名）：优先取规范 github.com 地址，
 * 否则用 tag + 文件名重建，确保下载只指向 GitHub 官方域名；镜像地址只在下载重试时由
 * `downloadCandidates()` 构造。
 */

import type { ReleaseAsset } from './assets.js'

export const GITHUB_OWNER = 'qeggs-dev'
export const GITHUB_REPO = 'aurora-chat-app'
export const GITHUB_API_BASE = 'https://api.github.com'
export const GITHUB_WEB_BASE = 'https://github.com'
export const GITHUB_LATEST_RELEASE_URL = `${GITHUB_API_BASE}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`
export const GITHUB_RELEASES_PAGE = `${GITHUB_WEB_BASE}/${GITHUB_OWNER}/${GITHUB_REPO}/releases`
export const GITHUB_DOWNLOAD_BASE = `${GITHUB_RELEASES_PAGE}/download`

/**
 * 匿名内容镜像（前缀 + 完整 GitHub URL）。只允许 GET 公开资源，禁止携带凭据。
 * 顺序按实测可用性排列（2026-11-18 实测：gh-proxy.com / gh-proxy.org / github.xxlab.tech /
 * githubproxy.gohj99.site / github.chenc.dev 可直出资产；fastgit.cc 404、gh.noki.icu 503、
 * cors.isteed.cc 有 Cloudflare 挑战，放在后面兜底）。直连永远排在最前。
 * 修改顺序时同步 desktop/main.js 与 mobile 的 UpdateInstallerPlugin.java。
 */
export const GITHUB_MIRRORS: ReadonlyArray<string> = [
  'https://gh-proxy.com',
  'https://gh-proxy.org',
  'https://github.xxlab.tech',
  'https://githubproxy.gohj99.site',
  'https://github.chenc.dev',
  'https://cors.isteed.cc',
  'https://fastgit.cc',
  'https://gh.noki.icu',
  'https://ghproxy.net',
  'https://ghfast.top',
]

/** 允许被镜像的 GitHub 内容域名（https）；资产下载也只允许这些官方域名 */
export const GITHUB_CONTENT_HOSTS: ReadonlyArray<string> = [
  'github.com',
  'api.github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
]

/** 单次请求超时；镜像慢就换下一个 */
export const REQUEST_TIMEOUT_MS = 8000
/** Release JSON / 错误页体积上限 */
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
/** Release notes 最多展示的字符数，避免超长正文拖慢渲染 */
export const MAX_NOTES_LENGTH = 20000

export type UpdateErrorCode =
  | 'network'
  | 'timeout'
  | 'rate-limit'
  | 'forbidden'
  | 'no-release'
  | 'server'
  | 'invalid-response'
  | 'no-asset'
  | 'too-large'
  | 'size-mismatch'
  | 'cancelled'
  | 'permission'
  | 'unsupported'
  | 'download-failed'

export type UpdateErrorDetails = {
  /** 触发错误的候选地址（便于排查是直连还是镜像失败） */
  url?: string
  status?: number
  /** GitHub 限流时的剩余/重置时间 */
  retryAfter?: number
}

export class UpdateError extends Error {
  readonly code: UpdateErrorCode
  readonly details: UpdateErrorDetails

  constructor(code: UpdateErrorCode, message?: string, details: UpdateErrorDetails = {}) {
    super(message ?? code)
    this.name = 'UpdateError'
    this.code = code
    this.details = details
  }
}

/** 把任意异常归一成 UpdateError；已经是 UpdateError 的原样返回 */
export const toUpdateError = (error: unknown): UpdateError => {
  if (error instanceof UpdateError) {
    return error
  }
  if (error instanceof Error) {
    if (error.name === 'AbortError') {
      return new UpdateError('timeout', error.message)
    }
    return new UpdateError('network', error.message)
  }
  return new UpdateError('network', String(error))
}

export type ReleaseInfo = {
  /** 去掉 v 前缀的版本号 */
  version: string
  tagName: string
  title: string
  publishedAt: string | null
  notes: string
  /** 规范化后的 Release 页面地址（github.com） */
  htmlUrl: string
  assets: ReleaseAsset[]
}

/** 一次匿名 GET 的返回；桌面端由主进程实现，Android 由原生插件实现 */
export type FetchResponseLike = {
  status: number
  /** 响应体文本（Release JSON 或错误页） */
  text: string
  /** Content-Type，用于识别镜像错误页 */
  contentType: string
  /** 响应头（只取大小写不敏感的几个限流字段） */
  headers?: {
    rateLimitRemaining?: string | null
    retryAfter?: string | null
  }
}

export type FetchInit = {
  headers: Record<string, string>
  /** 匿名请求：不带任何凭据 */
  credentials: 'omit'
  signal?: AbortSignal
}

/** 平台注入的「一次 GET」实现；出错时抛异常 */
export type FetchLike = (url: string, init: FetchInit) => Promise<FetchResponseLike>

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0

/** https + 官方 GitHub 内容域名；URL 里不允许夹带凭据 */
export const isAllowedGithubContentUrl = (url: string): boolean => {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:') {
      return false
    }
    if (parsed.username || parsed.password) {
      return false
    }
    if (parsed.port && parsed.port !== '443') {
      return false
    }
    return GITHUB_CONTENT_HOSTS.includes(parsed.hostname)
  } catch {
    return false
  }
}

/** 镜像域名白名单内的 https 前缀 */
export const isAllowedMirrorOrigin = (url: string, base: string): boolean => {
  const normalized = base.endsWith('/') ? base.slice(0, -1) : base
  return url.startsWith(`${normalized}/https://`) && url.length > normalized.length + 9
}

/**
 * 构造镜像候选：只有官方 GitHub https 地址才允许加镜像前缀。
 * 返回顺序为「直连 → 镜像列表」，调用方依次尝试。
 */
export const requestCandidates = (url: string): string[] => {
  if (!isAllowedGithubContentUrl(url)) {
    return []
  }
  return [url, ...GITHUB_MIRRORS.map((mirror) => `${mirror}/${url}`)]
}

/** 资产下载候选地址（直连 + 匿名镜像），供桌面主进程 / Android 插件依次尝试 */
export const downloadCandidates = (asset: ReleaseAsset): string[] =>
  requestCandidates(asset.downloadUrl)

const SAFE_ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,180}$/
const SAFE_TAG = /^[vV]?[0-9A-Za-z._-]{1,64}$/

/** 由 tag + 资产名重建规范下载地址（镜像返回的 browser_download_url 会被改写） */
const canonicalDownloadUrl = (tagName: string, name: string): string =>
  `${GITHUB_DOWNLOAD_BASE}/${tagName}/${name}`

const normalizeAssetUrl = (raw: unknown, tagName: string, name: string): string => {
  if (isNonEmptyString(raw) && isAllowedGithubContentUrl(raw)) {
    const parsed = new URL(raw)
    const expectedPrefix = `/${GITHUB_OWNER}/${GITHUB_REPO}/releases/download/`
    if (parsed.hostname === 'github.com' && parsed.pathname.startsWith(expectedPrefix)) {
      return raw
    }
  }
  return canonicalDownloadUrl(tagName, name)
}

/**
 * 解析 GitHub Release 响应（纯函数，便于单测）。
 * 字段缺失/类型不对时抛 UpdateError('invalid-response')。
 */
export const parseReleasePayload = (payload: unknown): ReleaseInfo => {
  if (!isPlainObject(payload)) {
    throw new UpdateError('invalid-response', 'release payload is not an object')
  }
  const tagName = payload.tag_name
  if (!isNonEmptyString(tagName) || !SAFE_TAG.test(tagName)) {
    throw new UpdateError('invalid-response', 'release tag_name is missing or unsafe')
  }
  const version = tagName.replace(/^[vV]/, '')
  const rawAssets = payload.assets
  if (!Array.isArray(rawAssets)) {
    throw new UpdateError('invalid-response', 'release assets is not an array')
  }
  const assets: ReleaseAsset[] = []
  for (const item of rawAssets) {
    if (!isPlainObject(item)) {
      continue
    }
    const name = item.name
    const size = item.size
    if (!isNonEmptyString(name) || !SAFE_ASSET_NAME.test(name)) {
      continue
    }
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0) {
      continue
    }
    const contentType = isNonEmptyString(item.content_type) ? item.content_type : ''
    assets.push({
      name,
      size,
      contentType,
      downloadUrl: normalizeAssetUrl(item.browser_download_url, tagName, name),
    })
  }
  if (assets.length === 0) {
    throw new UpdateError('no-asset', 'release has no downloadable assets')
  }
  const publishedAt =
    isNonEmptyString(payload.published_at) && !Number.isNaN(Date.parse(payload.published_at))
      ? payload.published_at
      : null
  const notes = typeof payload.body === 'string' ? payload.body.slice(0, MAX_NOTES_LENGTH) : ''
  const title = isNonEmptyString(payload.name) ? payload.name : tagName
  const htmlUrl = `${GITHUB_RELEASES_PAGE}/tag/${encodeURIComponent(tagName)}`
  return { version, tagName, title, publishedAt, notes, htmlUrl, assets }
}

const headerValue = (headers: Headers | undefined, name: string): string | null => {
  if (!headers) {
    return null
  }
  try {
    return headers.get(name)
  } catch {
    return null
  }
}

/** 把浏览器/原生响应归一成 FetchResponseLike；主体超限直接判失败 */
const toResponseLike = async (response: Response): Promise<FetchResponseLike> => {
  const contentType = response.headers.get('content-type') ?? ''
  const text = await response.text()
  if (text.length > MAX_RESPONSE_BYTES) {
    throw new UpdateError('invalid-response', 'response too large')
  }
  const retryAfter = response.headers.get('retry-after')
  return {
    status: response.status,
    text,
    contentType,
    headers: {
      rateLimitRemaining: headerValue(response.headers, 'x-ratelimit-remaining'),
      retryAfter,
    },
  }
}

/** 浏览器 / 无原生插件的环境（web、旧版壳）用 window.fetch */
export const browserFetch: FetchLike = async (url, init) => {
  const response = await fetch(url, {
    method: 'GET',
    headers: init.headers,
    credentials: init.credentials,
    signal: init.signal,
  })
  return toResponseLike(response)
}

const ATTEMPT_HEADERS: Record<string, string> = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
}

const withTimeout = async (
  run: (signal: AbortSignal) => Promise<FetchResponseLike>,
  timeoutMs: number
): Promise<FetchResponseLike> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await run(controller.signal)
  } finally {
    clearTimeout(timer)
  }
}

const looksLikeJson = (response: FetchResponseLike): boolean => {
  const contentType = response.contentType.toLowerCase()
  if (contentType.includes('json')) {
    return true
  }
  const head = response.text.trimStart()
  // 部分镜像不带 Content-Type（或带 text/plain），用首字符兜底识别
  return head.startsWith('{') || head.startsWith('[')
}

const looksLikeHtml = (response: FetchResponseLike): boolean =>
  response.contentType.toLowerCase().includes('html') ||
  /^\s*(?:<!doctype html|<html)/i.test(response.text)

export type FetchReleaseOptions = {
  transport: FetchLike
  timeoutMs?: number
  /** 测试注入：直接给候选列表，跳过默认「直连 + 镜像」顺序 */
  candidates?: ReadonlyArray<string>
}

/**
 * 拉取 latest release：依次尝试直连与镜像，返回解析后的 ReleaseInfo。
 * 失败时抛 UpdateError，code 取最有信息量的那个（限流 > 超时/网络 > 服务端）。
 */
export const fetchLatestRelease = async ({
  transport,
  timeoutMs = REQUEST_TIMEOUT_MS,
  candidates = requestCandidates(GITHUB_LATEST_RELEASE_URL),
}: FetchReleaseOptions): Promise<ReleaseInfo> => {
  if (candidates.length === 0) {
    throw new UpdateError('invalid-response', 'no request candidate')
  }
  let lastError: UpdateError = new UpdateError('network', 'no attempt succeeded')
  let sawRateLimit = false
  let sawServer = false

  for (const url of candidates) {
    let response: FetchResponseLike
    try {
      response = await withTimeout(
        (signal) =>
          transport(url, { headers: ATTEMPT_HEADERS, credentials: 'omit', signal }),
        timeoutMs
      )
    } catch (error) {
      lastError = toUpdateError(error)
      lastError.details.url = url
      if (lastError.code === 'network') {
        lastError = new UpdateError('network', lastError.message, { url })
      }
      // 超时/网络错误：换下一个候选（直连失败 → 镜像）
      continue
    }

    if (response.status === 404) {
      // 仓库或 release 不存在：换镜像也没有意义
      throw new UpdateError('no-release', 'latest release not found', { url, status: 404 })
    }
    if (response.status === 403 || response.status === 429) {
      sawRateLimit = true
      const retryAfter = Number(response.headers?.retryAfter)
      lastError = new UpdateError('rate-limit', 'github api rate limited', {
        url,
        status: response.status,
        retryAfter: Number.isFinite(retryAfter) ? retryAfter : undefined,
      })
      continue
    }
    if (response.status >= 500) {
      sawServer = true
      lastError = new UpdateError('server', 'github api server error', {
        url,
        status: response.status,
      })
      continue
    }
    if (response.status !== 200) {
      lastError = new UpdateError('forbidden', 'github api rejected the request', {
        url,
        status: response.status,
      })
      continue
    }
    if (looksLikeHtml(response)) {
      // 镜像错误页 / Cloudflare 挑战页
      lastError = new UpdateError('invalid-response', 'mirror returned html', {
        url,
        status: response.status,
      })
      continue
    }
    if (!looksLikeJson(response)) {
      lastError = new UpdateError('invalid-response', 'response is not json', {
        url,
        status: response.status,
      })
      continue
    }

    let payload: unknown
    try {
      payload = JSON.parse(response.text)
    } catch {
      lastError = new UpdateError('invalid-response', 'release json is malformed', {
        url,
        status: response.status,
      })
      continue
    }
    return parseReleasePayload(payload)
  }

  if (sawRateLimit) {
    throw lastError.code === 'rate-limit'
      ? lastError
      : new UpdateError('rate-limit', 'github api rate limited')
  }
  if (sawServer && lastError.code !== 'server') {
    return Promise.reject(new UpdateError('server', 'github api unavailable'))
  }
  throw lastError
}
