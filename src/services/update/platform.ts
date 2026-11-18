/**
 * 平台适配层：把「查更新 / 下载 / 安装 / 打开 Release 页面」抽象成统一环境，
 * 由 store 驱动。三端实现：
 * - desktop：preload 暴露的 `window.auroraUpdate`（只用 IPC；下载/安装都在主进程）
 * - android：Capacitor 原生插件 UpdateInstaller（原生下载 + ACTION_VIEW 安装器）
 * - web：只读 API + 打开 Release 页面
 *
 * 安全约束：
 * - 渲染进程不传本地路径、不执行任何命令；桌面下载路径由主进程计算，Android 插件只认自己的 cache 目录；
 * - 请求只允许 https 的 GitHub 官方域名与代码内镜像白名单，且始终匿名（不带 Authorization / Cookie）。
 */

import {
  formatBytes as formatAssetBytes,
  MAX_DOWNLOAD_BYTES,
  pickAsset,
  type ReleaseAsset,
  type UpdateChannel,
  type UpdatePlatformKind,
} from './assets.js'
import {
  browserFetch,
  toUpdateError,
  UpdateError,
  type FetchLike,
  type FetchResponseLike,
  type UpdateErrorCode,
} from './github.js'
import { readApplicationVersion } from './version.js'

export type UpdateRuntime = 'desktop' | 'android' | 'web'

/** 下载进度（percent 0–100；总大小未知时为 null） */
export type UpdateProgress = {
  received: number
  total: number | null
  percent: number | null
}

export type InstallKind =
  | 'installer-launched'
  | 'appimage-ready'
  | 'apk-installer-opened'
  | 'release-page'

export type InstallOutcome = { kind: InstallKind; path?: string }

export type StorageLike = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export type UpdateEnvironment = {
  runtime: UpdateRuntime
  /** 资产选择用的平台归类 */
  assetPlatform: UpdatePlatformKind
  now(): number
  readCurrentVersion(): string
  /** 构建渠道：Android 读原生 BuildConfig.DEBUG，其它读 rspack 注入的 __APP_CHANNEL__ */
  resolveChannel(): Promise<UpdateChannel>
  /** 一次匿名 GET（可能会由主进程 / 原生插件执行，绕开 CORS） */
  transport: FetchLike
  download(
    asset: ReleaseAsset,
    candidates: ReadonlyArray<string>,
    onProgress: (progress: UpdateProgress) => void
  ): Promise<{ path: string | null }>
  install(asset: ReleaseAsset, path: string | null): Promise<InstallOutcome>
  cancelDownload(): Promise<void>
  openRelease(url: string): void
  storage: StorageLike | null
}

const KNOWN_ERROR_CODES: ReadonlyArray<UpdateErrorCode> = [
  'network',
  'timeout',
  'rate-limit',
  'forbidden',
  'no-release',
  'server',
  'invalid-response',
  'no-asset',
  'too-large',
  'size-mismatch',
  'cancelled',
  'permission',
  'unsupported',
  'download-failed',
]

/** 把原生/主进程返回的错误码映射成已知分类，未知的一律按 download-failed */
const toErrorCode = (raw: string | null | undefined): UpdateErrorCode => {
  if (raw && (KNOWN_ERROR_CODES as ReadonlyArray<string>).includes(raw)) {
    return raw as UpdateErrorCode
  }
  return 'download-failed'
}

const toProgress = (received: number, total: number | null): UpdateProgress => {
  const safeReceived = Number.isFinite(received) && received >= 0 ? received : 0
  const safeTotal = total !== null && Number.isFinite(total) && total > 0 ? total : null
  const percent =
    safeTotal === null ? null : Math.min(100, Math.max(0, Math.round((safeReceived / safeTotal) * 100)))
  return { received: safeReceived, total: safeTotal, percent }
}

const safeStorage = (): StorageLike | null => {
  try {
    if (typeof localStorage === 'undefined') {
      return null
    }
    // 先探测一次，隐私模式等场景会抛错
    localStorage.getItem('aurora-chat:update-probe')
    return localStorage
  } catch {
    return null
  }
}

const readInjectedChannel = (): UpdateChannel => {
  try {
    const channel: unknown = __APP_CHANNEL__
    return channel === 'debug' || channel === 'release' || channel === 'dev' ? channel : 'dev'
  } catch {
    // node:test / 未注入环境
    return 'dev'
  }
}

const getCapacitor = (): AuroraCapacitorGlobal | null => {
  if (typeof window === 'undefined') {
    return null
  }
  return window.Capacitor ?? null
}

