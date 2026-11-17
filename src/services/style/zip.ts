/** 样式包 zip 的解析与校验：路径、大小、扩展名、清单字段与字符串安全边界都在这里把关。 */
import { unzipSync } from 'fflate'
import {
  PALETTE_KEYS,
  STYLE_ALIGNS,
  STYLE_FITS,
  STYLE_PREFIX,
  STYLE_RENDERS,
  isSafePosition,
} from './types.js'
import type {
  PaletteColors,
  StyleAlign,
  StyleAssetEntry,
  StyleFit,
  StyleManifest,
  StylePalette,
  StyleRender,
} from './types.js'

export type StylePackErrorCode =
  | 'tooLarge'
  | 'tooManyFiles'
  | 'notZip'
  | 'noIndex'
  | 'badIndex'
  | 'badConfig'
  | 'badPath'
  | 'missingFile'
  | 'badFileType'

export class StylePackError extends Error {
  constructor(
    public code: StylePackErrorCode,
    public detail?: string
  ) {
    super(detail ?? code)
    this.name = 'StylePackError'
  }
}

const MAX_ZIP_BYTES = 20 * 1024 * 1024
const MAX_TOTAL_BYTES = 60 * 1024 * 1024
const MAX_ENTRIES = 300
const MAX_LICENSE_BYTES = 200 * 1024
/** 详情页封面单独限制 5 MB（比普通图片更严，避免列表刷新时生成过大的 objectURL） */
const MAX_COVER_BYTES = 5 * 1024 * 1024

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'avif'])
/** 封面只接受这五种扩展名（与 README 的 cover 说明一致） */
const COVER_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'svg'])
const FONT_EXT = new Set(['ttf', 'otf', 'woff', 'woff2'])
const TEXT_EXT = new Set(['txt', 'md', 'license'])

const extensionOf = (name: string): string => {
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase()
}

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  ttf: 'font/ttf',
  otf: 'font/otf',
  woff: 'font/woff',
  woff2: 'font/woff2',
}

/** color_palette 只放纯 CSS 颜色：hex、rgb()/rgba()、hsl()/hsla()、transparent，拒绝 url(/; /} 等注入 */
const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
const RGB_COLOR =
  /^rgba?\(\s*(?:25[0-5]|2[0-4]\d|1?\d?\d)%?\s*,\s*(?:25[0-5]|2[0-4]\d|1?\d?\d)%?\s*,\s*(?:25[0-5]|2[0-4]\d|1?\d?\d)%?\s*(?:,\s*(?:0|1|0?\.\d+|100(?:\.0+)?%|\d{1,2}(?:\.\d+)?%)\s*)?\)$/i
const HSL_COLOR =
  /^hsla?\(\s*-?\d{1,3}(?:\.\d+)?(?:deg)?\s*,\s*(?:100(?:\.0+)?|\d{1,2}(?:\.\d+)?)%\s*,\s*(?:100(?:\.0+)?|\d{1,2}(?:\.\d+)?)%\s*(?:,\s*(?:0|1|0?\.\d+|100(?:\.0+)?%|\d{1,2}(?:\.\d+)?%)\s*)?\)$/i

const isCssColor = (value: unknown): value is string =>
  typeof value === 'string' &&
  (HEX_COLOR.test(value) || RGB_COLOR.test(value) || HSL_COLOR.test(value) || value.toLowerCase() === 'transparent')

/** 样式包校验告警（忽略无意义字段等）：项目全局禁 console，这里集中豁免一处 */
// oxlint-disable-next-line no-console
const warn = (message: string): void => console.warn(message)

/**
 * 纯文本字段（侧边栏标题 / 描述 / 作者 / 版本 / 许可证）拒绝尖括号与控制字符；
 * 多行文本保留 \t \n \r。展示层仍走 React 文本，不做 HTML 解析。
 */
const isUnsafeText = (value: string, multiline: boolean): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code === 0x3c || code === 0x3e) {
      return true // < >
    }
    if (code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
      return true // DEL 与 C1 控制字符
    }
    if (code < 0x20 && !(multiline && (code === 0x09 || code === 0x0a || code === 0x0d))) {
      return true // C0 控制字符
    }
  }
  return false
}

