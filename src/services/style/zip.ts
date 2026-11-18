/** 样式包 zip 的解析与校验：路径、大小、扩展名、清单字段与字符串安全边界都在这里把关。 */
import { readZipEntries, ZipReadError } from '../zip/reader.js'
import {
  PALETTE_KEYS,
  STYLE_EFFECT_KEYS,
  STYLE_ALIGNS,
  STYLE_FITS,
  STYLE_PREFIX,
  STYLE_RENDERS,
  isSafePosition,
  isThemedFileRef,
} from './types.js'
import type {
  PaletteColors,
  StyleAlign,
  StyleAssetEntry,
  StyleAssetEntryInput,
  StyleEffects,
  StyleEmbossEffect,
  StyleFileRef,
  StyleFileRefInput,
  StyleFit,
  StyleGlowEffect,
  StyleManifest,
  StyleManifestInput,
  StylePalette,
  StylePlainFileRefInput,
  StyleRender,
  StyleShadowEffect,
  StyleStrokeEffect,
  StyleThemeFileRef,
  StyleThemeFileRefInput,
  StyleThemedFileRef,
  StyleThemedFileRefInput,
  StyleTiltEffect,
  StyleWindowEffect,
  Theme,
  ThemedBlobs,
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
/** 单个文件条目解压后的上限：低于总量上限，避免一个超大条目先吃满内存 */
const MAX_ENTRY_BYTES = 20 * 1024 * 1024
const MAX_ENTRIES = 300
const MAX_LICENSE_BYTES = 200 * 1024
/** 详情页封面单独限制 5 MB（比普通图片更严，避免列表刷新时生成过大的 objectURL） */
const MAX_COVER_BYTES = 5 * 1024 * 1024

/**
 * 默认路径的扩展名候选顺序（只影响「没写 file 时按默认位置查找」；
 * 显式 file 仍按下面的扩展名集合校验，顺序无关）。
 */
const IMAGE_EXT_ORDER = ['png', 'webp', 'jpg', 'jpeg', 'gif', 'svg', 'avif'] as const
/** 封面只接受这五种扩展名（与 README 的 cover 说明一致） */
const COVER_EXT_ORDER = ['png', 'webp', 'jpg', 'jpeg', 'svg'] as const
const FONT_EXT_ORDER = ['ttf', 'otf', 'woff', 'woff2'] as const

const IMAGE_EXT = new Set<string>(IMAGE_EXT_ORDER)
const COVER_EXT = new Set<string>(COVER_EXT_ORDER)
const FONT_EXT = new Set<string>(FONT_EXT_ORDER)
const TEXT_EXT = new Set(['txt', 'md', 'license'])

/** 包级 license 的默认位置：大小写不敏感匹配，按顺序尝试 */
const LICENSE_DEFAULT_CANDIDATES = [
  'LICENSE',
  'LICENSE.txt',
  'LICENSE.md',
  'license',
  'license.md',
] as const

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
  (HEX_COLOR.test(value) ||
    RGB_COLOR.test(value) ||
    HSL_COLOR.test(value) ||
    value.toLowerCase() === 'transparent')

/** 样式包校验告警（忽略无意义字段等）：项目全局禁 console，这里集中豁免一处 */
// oxlint-disable-next-line no-console
const warn = (message: string): void => console.warn(message)

/** 只接受普通对象（null / 数组 / 其它类型都算结构错误） */
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/** 未知特效键：忽略并提示；导入只跑一遍，因此每个未知键恰好 warn 一次 */
const warnUnknownEffectKeys = (
  record: Record<string, unknown>,
  field: string,
  known: readonly string[]
): void => {
  for (const key of Object.keys(record)) {
    if (!known.includes(key)) {
      warn(`[style-pack] ${field}.${key} 是未知特效字段，已忽略`)
    }
  }
}

const readEffectObject = (value: unknown, field: string): Record<string, unknown> => {
  if (!isPlainObject(value)) {
    throw new StylePackError('badConfig', `${field} must be an object`)
  }
  return value
}

/** 特效数值：必须是有限数字且落在区间内，否则 badConfig 并指名字段 */
const readEffectNumber = (value: unknown, field: string, min: number, max: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new StylePackError('badConfig', `${field} must be a number within ${min}..${max}`)
  }
  return value
}

/** 特效颜色沿用配色表的严格 CSS 颜色校验（#hex / rgb() / rgba() / hsl() / hsla() / transparent） */
const readEffectColor = (value: unknown, field: string): string => {
  if (!isCssColor(value)) {
    throw new StylePackError('badConfig', `${field} must be a CSS color`)
  }
  return value
}