/** 取 Android 原生插件代理；插件缺失（旧版 APK）返回 null */
export const getAndroidPlugin = (): AuroraAndroidPlugin | null => {
  const capacitor = getCapacitor()
  if (!capacitor) {
    return null
  }
  // Capacitor 8 里 `window.Capacitor.Plugins` 仍是可用的插件注册表（registerPlugin / withPlugin
  // 在该版本返回的不是可直接调用的代理）：按「注册表 → registerPlugin → withPlugin」顺序探测，
  // 只接受带 downloadApk 方法的对象。
  const candidates: unknown[] = [capacitor.Plugins?.UpdateInstaller]
  if (typeof capacitor.registerPlugin === 'function') {
    try {
      candidates.push(capacitor.registerPlugin('UpdateInstaller'))
    } catch {
      // 旧桥接可能抛错
    }
  }
  if (typeof capacitor.withPlugin === 'function') {
    try {
      candidates.push(capacitor.withPlugin('UpdateInstaller'))
    } catch {
      // 新版 API 取不到插件时忽略
    }
  }
  for (const candidate of candidates) {
    if (candidate && typeof candidate === 'object' && typeof (candidate as AuroraAndroidPlugin).downloadApk === 'function') {
      return candidate as AuroraAndroidPlugin
    }
  }
  return null
}

let androidBuildInfo: Promise<{ debug: boolean; versionName: string }> | null = null

const readAndroidBuildInfo = (): Promise<{ debug: boolean; versionName: string }> => {
  const plugin = getAndroidPlugin()
  if (!plugin) {
    return Promise.resolve({ debug: false, versionName: '' })
  }
  if (!androidBuildInfo) {
    androidBuildInfo = plugin
      .getBuildInfo()
      .then((info) => ({
        debug: info.debug === true,
        versionName: typeof info.versionName === 'string' ? info.versionName : '',
      }))
      .catch(() => ({ debug: false, versionName: '' }))
  }
  return androidBuildInfo
}

/** 运行环境判定：桌面壳（preload 桥）→ Android（Capacitor 原生）→ 普通 web */
export const detectUpdateRuntime = (): UpdateRuntime => {
  if (typeof window === 'undefined') {
    return 'web'
  }
  if (window.auroraUpdate) {
    return 'desktop'
  }
  const capacitor = getCapacitor()
  if (!capacitor) {
    return 'web'
  }
  const native =
    typeof capacitor.isNativePlatform === 'function'
      ? capacitor.isNativePlatform()
      : typeof capacitor.getPlatform === 'function'
        ? capacitor.getPlatform() !== 'web'
        : false
  return native ? 'android' : 'web'
}

const assetPlatformFor = (runtime: UpdateRuntime, desktopPlatform: string): UpdatePlatformKind => {
  if (runtime === 'android') {
    return 'android'
  }
  if (runtime !== 'desktop') {
    return 'web'
  }
  switch (desktopPlatform) {
    case 'win32':
      return 'windows'
    case 'linux':
      return 'linux'
    case 'darwin':
      return 'macos'
    default:
      return 'web'
  }
}

/** 打开 Release 页面：Android 用系统浏览器，其它端新窗口 */
const openExternalPage = (url: string, runtime: UpdateRuntime): void => {
  if (!/^https:\/\/github\.com\//.test(url)) {
    return
  }
  if (typeof window === 'undefined') {
    return
  }
  window.open(url, runtime === 'android' ? '_system' : '_blank', 'noopener,noreferrer')
}

const desktopEnvironment = (bridge: AuroraUpdateBridge): UpdateEnvironment => ({
  runtime: 'desktop',
  assetPlatform: assetPlatformFor('desktop', bridge.platform),
  now: () => Date.now(),
  readCurrentVersion: readApplicationVersion,
  resolveChannel: () => Promise.resolve(readInjectedChannel()),
  transport: async (url): Promise<FetchResponseLike> => {
    try {
      const result = await bridge.fetchRelease(url)
      return {
        status: result.status,
        text: result.text,
        contentType: result.contentType,
        headers: {
          rateLimitRemaining: result.rateLimitRemaining ?? null,
          retryAfter: result.retryAfter ?? null,
        },
      }
    } catch (error) {
      // 主进程只对传输/URL 校验失败抛错，HTTP 状态码照常返回
      throw toUpdateError(error)
    }
  },
  download: async (asset, candidates, onProgress) => {
    const unsubscribe = bridge.onDownloadProgress((progress) => {
      onProgress(toProgress(progress.received, progress.total))
    })
    try {
      const result = await bridge.download({
        candidates: [...candidates],
        fileName: asset.name,
        expectedSize: asset.size,
      })
      if (!result.ok) {
        throw new UpdateError(toErrorCode(result.code), result.message)
      }
      return { path: result.path }
    } finally {
      unsubscribe()
    }
  },
  install: async () => {
    const result = await bridge.install()
    if (!result.ok) {
      throw new UpdateError(toErrorCode(result.code), result.message)
    }
    return { kind: result.kind, path: result.path }
  },
  cancelDownload: async () => {
    await bridge.cancelDownload()
  },
  openRelease: (url) => {
    void bridge.openRelease(url)
  },
  storage: safeStorage(),
})

