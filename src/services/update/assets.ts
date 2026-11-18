/**
 * Release 资产选择：按平台 + 构建渠道挑出要下载的安装包。
 *
 * 命名来自 electron-builder 的 artifactName 与 build-mobile.ps1 / CI：
 * - Windows: aurora-chat-<ver>-win-x64.exe（NSIS；zip 是便携包，不作为一键安装）
 * - Linux:   aurora-chat-<ver>-linux-x86_64.AppImage
 * - macOS:   aurora-chat-<ver>-mac-x64.dmg（预留）
 * - Android: aurora-chat-<ver>-debug.apk / aurora-chat-<ver>-release.apk
 *
 * APK 必须按渠道选：debug 安装的包只能被同签名 debug 包覆盖，反之亦然。
 */

/** 构建渠道：dev（开发）/ debug（Android 调试签名）/ release（正式签名） */
export type UpdateChannel = 'dev' | 'debug' | 'release'

/** 资产选择用的平台归类（不是运行平台名字符串） */
export type UpdatePlatformKind = 'windows' | 'linux' | 'macos' | 'android' | 'web'

export type ReleaseAsset = {
  name: string
  /** 字节数；GitHub API 的 size */
  size: number
  contentType: string
  /** 规范化的 https GitHub 下载地址（见 github.ts） */
  downloadUrl: string
}

export type AssetSelection = {
  platform: UpdatePlatformKind
  channel: UpdateChannel
}

/** 单个安装包下载上限：防止被超大资产拖死 */
export const MAX_DOWNLOAD_BYTES = 300 * 1024 * 1024

type AssetMatcher = {
  /** 越具体优先级越高 */
  score: number
  pattern: RegExp
}

const ANDROID_DEBUG: AssetMatcher[] = [
  { score: 100, pattern: /-debug\.apk$/i },
  // 本地 build-mobile.ps1 的产物名（不带版本号）
  { score: 90, pattern: /(?:^|-)debug\.apk$/i },
]

const ANDROID_RELEASE: AssetMatcher[] = [
  { score: 100, pattern: /-release\.apk$/i },
  { score: 90, pattern: /(?:^|-)release\.apk$/i },
]

const WINDOWS: AssetMatcher[] = [
  { score: 120, pattern: /-win-x64\.exe$/i },
  { score: 110, pattern: /-win-arm64\.exe$/i },
  { score: 100, pattern: /-win-ia32\.exe$/i },
  // 兜底：任何 Windows NSIS 安装器
  { score: 60, pattern: /win.*\.exe$/i },
]

const LINUX: AssetMatcher[] = [
  { score: 120, pattern: /-linux-x86_64\.AppImage$/i },
  { score: 110, pattern: /-linux-x64\.AppImage$/i },
  { score: 100, pattern: /-linux-amd64\.AppImage$/i },
  { score: 60, pattern: /\.AppImage$/i },
]

const MACOS: AssetMatcher[] = [
  { score: 120, pattern: /-mac-x64\.dmg$/i },
  { score: 110, pattern: /-mac-arm64\.dmg$/i },
  { score: 100, pattern: /-mac-universal\.dmg$/i },
  { score: 60, pattern: /\.dmg$/i },
]

const matchersFor = (selection: AssetSelection): AssetMatcher[] => {
  switch (selection.platform) {
    case 'windows':
      return WINDOWS
    case 'linux':
      return LINUX
    case 'macos':
      return MACOS
    case 'android':
      return selection.channel === 'release' ? ANDROID_RELEASE : ANDROID_DEBUG
    case 'web':
      return []
  }
}

/**
 * 选出要下载的资产；没有匹配项返回 null（UI 提示去 Release 页面手动下载）。
 * 资产列表按 API 顺序稳定排序，同分取靠前者。
 */
export const pickAsset = (
  assets: ReadonlyArray<ReleaseAsset>,
  selection: AssetSelection
): ReleaseAsset | null => {
  const matchers = matchersFor(selection)
  if (matchers.length === 0) {
    return null
  }
  let best: { asset: ReleaseAsset; score: number } | null = null
  for (const asset of assets) {
    for (const matcher of matchers) {
      if (!matcher.pattern.test(asset.name)) {
        continue
      }
      if (!best || matcher.score > best.score) {
        best = { asset, score: matcher.score }
      }
      break
    }
  }
  return best ? best.asset : null
}

/** 下载大小是否超过上限 */
export const isWithinDownloadLimit = (bytes: number): boolean =>
  Number.isFinite(bytes) && bytes > 0 && bytes <= MAX_DOWNLOAD_BYTES

/** 人类可读大小（设置页展示用） */
export const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '—'
  }
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const digits = value >= 100 || unit === 0 ? 0 : 1
  return `${value.toFixed(digits)} ${units[unit]}`
}