const SHADOW_KEYS = ['x', 'y', 'blur', 'color'] as const
const GLOW_KEYS = ['radius', 'color', 'intensity'] as const
const EMBOSS_KEYS = ['depth', 'angle', 'intensity'] as const
const STROKE_KEYS = ['width', 'color'] as const
const TILT_KEYS = ['maxAngle', 'perspective', 'scale'] as const
const WINDOW_KEYS = ['x1', 'y1', 'x2', 'y2'] as const

const readShadowEffect = (raw: unknown, field: string): StyleShadowEffect => {
  const record = readEffectObject(raw, field)
  warnUnknownEffectKeys(record, field, SHADOW_KEYS)
  const effect: StyleShadowEffect = {}
  if (record.x !== undefined) {
    effect.x = readEffectNumber(record.x, `${field}.x`, -100, 100)
  }
  if (record.y !== undefined) {
    effect.y = readEffectNumber(record.y, `${field}.y`, -100, 100)
  }
  if (record.blur !== undefined) {
    effect.blur = readEffectNumber(record.blur, `${field}.blur`, 0, 100)
  }
  if (record.color !== undefined) {
    effect.color = readEffectColor(record.color, `${field}.color`)
  }
  return effect
}

const readGlowEffect = (raw: unknown, field: string): StyleGlowEffect => {
  const record = readEffectObject(raw, field)
  warnUnknownEffectKeys(record, field, GLOW_KEYS)
  const effect: StyleGlowEffect = {}
  if (record.radius !== undefined) {
    effect.radius = readEffectNumber(record.radius, `${field}.radius`, 0, 50)
  }
  if (record.color !== undefined) {
    effect.color = readEffectColor(record.color, `${field}.color`)
  }
  if (record.intensity !== undefined) {
    effect.intensity = readEffectNumber(record.intensity, `${field}.intensity`, 0, 1)
  }
  return effect
}

const readEmbossEffect = (raw: unknown, field: string): StyleEmbossEffect => {
  const record = readEffectObject(raw, field)
  warnUnknownEffectKeys(record, field, EMBOSS_KEYS)
  const effect: StyleEmbossEffect = {}
  if (record.depth !== undefined) {
    effect.depth = readEffectNumber(record.depth, `${field}.depth`, 0, 10)
  }
  if (record.angle !== undefined) {
    effect.angle = readEffectNumber(record.angle, `${field}.angle`, 0, 360)
  }
  if (record.intensity !== undefined) {
    effect.intensity = readEffectNumber(record.intensity, `${field}.intensity`, 0, 1)
  }
  return effect
}

const readStrokeEffect = (raw: unknown, field: string): StyleStrokeEffect => {
  const record = readEffectObject(raw, field)
  warnUnknownEffectKeys(record, field, STROKE_KEYS)
  const effect: StyleStrokeEffect = {}
  if (record.width !== undefined) {
    effect.width = readEffectNumber(record.width, `${field}.width`, 0, 20)
  }
  if (record.color !== undefined) {
    effect.color = readEffectColor(record.color, `${field}.color`)
  }
  return effect
}

const readTiltEffect = (raw: unknown, field: string): StyleTiltEffect => {
  const record = readEffectObject(raw, field)
  warnUnknownEffectKeys(record, field, TILT_KEYS)
  const effect: StyleTiltEffect = {}
  if (record.maxAngle !== undefined) {
    effect.maxAngle = readEffectNumber(record.maxAngle, `${field}.maxAngle`, 0, 30)
  }
  if (record.perspective !== undefined) {
    effect.perspective = readEffectNumber(record.perspective, `${field}.perspective`, 200, 2000)
  }
  if (record.scale !== undefined) {
    effect.scale = readEffectNumber(record.scale, `${field}.scale`, 0.8, 1.2)
  }
  return effect
}

/**
 * 裁切窗口：四个归一化坐标都必须出现且落在 0–1，并要求 x1 < x2、y1 < y2；
 * 任何一项不满足都报 badConfig 并指名字段。
 */