const androidEnvironment = (): UpdateEnvironment => ({
  runtime: 'android',
  assetPlatform: 'android',
  now: () => Date.now(),
  readCurrentVersion: readApplicationVersion,
  resolveChannel: async () => {
    // 原生 BuildConfig.DEBUG 比 web 包里注入的渠道更可靠（CI 的 APK 永远是 debug 渠道）
    const info = await readAndroidBuildInfo()
    if (info.versionName || info.debug) {
      return info.debug ? 'debug' : 'release'
    }
    return readInjectedChannel()
  },
  transport: async (url, _init): Promise<FetchResponseLike> => {
    const plugin = getAndroidPlugin()
    if (!plugin) {
      return browserFetch(url, _init)
    }
    try {
      const result = await plugin.nativeFetch({ url })
      return {
        status: result.status,
        text: result.text,
        contentType: result.contentType,
        headers: {
          rateLimitRemaining: result.rateLimitRemaining ?? null,
          retryAfter: result.retryAfter ?? null,
        },
      }
    } catch (error) {
      throw toUpdateError(error)
    }
  },
  download: async (asset, candidates, onProgress) => {
    const plugin = getAndroidPlugin()
    if (!plugin) {
      throw new UpdateError('unsupported', 'UpdateInstaller plugin is missing')
    }
    const handle = await plugin.addListener('downloadProgress', (progress) => {
      onProgress(toProgress(progress.received, progress.total))
    })
    try {
      const result = await plugin.downloadApk({
        candidates: [...candidates],
        fileName: asset.name,
        expectedSize: asset.size,
      })
      const path = typeof result.path === 'string' ? result.path : ''
      if (!path) {
        throw new UpdateError('download-failed', 'android plugin returned no path')
      }
      return { path }
    } catch (error) {
      throw toUpdateError(error)
    } finally {
      try {
        await handle.remove()
      } catch {
        // 监听清理失败不影响结果
      }
    }
  },
  install: async (_asset, path) => {
    const plugin = getAndroidPlugin()
    if (!plugin) {
      throw new UpdateError('unsupported', 'UpdateInstaller plugin is missing')
    }
    if (!path) {
      throw new UpdateError('download-failed', 'apk path is missing')
    }
    try {
      await plugin.installApk({ path })
      return { kind: 'apk-installer-opened', path }
    } catch (error) {
      throw toUpdateError(error)
    }
  },
  cancelDownload: async () => {
    const plugin = getAndroidPlugin()
    if (plugin) {
      await plugin.cancelDownload()
    }
  },
  openRelease: (url) => openExternalPage(url, 'android'),
  storage: safeStorage(),
})

const webEnvironment = (): UpdateEnvironment => ({
  runtime: 'web',
  assetPlatform: 'web',
  now: () => Date.now(),
  readCurrentVersion: readApplicationVersion,
  resolveChannel: () => Promise.resolve(readInjectedChannel()),
  transport: browserFetch,
  download: async () => {
    throw new UpdateError('unsupported', 'web build does not download installers')
  },
  install: async () => {
    throw new UpdateError('unsupported', 'web build does not install updates')
  },
  cancelDownload: async () => {},
  openRelease: (url) => openExternalPage(url, 'web'),
  storage: safeStorage(),
})

/** 按当前运行环境创建默认更新环境（store 单例用；测试可传自己的实现） */
export const createDefaultUpdateEnvironment = (): UpdateEnvironment => {
  const runtime = detectUpdateRuntime()
  if (runtime === 'desktop' && typeof window !== 'undefined' && window.auroraUpdate) {
    return desktopEnvironment(window.auroraUpdate)
  }
  if (runtime === 'android') {
    return androidEnvironment()
  }
  return webEnvironment()
}

/** 当前平台的下载体积上限提示（UI 用） */
export const maxDownloadLabel = (): string => formatAssetBytes(MAX_DOWNLOAD_BYTES)

/** 资产是否可以在当前平台一键下载安装 */
export const canAutoInstall = (runtime: UpdateRuntime): boolean => runtime !== 'web'

/** 便捷重导出：页面/测试里选资产不必再从 assets.ts 引 */
export { pickAsset, MAX_DOWNLOAD_BYTES }
export type { ReleaseAsset, UpdateChannel, UpdatePlatformKind }