/** 单个主题的配色：只认 13 个已知令牌，未知键忽略，值必须是合法 CSS 颜色 */
const readPaletteColors = (raw: unknown, field: string): PaletteColors => {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new StylePackError('badIndex', `${field} must be an object`)
  }
  const record = raw as Record<string, unknown>
  const colors: PaletteColors = {}
  for (const key of PALETTE_KEYS) {
    const value = record[key]
    if (value === undefined) {
      continue
    }
    if (!isCssColor(value)) {
      throw new StylePackError('badIndex', `${field}.${key} must be a CSS color`)
    }
    colors[key] = value
  }
  return colors
}

/** 顶层 color_palette：只能是对象，light/dark 可单独缺省，出现时必须是配色对象 */
const readColorPalette = (raw: unknown): StylePalette | undefined => {
  if (raw === undefined) {
    return undefined
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new StylePackError('badIndex', 'color_palette must be an object')
  }
  const record = raw as Record<string, unknown>
  const palette: StylePalette = {}
  if (record.light !== undefined) {
    palette.light = readPaletteColors(record.light, 'color_palette.light')
  }
  if (record.dark !== undefined) {
    palette.dark = readPaletteColors(record.dark, 'color_palette.dark')
  }
  return palette
}

/** 非关键文本字段（description / author / version）：类型/长度问题沿用 badIndex，内容不安全时丢弃并提示 */
const readOptionalText = (value: unknown, field: string, multiline: boolean): string | undefined => {
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'string' || value.length > 400) {
    throw new StylePackError('badIndex', `${field} must be a string of at most 400 chars`)
  }
  if (isUnsafeText(value, multiline)) {
    warn(`[style-pack] index.json 的 ${field} 含控制字符或 <、>，已忽略该字段`)
    return undefined
  }
  return value
}

/** sidebarTitle 会直接影响界面标题：长度/类型错误沿用 badIndex，内容不安全按 badConfig 致命拒绝 */
const readSidebarTitle = (value: unknown): string | undefined => {
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'string' || value.length > 40) {
    throw new StylePackError('badIndex', 'sidebarTitle must be a string of at most 40 chars')
  }
  if (isUnsafeText(value, false)) {
    throw new StylePackError('badConfig', 'sidebarTitle contains control characters or < >')
  }
  return value.trim() || undefined
}

/** assets 项里的缩放 / 对齐 / 插值字段：出现时必须是合法枚举或安全的 CSS 片段 */
const readAssetOptions = (entry: Record<string, unknown>, field: string): void => {
  if (entry.fit !== undefined) {
    if (typeof entry.fit !== 'string' || !STYLE_FITS.includes(entry.fit as StyleFit)) {
      throw new StylePackError('badConfig', `${field}.fit must be one of ${STYLE_FITS.join('|')}`)
    }
  }
  if (entry.align !== undefined) {
    if (typeof entry.align !== 'string' || !STYLE_ALIGNS.includes(entry.align as StyleAlign)) {
      throw new StylePackError('badConfig', `${field}.align must be one of ${STYLE_ALIGNS.join('|')}`)
    }
  }
  if (entry.render !== undefined) {
    if (typeof entry.render !== 'string' || !STYLE_RENDERS.includes(entry.render as StyleRender)) {
      throw new StylePackError('badConfig', `${field}.render must be one of ${STYLE_RENDERS.join('|')}`)
    }
  }
  if (entry.position !== undefined && !isSafePosition(entry.position)) {
    throw new StylePackError(
      'badConfig',
      `${field}.position must be a safe CSS background-position of at most 60 chars`
    )
  }
  if (entry.align === 'custom' && entry.position === undefined) {
    throw new StylePackError('badConfig', `${field}.position is required when align is "custom"`)
  }
}

/** 清掉某类资源上用不到的图片选项（图标只应用 render、字体/文本不应用任何图片选项） */
const stripOptions = (
  entry: StyleAssetEntry | undefined,
  assetId: string,
  keys: Array<'fit' | 'align' | 'position' | 'render'>,
  reason: string
): void => {
  if (entry === null || typeof entry !== 'object') {
    return
  }
  const present = keys.filter((key) => entry[key] !== undefined)
  if (present.length === 0) {
    return
  }
  warn(`[style-pack] ${assetId} 的 ${present.join(' / ')} 被忽略：${reason}`)
  for (const key of present) {
    if (key === 'fit') {
      entry.fit = undefined
    } else if (key === 'align') {
      entry.align = undefined
    } else if (key === 'position') {
      entry.position = undefined
    } else {
      entry.render = undefined
    }
  }
}