const readWindowEffect = (raw: unknown, field: string): StyleWindowEffect => {
  const record = readEffectObject(raw, field)
  warnUnknownEffectKeys(record, field, WINDOW_KEYS)
  if (
    record.x1 === undefined ||
    record.y1 === undefined ||
    record.x2 === undefined ||
    record.y2 === undefined
  ) {
    throw new StylePackError('badConfig', `${field} must have x1 / y1 / x2 / y2`)
  }
  const x1 = readEffectNumber(record.x1, `${field}.x1`, 0, 1)
  const y1 = readEffectNumber(record.y1, `${field}.y1`, 0, 1)
  const x2 = readEffectNumber(record.x2, `${field}.x2`, 0, 1)
  const y2 = readEffectNumber(record.y2, `${field}.y2`, 0, 1)
  if (x1 >= x2) {
    throw new StylePackError('badConfig', `${field}.x1 must be less than ${field}.x2`)
  }
  if (y1 >= y2) {
    throw new StylePackError('badConfig', `${field}.y1 must be less than ${field}.y2`)
  }
  return { x1, y1, x2, y2 }
}

/**
 * 视觉特效：只接受已知键与合法数值，返回净化后的对象（只保留出现过的合法子字段），
 * 空对象视为没有特效。tilt 只允许出现在 icon.* 资源与封面（allowTilt），其它位置报 badConfig。
 */
const readEffects = (raw: unknown, field: string, allowTilt: boolean): StyleEffects | undefined => {
  if (raw === undefined) {
    return undefined
  }
  const record = readEffectObject(raw, field)
  warnUnknownEffectKeys(record, field, STYLE_EFFECT_KEYS)
  const effects: StyleEffects = {}
  if (record.opacity !== undefined) {
    effects.opacity = readEffectNumber(record.opacity, `${field}.opacity`, 0, 1)
  }
  if (record.shadow !== undefined) {
    effects.shadow = readShadowEffect(record.shadow, `${field}.shadow`)
  }
  if (record.outerGlow !== undefined) {
    effects.outerGlow = readGlowEffect(record.outerGlow, `${field}.outerGlow`)
  }
  if (record.innerGlow !== undefined) {
    effects.innerGlow = readGlowEffect(record.innerGlow, `${field}.innerGlow`)
  }
  if (record.emboss !== undefined) {
    effects.emboss = readEmbossEffect(record.emboss, `${field}.emboss`)
  }
  if (record.stroke !== undefined) {
    effects.stroke = readStrokeEffect(record.stroke, `${field}.stroke`)
  }
  if (record.window !== undefined) {
    effects.window = readWindowEffect(record.window, `${field}.window`)
  }
  if (record.zoom !== undefined) {
    effects.zoom = readEffectNumber(record.zoom, `${field}.zoom`, 0, 4)
  }
  if (record.tilt !== undefined) {
    if (!allowTilt) {
      throw new StylePackError(
        'badConfig',
        `${field}.tilt 不被允许：卡片偏转只支持 icon.* 资源与封面`
      )
    }
    effects.tilt = readTiltEffect(record.tilt, `${field}.tilt`)
  }
  return Object.keys(effects).length > 0 ? effects : undefined
}

/**
 * 背景资源的 effects：只接受 window / zoom（裁切与缩放对铺满容器的背景有意义）；
 * 静态特效与 tilt 一律忽略并 warn，不留在净化后的清单里。
 */
const readBackgroundEffects = (raw: unknown, field: string): StyleEffects | undefined => {
  if (raw === undefined) {
    return undefined
  }
  const record = readEffectObject(raw, field)
  let effects: StyleEffects | undefined
  const ignored: string[] = []
  for (const key of Object.keys(record)) {
    if (key === 'window') {
      effects = { ...effects, window: readWindowEffect(record.window, `${field}.window`) }
    } else if (key === 'zoom') {
      effects = { ...effects, zoom: readEffectNumber(record.zoom, `${field}.zoom`, 0, 4) }
    } else {
      ignored.push(key)
    }
  }
  if (ignored.length > 0) {
    warn(
      `[style-pack] ${field} 的 ${ignored
        .map((key) => `effects.${key}`)
        .join(' / ')} 被忽略：背景资源只支持 window / zoom`
    )
  }
  return effects
}

/** 顶层 icon / cover 允许出现的键（未知键忽略并 warn，帮助包作者发现拼写错误） */
const MANIFEST_IMAGE_KEYS = ['file', 'light', 'dark', 'effects'] as const

