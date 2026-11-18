/**
 * 「检查更新」状态机 + 24h 缓存。
 *
 * 状态：idle → checking →（up-to-date | available | error）
 * available → downloading →（ready | available（取消）| error）
 *
 * 纯逻辑（缓存解析、TTL 判断、状态迁移）都通过 `createUpdateStore(env)` 注入环境，
 * 因此可以在 node:test 里用假 transport / 假下载器覆盖，不需要真实网络。
 */

import { create } from 'zustand'
import {
  isWithinDownloadLimit,
  pickAsset,
  type ReleaseAsset,
  type UpdateChannel,
} from './assets.js'
import {
  downloadCandidates,
  fetchLatestRelease,
  GITHUB_RELEASES_PAGE,
  isAllowedGithubContentUrl,
  toUpdateError,
  type ReleaseInfo,
  type UpdateErrorCode,
} from './github.js'
import {
  createDefaultUpdateEnvironment,
  type InstallOutcome,
  type UpdateEnvironment,
  type UpdateProgress,
  type UpdateRuntime,
} from './platform.js'
import { isNewerVersion } from './version.js'

export const UPDATE_CACHE_KEY = 'aurora-chat:update-cache'
/** 检查结果缓存 24h；手动检查忽略缓存 */
export const UPDATE_CACHE_TTL_MS = 24 * 60 * 60 * 1000

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'error'

export type UpdateErrorPhase = 'check' | 'download' | 'install'

export type UpdateErrorInfo = {
  code: UpdateErrorCode
  message?: string
  retryAfter?: number
  phase: UpdateErrorPhase
}

/** 缓存内容：检查时的应用版本 + 解析后的 Release */
export type UpdateCache = {
  checkedAt: number
  currentVersion: string
  release: ReleaseInfo
}

const ASSET_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,180}$/

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0

/** 缓存反序列化时的防御性校验：只接受结构完整、且下载地址仍指向 GitHub 官方的 Release */
export const parseCachedRelease = (value: unknown): ReleaseInfo | null => {
  if (!isRecord(value)) {
    return null
  }
  if (
    !isNonEmptyString(value.version) ||
    !isNonEmptyString(value.tagName) ||
    !isNonEmptyString(value.title) ||
    !isNonEmptyString(value.htmlUrl) ||
    !isAllowedGithubContentUrl(value.htmlUrl) ||
    typeof value.notes !== 'string' ||
    (value.publishedAt !== null && typeof value.publishedAt !== 'string') ||
    !Array.isArray(value.assets)
  ) {
    return null
  }
  const assets: ReleaseAsset[] = []
  for (const item of value.assets) {
    if (!isRecord(item)) {
      return null
    }
    if (
      !isNonEmptyString(item.name) ||
      !ASSET_NAME_PATTERN.test(item.name) ||
      typeof item.size !== 'number' ||
      !Number.isSafeInteger(item.size) ||
      item.size <= 0 ||
      typeof item.contentType !== 'string' ||
      !isNonEmptyString(item.downloadUrl) ||
      !isAllowedGithubContentUrl(item.downloadUrl)
    ) {
      return null
    }
    assets.push({
      name: item.name,
      size: item.size,
      contentType: item.contentType,
      downloadUrl: item.downloadUrl,
    })
  }
  if (assets.length === 0) {
    return null
  }
  return {
    version: value.version,
    tagName: value.tagName,
    title: value.title,
    notes: value.notes,
    publishedAt: value.publishedAt,
    htmlUrl: value.htmlUrl,
    assets,
  }
}

/** 缓存是否仍在 24h 有效期内 */
export const isCacheFresh = (
  cache: UpdateCache,
  now: number,
  ttlMs: number = UPDATE_CACHE_TTL_MS
): boolean => {
  if (!Number.isFinite(cache.checkedAt) || cache.checkedAt <= 0) {
    return false
  }
  const age = now - cache.checkedAt
  // 未来时间（系统时钟回拨）也视为过期，避免缓存永久有效
  return age >= 0 && age < ttlMs
}

