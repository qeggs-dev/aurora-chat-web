declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}

declare module '*.css' {}

/** 公开 API 的地址，见 rspack.config.ts 的 createConfig */
declare const __API_ORIGIN__: string

/** 构建渠道：dev（开发）/ debug（Android 调试包）/ release（正式包），见 rspack.config.ts */
declare const __APP_CHANNEL__: 'dev' | 'debug' | 'release'

/** Prism 语言包通过副作用注册到全局 Prism */
declare module 'prismjs/components/*' {}

/** KaTeX 化学公式扩展通过副作用注册到 KaTeX */
declare module 'katex/contrib/mhchem' {}

/** 经 rspack `asset/resource` 输出的 wasm 资产，import 得到的是可 fetch 的 URL */
declare module '*.png' {
  const url: string
  export default url
}

declare module '*.wasm' {
  const url: string
  export default url
}

/** 经 rspack `asset/resource` 输出的内置样式包 zip，import 得到的是可 fetch 的 URL */
declare module '*.zip' {
  const url: string
  export default url
}

/** 更新下载进度（桌面主进程 / Android 插件通过事件回报） */
type AuroraUpdateProgress = {
  received: number
  total: number | null
  percent: number | null
}

/** 桌面主进程的一次匿名 GET 结果（release API / 镜像） */
type AuroraDesktopFetchResult = {
  status: number
  text: string
  contentType: string
  rateLimitRemaining?: string | null
  retryAfter?: string | null
}

/** 桌面主进程的下载结果 */
type AuroraDesktopDownloadResult =
  | { ok: true; path: string; bytes: number }
  | { ok: false; code: string; message?: string }

/** 桌面主进程的安装结果 */
type AuroraDesktopInstallResult =
  | {
      ok: true
      kind: 'installer-launched' | 'appimage-ready' | 'release-page'
      path?: string
    }
  | { ok: false; code: string; message?: string }

/**
 * preload 暴露的桌面更新桥（contextIsolation，只走 IPC）。
 * 渲染进程不传路径、不执行命令；下载路径与安装动作由主进程决定。
 */
interface AuroraUpdateBridge {
  platform: string
  fetchRelease(url: string): Promise<AuroraDesktopFetchResult>
  download(request: {
    candidates: string[]
    fileName: string
    expectedSize: number
  }): Promise<AuroraDesktopDownloadResult>
  cancelDownload(): Promise<{ cancelled: boolean }>
  install(): Promise<AuroraDesktopInstallResult>
  openRelease(url: string): Promise<{ ok: boolean }>
  onDownloadProgress(listener: (progress: AuroraUpdateProgress) => void): () => void
}

/**
 * Android 原生插件（UpdateInstallerPlugin）的 JS 代理。
 * 只经由 Capacitor 桥调用，不直接触碰文件系统。
 */
interface AuroraAndroidPlugin {
  downloadApk(options: {
    candidates: string[]
    fileName: string
    expectedSize: number
  }): Promise<{ path: string; bytes: number }>
  installApk(options: { path: string }): Promise<{ opened: boolean }>
  cancelDownload(): Promise<void>
  getBuildInfo(): Promise<{ debug: boolean; versionName: string; installPermission: boolean }>
  nativeFetch(options: { url: string }): Promise<AuroraDesktopFetchResult>
  addListener(
    event: 'downloadProgress',
    listener: (progress: { received: number; total: number | null; percent: number | null }) => void
  ): Promise<{ remove(): Promise<void> }> | { remove(): Promise<void> }
}

/** Capacitor 注入到 WebView 的全局对象（只声明用到的部分） */
interface AuroraCapacitorGlobal {
  isNativePlatform?: () => boolean
  getPlatform?: () => string
  /** Capacitor 8 的插件访问方式 */
  withPlugin?: (name: string) => unknown
  registerPlugin?: (name: string) => unknown
  Plugins?: Record<string, unknown>
}

interface Window {
  auroraUpdate?: AuroraUpdateBridge
  Capacitor?: AuroraCapacitorGlobal
}