/** 单个主题的 icon / cover 项（原始输入）：file 可省略；effects 允许 tilt 时按封面规则校验 */
const readThemeImageInput = (
  raw: unknown,
  field: string,
  allowTilt: boolean
): StyleThemeFileRefInput => {
  if (!isPlainObject(raw)) {
    throw new StylePackError('badIndex', `${field} must be an object`)
  }
  const record = raw
  for (const key of Object.keys(record)) {
    if (key !== 'file' && key !== 'effects') {
      warn(`[style-pack] ${field}.${key} 是未知字段，已忽略`)
    }
  }
  if (record.file !== undefined && (typeof record.file !== 'string' || !record.file)) {
    throw new StylePackError('badIndex', `${field}.file must be a string`)
  }
  const effects = readEffects(record.effects, field, allowTilt)
  const ref: StyleThemeFileRefInput = {}
  if (record.file !== undefined) {
    ref.file = record.file as string
  }
  if (effects) {
    ref.effects = effects
  }
  return ref
}

/**
 * 清单里的 icon / cover（原始输入）：兼容两种写法。
 * - `{ file?, effects? }`：主题无关，两个主题共用（file 省略时按默认位置查找）；
 * - `{ light?, dark?, file?, effects? }`：按主题给文件，`file` 作为两主题兜底；
 *   主题项内可各带 effects（覆盖包级值），每项的 file 也可省略（按该主题默认位置查找）。
 * 结构错误统一报 badIndex（与旧行为一致），effects 非法仍报 badConfig 并带字段名。
 */
const readManifestImageInput = (
  value: unknown,
  field: 'icon' | 'cover'
): StyleFileRefInput | undefined => {
  if (value === undefined) {
    return undefined
  }
  const record = typeof value === 'string' ? { file: value } : value
  if (!isPlainObject(record)) {
    throw new StylePackError('badIndex', `${field} must be an object with a file`)
  }
  for (const key of Object.keys(record)) {
    if (!MANIFEST_IMAGE_KEYS.includes(key as (typeof MANIFEST_IMAGE_KEYS)[number])) {
      warn(`[style-pack] ${field}.${key} 是未知字段，已忽略`)
    }
  }
  if (record.file !== undefined && (typeof record.file !== 'string' || !record.file)) {
    throw new StylePackError('badIndex', `${field}.file must be a string`)
  }
  const allowTilt = field === 'cover'
  const sharedEffects = readEffects(record.effects, field, allowTilt)
  // 只写 file / effects（含旧版字符串写法）时两个主题共用；出现 light/dark 才按主题拆
  if (record.light === undefined && record.dark === undefined) {
    const ref: StylePlainFileRefInput = {}
    if (record.file !== undefined) {
      ref.file = record.file as string
    }
    if (sharedEffects) {
      ref.effects = sharedEffects
    }
    return ref
  }
  const ref: StyleThemedFileRefInput = {}
  if (record.light !== undefined) {
    ref.light = readThemeImageInput(record.light, `${field}.light`, allowTilt)
  }
  if (record.dark !== undefined) {
    ref.dark = readThemeImageInput(record.dark, `${field}.dark`, allowTilt)
  }
  if (record.file !== undefined) {
    ref.file = record.file as string
  }
  if (sharedEffects) {
    ref.effects = sharedEffects
  }
  return ref
}

/**
 * 顶层 license（原始输入）：`{ file }` / `{}` / 旧版字符串写法。
 * file 可省略，省略时按默认位置（LICENSE / LICENSE.txt / LICENSE.md ...）查找。
 */