/** 从 storage 读缓存；不存在 / 损坏 / 过期返回 null */
export const readUpdateCache = (
  storage: UpdateEnvironment['storage'],
  now: number,
  ttlMs: number = UPDATE_CACHE_TTL_MS
): UpdateCache | null => {
  if (!storage) {
    return null
  }
  let raw: string | null
  try {
    raw = storage.getItem(UPDATE_CACHE_KEY)
  } catch {
    return null
  }
  if (!raw) {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(parsed)) {
    return null
  }
  const checkedAt = typeof parsed.checkedAt === 'number' ? parsed.checkedAt : NaN
  const currentVersion = isNonEmptyString(parsed.currentVersion) ? parsed.currentVersion : ''
  if (!Number.isFinite(checkedAt) || !currentVersion) {
    return null
  }
  const release = parseCachedRelease(parsed.release)
  if (!release) {
    return null
  }
  const cache: UpdateCache = { checkedAt, currentVersion, release }
  return isCacheFresh(cache, now, ttlMs) ? cache : null
}

export const writeUpdateCache = (storage: UpdateEnvironment['storage'], cache: UpdateCache): void => {
  if (!storage) {
    return
  }
  try {
    storage.setItem(UPDATE_CACHE_KEY, JSON.stringify(cache))
  } catch {
    // 存储不可用时只是不缓存
  }
}

export type UpdateState = {
  status: UpdateStatus
  runtime: UpdateRuntime
  currentVersion: string
  release: ReleaseInfo | null
  asset: ReleaseAsset | null
  channel: UpdateChannel | null
  /** 检查结果是否来自 24h 缓存 */
  fromCache: boolean
  lastCheckedAt: number | null
  error: UpdateErrorInfo | null
  download: UpdateProgress | null
  install: InstallOutcome | null
  /** 自动检查已经 toast 过的版本，避免重复打扰 */
  notifiedVersion: string | null
  /** 用户点了「稍后」，小红点不再显示这个版本 */
  dismissedVersion: string | null
}

export type UpdateActions = {
  check(options?: { manual?: boolean }): Promise<void>
  downloadAndInstall(): Promise<void>
  cancelDownload(): Promise<void>
  openReleasePage(): void
  dismissAvailable(): void
  markNotified(version: string): void
  reset(): void
}

export type UpdateStore = UpdateState & UpdateActions

const INITIAL_STATE: UpdateState = {
  status: 'idle',
  runtime: 'web',
  currentVersion: '',
  release: null,
  asset: null,
  channel: null,
  fromCache: false,
  lastCheckedAt: null,
  error: null,
  download: null,
  install: null,
  notifiedVersion: null,
  dismissedVersion: null,
}

const errorInfo = (error: unknown, phase: UpdateErrorPhase): UpdateErrorInfo => {
  const normalized = toUpdateError(error)
  return {
    code: normalized.code,
    message: normalized.message,
    retryAfter: normalized.details.retryAfter,
    phase,
  }
}