/** 只接受包内相对路径：不允许绝对路径、`.`/`..` 与空段。 */
export const normalizeEntryPath = (path: string): string | null => {
  const normalized = path.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!normalized) {
    return null
  }
  const parts = normalized.split('/')
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    return null
  }
  return parts.join('/')
}

export type ParsedStylePack = {
  manifest: StyleManifest
  /** assetId → 文件（已按主题后缀的完整 ID 建键） */
  assets: Record<string, { blob: Blob; alpha: number; exposure: number; kind: 'image' | 'font' }>
  icon?: Blob
  /** 详情页封面（可选，≤5 MB，png/jpg/jpeg/webp/svg） */
  cover?: Blob
  license?: string
  ignored: string[]
}

const readManifest = (text: string): StyleManifest => {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new StylePackError('badIndex', 'index.json is not valid JSON')
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new StylePackError('badIndex', 'index.json must be an object')
  }
  const record = raw as Record<string, unknown>
  if (record.schema !== 1) {
    throw new StylePackError('badIndex', 'schema must be 1')
  }
  if (typeof record.id !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(record.id)) {
    throw new StylePackError('badIndex', 'id must be 1-64 chars of [a-z0-9._-]')
  }
  if (typeof record.name !== 'string' || !record.name.trim() || record.name.length > 80) {
    throw new StylePackError('badIndex', 'name must be 1-80 chars')
  }
  if (record.assets === null || typeof record.assets !== 'object' || Array.isArray(record.assets)) {
    throw new StylePackError('badIndex', 'assets must be an object')
  }
  const assets = record.assets as Record<string, unknown>
  for (const [assetId, entry] of Object.entries(assets)) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      // 结构问题留给后面的文件解析，沿用 missingFile，避免改变既有错误码
      continue
    }
    const field = `assets["${assetId}"]`
    readAssetOptions(entry as Record<string, unknown>, field)
    // position 只在 align=custom 时生效：其它情况忽略并提示一次，不留在净化后的清单里
    const assetEntry = entry as StyleAssetEntry
    if (assetEntry.position !== undefined && assetEntry.align !== 'custom') {
      warn(`[style-pack] ${field}.position 只在 align="custom" 时生效，已忽略`)
      assetEntry.position = undefined
    }
  }
  const ref = (value: unknown, field: string): string | undefined => {
    if (value === undefined) {
      return undefined
    }
    const file = typeof value === 'string' ? value : (value as { file?: unknown } | null)?.file
    if (typeof file !== 'string' || !file) {
      throw new StylePackError('badIndex', `${field}.file must be a string`)
    }
    return file
  }
  const colorPalette = readColorPalette(record.color_palette)
  return {
    schema: 1,
    id: record.id,
    name: record.name.trim(),
    description: readOptionalText(record.description, 'description', true),
    author: readOptionalText(record.author, 'author', false),
    version: readOptionalText(record.version, 'version', false),
    sidebarTitle: readSidebarTitle(record.sidebarTitle),
    icon: ref(record.icon, 'icon') ? { file: ref(record.icon, 'icon') as string } : undefined,
    cover: ref(record.cover, 'cover') ? { file: ref(record.cover, 'cover') as string } : undefined,
    license: ref(record.license, 'license') ? { file: ref(record.license, 'license') as string } : undefined,
    color_palette: colorPalette,
    assets: assets as Record<string, StyleAssetEntry>,
  }
}