const readLicenseInput = (value: unknown): { file?: string } | undefined => {
  if (value === undefined) {
    return undefined
  }
  const record = typeof value === 'string' ? { file: value } : value
  if (!isPlainObject(record)) {
    throw new StylePackError('badIndex', 'license must be an object with a file')
  }
  for (const key of Object.keys(record)) {
    if (key !== 'file') {
      warn(`[style-pack] license.${key} 是未知字段，已忽略`)
    }
  }
  if (record.file !== undefined && (typeof record.file !== 'string' || !record.file)) {
    throw new StylePackError('badIndex', 'license.file must be a string')
  }
  return record.file === undefined ? {} : { file: record.file as string }
}

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
const readOptionalText = (
  value: unknown,
  field: string,
  multiline: boolean
): string | undefined => {
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
      throw new StylePackError(
        'badConfig',
        `${field}.align must be one of ${STYLE_ALIGNS.join('|')}`
      )
    }
  }
  if (entry.render !== undefined) {
    if (typeof entry.render !== 'string' || !STYLE_RENDERS.includes(entry.render as StyleRender)) {
      throw new StylePackError(
        'badConfig',
        `${field}.render must be one of ${STYLE_RENDERS.join('|')}`
      )
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

/** 清掉某类资源上用不到的 effects（背景 / 字体 / 文本）：非致命，只 warn 一次 */
const stripEffects = (
  entry: StyleAssetEntry | undefined,
  assetId: string,
  reason: string
): void => {
  if (entry === null || typeof entry !== 'object' || entry.effects === undefined) {
    return
  }
  warn(`[style-pack] ${assetId} 的 effects 被忽略：${reason}`)
  entry.effects = undefined
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

/** 按「位置优先 × 扩展名顺序」展开默认路径候选：先试完第一个位置的全部扩展名，再试下一个位置 */
const candidatePaths = (bases: readonly string[], exts: readonly string[]): string[] =>
  bases.flatMap((base) => exts.map((ext) => `${base}.${ext}`))

/**
 * assets 槽位的默认路径候选（由资源 ID 推出）：
 * - `background.<name>.<theme>` → `assets/<theme>/<name>.<ext>`、`assets/<name>.<ext>`
 * - `icon.<name>.<theme>`       → `assets/icons/<theme>/<name>.<ext>`、`assets/<theme>/<name>.<ext>`、`assets/icons/<name>.<ext>`
 * - `font.<theme>`              → `assets/font.<ext>`、`font.<ext>`
 *
 * 其它 ID（没有主题后缀 / 不属于以上类别）没有默认路径，返回空数组。
 */
const assetDefaultPaths = (assetId: string): string[] => {
  const prefix = `${STYLE_PREFIX}.`
  if (!assetId.startsWith(prefix)) {
    return []
  }
  const themed = /^(.*)\.(light|dark)$/.exec(assetId.slice(prefix.length))
  if (!themed) {
    return []
  }
  const slot = themed[1]
  const theme = themed[2] as Theme
  if (slot === 'font') {
    return candidatePaths(['assets/font', 'font'], FONT_EXT_ORDER)
  }
  if (slot.startsWith('background.')) {
    const name = slot.slice('background.'.length)
    return name
      ? candidatePaths([`assets/${theme}/${name}`, `assets/${name}`], IMAGE_EXT_ORDER)
      : []
  }
  if (slot.startsWith('icon.')) {
    const name = slot.slice('icon.'.length)
    return name
      ? candidatePaths(
          [`assets/icons/${theme}/${name}`, `assets/${theme}/${name}`, `assets/icons/${name}`],
          IMAGE_EXT_ORDER
        )
      : []
  }
  return []
}

/** 包级 icon / cover 的默认路径候选（主题目录优先，根目录兜底） */
const manifestDefaultPaths = (kind: 'icon' | 'cover', theme: Theme): string[] =>
  candidatePaths(
    [`assets/${theme}/${kind}`, kind],
    kind === 'cover' ? COVER_EXT_ORDER : IMAGE_EXT_ORDER
  )

/**
 * 把两个主题的 icon / cover 解析结果归一化：
 * - 两主题都没有 → undefined；
 * - 只有一个主题命中 → 主题无关写法（两个主题共用，与展示层「缺主题回退另一主题」一致）；
 * - 两主题同文件且 effects 相同 → 主题无关写法；否则输出按主题写法。
 */
const collapseManifestImages = (
  light: StyleThemeFileRef | undefined,
  dark: StyleThemeFileRef | undefined
): StyleFileRef | undefined => {
  if (light && dark) {
    if (
      light.file !== dark.file ||
      JSON.stringify(light.effects) !== JSON.stringify(dark.effects)
    ) {
      const themed: StyleThemedFileRef = { light, dark }
      return themed
    }
  }
  const only = light ?? dark
  if (!only) {
    return undefined
  }
  return only.effects ? { file: only.file, effects: only.effects } : { file: only.file }
}

export type ParsedStylePack = {
  /** 解析后的清单：icon / cover / license / assets 的 file 都已补齐为包内实际条目名 */
  manifest: StyleManifest
  /** assetId → 文件（已按主题后缀的完整 ID 建键） */
  assets: Record<string, { blob: Blob; alpha: number; exposure: number; kind: 'image' | 'font' }>
  /** 包图标 blob，按主题分开；主题无关写法会让两个主题指向同一个 Blob */
  icon: ThemedBlobs
  /** 详情页封面 blob，按主题分开（每个文件 ≤5 MB，png/jpg/jpeg/webp/svg） */
  cover: ThemedBlobs
  license?: string
  ignored: string[]
}

const readManifestInput = (text: string): StyleManifestInput => {
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
    const assetEntry = entry as StyleAssetEntryInput
    if (assetEntry.file !== undefined && typeof assetEntry.file !== 'string') {
      throw new StylePackError('badIndex', `${field}.file must be a string`)
    }
    // position 只在 align=custom 时生效：其它情况忽略并提示一次，不留在净化后的清单里
    if (assetEntry.position !== undefined && assetEntry.align !== 'custom') {
      warn(`[style-pack] ${field}.position 只在 align="custom" 时生效，已忽略`)
      assetEntry.position = undefined
    }
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
    icon: readManifestImageInput(record.icon, 'icon'),
    cover: readManifestImageInput(record.cover, 'cover'),
    license: readLicenseInput(record.license),
    color_palette: colorPalette,
    assets: assets as Record<string, StyleAssetEntryInput>,
  }
}

/** 流式解压错误码 → 样式包导入错误码（tooLarge / tooManyFiles / notZip 同名） */
const zipReadError = (error: unknown): StylePackError =>
  error instanceof ZipReadError
    ? new StylePackError(error.code, error.detail)
    : new StylePackError('notZip')

export const parseStylePackZip = async (file: File): Promise<ParsedStylePack> => {
  if (file.size > MAX_ZIP_BYTES) {
    throw new StylePackError('tooLarge', `${file.size} bytes`)
  }
  let entries: Map<string, Uint8Array>
  try {
    // 逐条流式解压并在累计未压缩字节超限时立即中止，不先整包解压
    entries = readZipEntries(new Uint8Array(await file.arrayBuffer()), {
      maxEntries: MAX_ENTRIES,
      maxEntryBytes: MAX_ENTRY_BYTES,
      maxTotalBytes: MAX_TOTAL_BYTES,
    })
  } catch (error) {
    throw zipReadError(error)
  }

  // 目录条目已由 readZipEntries 跳过，这里只对文件做路径与数量校验
  if (entries.size === 0) {
    throw new StylePackError('noIndex')
  }

  const paths = new Map<string, Uint8Array>()
  for (const [name, bytes] of entries) {
    const normalized = normalizeEntryPath(name)
    if (!normalized) {
      throw new StylePackError('badPath', name)
    }
    paths.set(normalized, bytes)
  }

  // 大小写不敏感索引：小写归一化路径 → 真实条目名（读取一律用真实条目名，zip 内容字节不变）
  const lowerPaths = new Map<string, string>()
  for (const name of paths.keys()) {
    const key = name.toLowerCase()
    if (!lowerPaths.has(key)) {
      lowerPaths.set(key, name)
    }
  }

  /** 按候选路径（大小写不敏感）找第一个命中的真实条目名 */
  const findEntry = (candidates: readonly string[]): string | undefined => {
    for (const candidate of candidates) {
      const actual = lowerPaths.get(candidate.toLowerCase())
      if (actual) {
        return actual
      }
    }
    return undefined
  }

  /** 显式路径：文件必须存在，否则报 missingFile（显式路径错误不回退默认位置） */
  const requireEntry = (file: string): string => {
    const path = normalizeEntryPath(file)
    const actual = path ? lowerPaths.get(path.toLowerCase()) : undefined
    if (!actual) {
      throw new StylePackError('missingFile', file)
    }
    return actual
  }

  const indexPath = findEntry(['index.json'])
  if (!indexPath) {
    throw new StylePackError('noIndex')
  }
  const input = readManifestInput(new TextDecoder().decode(paths.get(indexPath) as Uint8Array))

  // TS 的 Uint8Array<ArrayBufferLike> 与 BlobPart 不兼容，这里复制一份有独立 ArrayBuffer 的副本
  const bytesOf = (name: string): Uint8Array<ArrayBuffer> => {
    const source = paths.get(name) as Uint8Array
    const copy = new Uint8Array(source.byteLength)
    copy.set(source)
    return copy
  }

  const blobOf = (name: string, mime: string) => new Blob([bytesOf(name)], { type: mime })

  /** 同一张图（同一路径）只建一个 Blob，让两个主题共用时不会重复占内存 */
  const manifestBlobCache = new Map<string, Blob>()

  /**
   * 读取并校验 icon / cover 的单个文件：路径规则、图片扩展名、封面 5 MB 上限都不变；
   * 返回的 Blob 按路径缓存，主题间同文件共享。
   */
  const readManifestBlob = (path: string, kind: 'icon' | 'cover'): Blob => {
    const bytes = paths.get(path)
    if (!bytes) {
      throw new StylePackError('missingFile', path)
    }
    const ext = extensionOf(path)
    if (kind === 'cover') {
      if (!COVER_EXT.has(ext)) {
        throw new StylePackError('badFileType', path)
      }
      if (bytes.length > MAX_COVER_BYTES) {
        throw new StylePackError('badConfig', `cover file exceeds 5 MB: ${path}`)
      }
    } else if (!IMAGE_EXT.has(ext)) {
      throw new StylePackError('badFileType', path)
    }
    const cached = manifestBlobCache.get(path)
    if (cached) {
      return cached
    }
    const blob = blobOf(path, MIME[ext])
    manifestBlobCache.set(path, blob)
    return blob
  }

  /**
   * 按默认路径约定解析 icon / cover（输入 ref 里的 file 可能省略）：
   * - 主题项显式 file：严格读取，缺失报 missingFile（不回退）；
   * - 没写 file：该主题默认位置（`assets/<theme>/<kind>.<ext>`、`<kind>.<ext>`）→
   *   包级显式 file（沿用现有回退规则）→ 另一主题的默认位置；
   * - 完全没写 icon / cover：两个主题都按默认位置查找。
   * 两主题最终同文件且 effects 相同时归一化成主题无关写法。
   */
  const resolveManifestRef = (
    rawRef: StyleFileRefInput | undefined,
    kind: 'icon' | 'cover'
  ): StyleFileRef | undefined => {
    const themedRef: StyleThemedFileRefInput | undefined =
      rawRef !== undefined && ('light' in rawRef || 'dark' in rawRef) ? rawRef : undefined
    const defaultsFor = (theme: Theme): string | undefined =>
      findEntry(manifestDefaultPaths(kind, theme))

    let packageFile: string | undefined
    let packageFileRead = false
    /** 包级显式 file 只在该主题真的需要兜底时才读取与校验（保持旧行为：没用到就不校验） */
    const packageFallback = (): string | undefined => {
      if (themedRef?.file === undefined) {
        return undefined
      }
      if (!packageFileRead) {
        packageFileRead = true
        packageFile = requireEntry(themedRef.file)
      }
      return packageFile
    }

    const resolveTheme = (
      theme: Theme,
      item: StyleThemeFileRefInput | undefined
    ): StyleThemeFileRef | undefined => {
      const other = theme === 'light' ? 'dark' : 'light'
      const file =
        (item?.file !== undefined ? requireEntry(item.file) : undefined) ??
        defaultsFor(theme) ??
        packageFallback() ??
        defaultsFor(other)
      if (!file) {
        return undefined
      }
      const effects = item?.effects ?? rawRef?.effects
      return effects ? { file, effects } : { file }
    }

    if (rawRef === undefined) {
      return collapseManifestImages(
        resolveTheme('light', undefined),
        resolveTheme('dark', undefined)
      )
    }
    if (!themedRef) {
      if (rawRef.file !== undefined) {
        const file = requireEntry(rawRef.file)
        return rawRef.effects ? { file, effects: rawRef.effects } : { file }
      }
      return collapseManifestImages(
        resolveTheme('light', undefined),
        resolveTheme('dark', undefined)
      )
    }
    return collapseManifestImages(
      resolveTheme('light', themedRef.light),
      resolveTheme('dark', themedRef.dark)
    )
  }

  /** 把解析后的 icon / cover 引用读成按主题的 Blob（主题无关写法两个主题共用同一个 Blob） */
  const readManifestBlobs = (
    ref: StyleFileRef | undefined,
    kind: 'icon' | 'cover'
  ): ThemedBlobs => {
    const blobs: ThemedBlobs = {}
    if (!ref) {
      return blobs
    }
    if (!isThemedFileRef(ref)) {
      const blob = readManifestBlob(ref.file, kind)
      return { light: blob, dark: blob }
    }
    for (const theme of ['light', 'dark'] as const) {
      const file = ref[theme]?.file ?? ref.file
      if (file) {
        blobs[theme] = readManifestBlob(file, kind)
      }
    }
    return blobs
  }

  const assets: ParsedStylePack['assets'] = {}
  const resolvedAssets: Record<string, StyleAssetEntry> = {}
  const ignored: string[] = []
  for (const [assetId, rawEntry] of Object.entries(input.assets)) {
    if (!isPlainObject(rawEntry)) {
      // 结构问题沿用 missingFile，避免改变既有错误码
      throw new StylePackError('missingFile', assetId)
    }
    const entry = rawEntry as StyleAssetEntryInput
    let path: string
    if (entry.file !== undefined) {
      // 显式路径严格：文件不存在报 missingFile，不静默回退默认位置
      path = requireEntry(entry.file)
    } else {
      const found = findEntry(assetDefaultPaths(assetId))
      if (!found) {
        warn(`[style-pack] ${assetId} 没有写 file，默认位置也没有对应文件，已跳过该资源`)
        continue
      }
      path = found
    }
    // 解析后的清单项带实际条目名，后续校验 / 消费与旧包完全一致
    const resolved: StyleAssetEntry = { ...entry, file: path }
    const ext = extensionOf(path)
    if (IMAGE_EXT.has(ext)) {
      const alpha =
        typeof entry.alpha === 'number' && Number.isFinite(entry.alpha)
          ? Math.min(1, Math.max(0, entry.alpha))
          : 1
      const exposure =
        typeof entry.exposure === 'number' && Number.isFinite(entry.exposure)
          ? Math.min(1, Math.max(-1, entry.exposure))
          : 0
      assets[assetId] = { blob: blobOf(path, MIME[ext]), alpha, exposure, kind: 'image' }
      if (assetId.startsWith(`${STYLE_PREFIX}.background.`)) {
        // 背景是铺满容器的图层：只保留 window / zoom，静态特效与 tilt 忽略并 warn
        resolved.effects = readBackgroundEffects(entry.effects, `assets["${assetId}"]`)
      } else {
        // 图标类（icon.*）：静态 effects + tilt；其它图片槽位允许静态 effects，tilt 报 badConfig
        resolved.effects = readEffects(
          entry.effects,
          `assets["${assetId}"]`,
          assetId.startsWith(`${STYLE_PREFIX}.icon.`)
        )
      }
      if (assetId.startsWith(`${STYLE_PREFIX}.icon.`)) {
        // 图标是定尺寸 <img>：fit / align / position 没有意义，只应用 render
        stripOptions(
          resolved,
          assetId,
          ['fit', 'align', 'position'],
          '图标只应用 render（image-rendering）'
        )
      }
    } else if (FONT_EXT.has(ext)) {
      assets[assetId] = { blob: blobOf(path, MIME[ext]), alpha: 1, exposure: 0, kind: 'font' }
      stripOptions(
        resolved,
        assetId,
        ['fit', 'align', 'position', 'render'],
        '字体资源不应用图片选项'
      )
      stripEffects(resolved, assetId, '字体资源不支持视觉特效')
    } else if (TEXT_EXT.has(ext)) {
      assets[assetId] = {
        blob: blobOf(path, 'text/plain; charset=utf-8'),
        alpha: 1,
        exposure: 0,
        kind: 'font',
      }
      stripOptions(
        resolved,
        assetId,
        ['fit', 'align', 'position', 'render'],
        '文本资源不应用图片选项'
      )
      stripEffects(resolved, assetId, '文本资源不支持视觉特效')
    } else {
      ignored.push(assetId)
    }
    resolvedAssets[assetId] = resolved
  }

  // 包级 license：显式 file 严格；没写则按默认位置（LICENSE / LICENSE.txt / LICENSE.md ...）查找
  const licensePath =
    input.license?.file !== undefined
      ? requireEntry(input.license.file)
      : findEntry(LICENSE_DEFAULT_CANDIDATES)
  let license: string | undefined
  if (licensePath) {
    const bytes = paths.get(licensePath) as Uint8Array
    if (bytes.length <= MAX_LICENSE_BYTES) {
      const text = new TextDecoder().decode(bytes)
      if (isUnsafeText(text, true)) {
        warn(`[style-pack] ${licensePath} 含控制字符或 <、>，不展示许可证全文`)
      } else {
        license = text
      }
    }
  }

  // 解析结果里的 file 已补齐（显式值或默认位置），下游 / IndexedDB 不需要再做默认路径查找
  const manifest: StyleManifest = {
    ...input,
    icon: resolveManifestRef(input.icon, 'icon'),
    cover: resolveManifestRef(input.cover, 'cover'),
    license: licensePath ? { file: licensePath } : undefined,
    assets: resolvedAssets,
  }
  const icon = readManifestBlobs(manifest.icon, 'icon')
  const cover = readManifestBlobs(manifest.cover, 'cover')

  return { manifest, assets, icon, cover, license, ignored }
}