/** 创建状态机；env 可替换（测试用假 transport / 假下载） */
export const createUpdateStore = (env: UpdateEnvironment) =>
  create<UpdateStore>((set, get) => ({
    ...INITIAL_STATE,
    runtime: env.runtime,
    currentVersion: env.readCurrentVersion(),

    check: async (options = {}) => {
      const manual = options.manual === true
      const state = get()
      if (state.status === 'checking' || state.status === 'downloading') {
        return
      }
      const currentVersion = env.readCurrentVersion()
      set({
        status: 'checking',
        currentVersion,
        error: null,
        install: null,
        download: null,
      })

      // 自动检查先看 24h 缓存；手动检查忽略缓存
      if (!manual) {
        const cached = readUpdateCache(env.storage, env.now())
        if (cached && cached.currentVersion === currentVersion) {
          const channel = await env.resolveChannel()
          const newer = isNewerVersion(cached.release.version, currentVersion)
          set({
            status: newer ? 'available' : 'up-to-date',
            release: cached.release,
            asset: newer
              ? pickAsset(cached.release.assets, { platform: env.assetPlatform, channel })
              : null,
            channel,
            fromCache: true,
            lastCheckedAt: cached.checkedAt,
            error: null,
            install: null,
            download: null,
          })
          return
        }
      }

      try {
        const release = await fetchLatestRelease({ transport: env.transport })
        const channel = await env.resolveChannel()
        const newer = isNewerVersion(release.version, currentVersion)
        const asset = newer
          ? pickAsset(release.assets, { platform: env.assetPlatform, channel })
          : null
        const checkedAt = env.now()
        writeUpdateCache(env.storage, { checkedAt, currentVersion, release })
        set({
          status: newer ? 'available' : 'up-to-date',
          release,
          asset,
          channel,
          fromCache: false,
          lastCheckedAt: checkedAt,
          error: null,
          install: null,
          download: null,
        })
      } catch (error) {
        set({
          status: 'error',
          release: null,
          asset: null,
          channel: null,
          fromCache: false,
          lastCheckedAt: env.now(),
          error: errorInfo(error, 'check'),
          install: null,
          download: null,
        })
      }
    },

    downloadAndInstall: async () => {
      const state = get()
      if (state.status === 'downloading' || state.status === 'checking') {
        return
      }
      const release = state.release
      if (!release) {
        return
      }
      // web 端没有本地安装能力：打开 Release 页面
      if (env.runtime === 'web') {
        env.openRelease(release.htmlUrl || GITHUB_RELEASES_PAGE)
        set({ status: 'ready', install: { kind: 'release-page' }, error: null, download: null })
        return
      }
      const channel = state.channel ?? (await env.resolveChannel())
      const asset =
        state.asset ?? pickAsset(release.assets, { platform: env.assetPlatform, channel })
      if (!asset) {
        set({
          status: 'error',
          channel,
          asset: null,
          error: { code: 'no-asset', phase: 'download' },
        })
        return
      }
      if (!isWithinDownloadLimit(asset.size)) {
        set({ status: 'error', channel, asset, error: { code: 'too-large', phase: 'download' } })
        return
      }
      set({
        status: 'downloading',
        channel,
        asset,
        error: null,
        install: null,
        download: { received: 0, total: asset.size, percent: 0 },
      })
      try {
        const candidates = downloadCandidates(asset)
        const { path } = await env.download(asset, candidates, (progress) => {
          if (get().status === 'downloading') {
            set({ download: progress })
          }
        })
        const outcome = await env.install(asset, path)
        set({
          status: 'ready',
          install: outcome,
          download: { received: asset.size, total: asset.size, percent: 100 },
        })
      } catch (error) {
        const normalized = toUpdateError(error)
        if (normalized.code === 'cancelled') {
          set({ status: 'available', download: null, error: null, install: null })
          return
        }
        const phase: UpdateErrorPhase =
          normalized.code === 'unsupported' || normalized.code === 'permission'
            ? 'install'
            : 'download'
        set({
          status: 'error',
          download: null,
          install: null,
          error: errorInfo(normalized, phase),
        })
      }
    },

    cancelDownload: async () => {
      if (get().status !== 'downloading') {
        return
      }
      try {
        await env.cancelDownload()
      } catch {
        // 取消失败就等下载自己结束
      }
    },

    openReleasePage: () => {
      const release = get().release
      env.openRelease(release?.htmlUrl || GITHUB_RELEASES_PAGE)
    },

    dismissAvailable: () => {
      const release = get().release
      if (!release) {
        return
      }
      set({ dismissedVersion: release.version })
    },

    markNotified: (version) => {
      set({ notifiedVersion: version })
    },

    reset: () => {
      set({ ...INITIAL_STATE, runtime: env.runtime, currentVersion: env.readCurrentVersion() })
    },
  }))

/** 应用内单例：按当前运行环境（桌面 / Android / web）创建 */
export const useUpdateStore = createUpdateStore(createDefaultUpdateEnvironment())

/** 小红点是否显示：有新版本且用户没点「稍后」 */
export const shouldShowUpdateBadge = (state: UpdateState): boolean =>
  state.status === 'available' &&
  state.release !== null &&
  state.dismissedVersion !== state.release.version