export const parseStylePackZip = async (file: File): Promise<ParsedStylePack> => {
  if (file.size > MAX_ZIP_BYTES) {
    throw new StylePackError('tooLarge', `${file.size} bytes`)
  }
  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(new Uint8Array(await file.arrayBuffer()))
  } catch {
    throw new StylePackError('notZip')
  }

  const names = Object.keys(entries)
  if (names.length === 0) {
    throw new StylePackError('noIndex')
  }
  if (names.length > MAX_ENTRIES) {
    throw new StylePackError('tooManyFiles', String(names.length))
  }

  const paths = new Map<string, Uint8Array>()
  let total = 0
  for (const name of names) {
    const normalized = normalizeEntryPath(name)
    if (!normalized) {
      throw new StylePackError('badPath', name)
    }
    total += entries[name].length
    if (total > MAX_TOTAL_BYTES) {
      throw new StylePackError('tooLarge', 'uncompressed limit')
    }
    paths.set(normalized, entries[name])
  }

  const indexPath = [...paths.keys()].find((name) => name.toLowerCase() === 'index.json')
  if (!indexPath) {
    throw new StylePackError('noIndex')
  }
  const manifest = readManifest(new TextDecoder().decode(paths.get(indexPath) as Uint8Array))

  // TS 的 Uint8Array<ArrayBufferLike> 与 BlobPart 不兼容，这里复制一份有独立 ArrayBuffer 的副本
  const bytesOf = (name: string): Uint8Array<ArrayBuffer> => {
    const source = paths.get(name) as Uint8Array
    const copy = new Uint8Array(source.byteLength)
    copy.set(source)
    return copy
  }

  const blobOf = (name: string, mime: string) => new Blob([bytesOf(name)], { type: mime })

  const assets: ParsedStylePack['assets'] = {}
  const ignored: string[] = []
  for (const [assetId, entry] of Object.entries(manifest.assets)) {
    const path = normalizeEntryPath(entry?.file ?? '')
    if (!path || !paths.has(path)) {
      throw new StylePackError('missingFile', entry?.file ?? assetId)
    }
    const ext = extensionOf(path)
    if (IMAGE_EXT.has(ext)) {
      const alpha = typeof entry.alpha === 'number' && Number.isFinite(entry.alpha) ? Math.min(1, Math.max(0, entry.alpha)) : 1
      const exposure = typeof entry.exposure === 'number' && Number.isFinite(entry.exposure) ? Math.min(1, Math.max(-1, entry.exposure)) : 0
      assets[assetId] = { blob: blobOf(path, MIME[ext]), alpha, exposure, kind: 'image' }
      if (assetId.startsWith(`${STYLE_PREFIX}.icon.`)) {
        // 图标是定尺寸 <img>：fit / align / position 没有意义，只应用 render
        stripOptions(entry, assetId, ['fit', 'align', 'position'], '图标只应用 render（image-rendering）')
      }
    } else if (FONT_EXT.has(ext)) {
      assets[assetId] = { blob: blobOf(path, MIME[ext]), alpha: 1, exposure: 0, kind: 'font' }
      stripOptions(entry, assetId, ['fit', 'align', 'position', 'render'], '字体资源不应用图片选项')
    } else if (TEXT_EXT.has(ext)) {
      assets[assetId] = { blob: blobOf(path, 'text/plain; charset=utf-8'), alpha: 1, exposure: 0, kind: 'font' }
      stripOptions(entry, assetId, ['fit', 'align', 'position', 'render'], '文本资源不应用图片选项')
    } else {
      ignored.push(assetId)
    }
  }

  let icon: Blob | undefined
  if (manifest.icon) {
    const path = normalizeEntryPath(manifest.icon.file)
    if (!path || !paths.has(path)) {
      throw new StylePackError('missingFile', manifest.icon.file)
    }
    if (!IMAGE_EXT.has(extensionOf(path))) {
      throw new StylePackError('badFileType', manifest.icon.file)
    }
    icon = blobOf(path, MIME[extensionOf(path)])
  }

  let cover: Blob | undefined
  if (manifest.cover) {
    const path = normalizeEntryPath(manifest.cover.file)
    if (!path || !paths.has(path)) {
      throw new StylePackError('missingFile', manifest.cover.file)
    }
    const ext = extensionOf(path)
    if (!COVER_EXT.has(ext)) {
      throw new StylePackError('badFileType', manifest.cover.file)
    }
    const bytes = paths.get(path) as Uint8Array
    if (bytes.length > MAX_COVER_BYTES) {
      throw new StylePackError('badConfig', `cover file exceeds 5 MB: ${manifest.cover.file}`)
    }
    cover = blobOf(path, MIME[ext])
  }

  let license: string | undefined
  if (manifest.license) {
    const path = normalizeEntryPath(manifest.license.file)
    if (!path || !paths.has(path)) {
      throw new StylePackError('missingFile', manifest.license.file)
    }
    const bytes = paths.get(path) as Uint8Array
    if (bytes.length <= MAX_LICENSE_BYTES) {
      const text = new TextDecoder().decode(bytes)
      if (isUnsafeText(text, true)) {
        warn(`[style-pack] ${manifest.license.file} 含控制字符或 <、>，不展示许可证全文`)
      } else {
        license = text
      }
    }
  }

  return { manifest, assets, icon, cover, license, ignored }
}
