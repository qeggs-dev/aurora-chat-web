/**
 * 样式包 effects 的只读汇总：详情页「图像效果 / 滤镜」区块用它把清单里的 effects
 * 归一化成「按资源分组、只保留与默认值不同的字段」的结构，便于展示与测试。
 *
 * 展示规则（与详情页一致）：
 * - 只列出某个主题下实际提供的资源（背景 / 图标 / 字体 / 包图标 / 封面）；
 * - 某个效果组只有在「显式出现且至少有一个字段与默认值不同」时才算自定义效果；
 *   只写默认值（例如 `opacity: 1`、`window` 四个默认坐标、`shadow` 的默认值）不展示，
 *   这样与「只显示非默认值」的约定一致；
 * - 没有自定义效果的资源使用默认效果（由 UI 汇总提示，不展示空分组）。
 *
 * 纯逻辑，不碰 DOM，因此可以在 node:test 里直接覆盖。
 */
import {
  EFFECT_DEFAULTS,
  STYLE_EFFECT_KEYS,
  STYLE_PREFIX,
  TILT_DEFAULTS,
  resolveStyleFileRef,
  type StyleEffects,
  type StyleEffectsKey,
  type StyleManifest,
  type Theme,
} from './types.js'

/** 对象型效果组内字段的展示顺序（未知字段由导入器过滤，这里只列规范字段） */
const EFFECT_FIELD_ORDER: Record<
  Exclude<StyleEffectsKey, 'opacity' | 'zoom'>,
  readonly string[]
> = {
  shadow: ['x', 'y', 'blur', 'color'],
  outerGlow: ['radius', 'intensity', 'color'],
  innerGlow: ['radius', 'intensity', 'color'],
  emboss: ['depth', 'angle', 'intensity'],
  stroke: ['width', 'color'],
  window: ['x1', 'y1', 'x2', 'y2'],
  tilt: ['maxAngle', 'perspective', 'scale'],
}

/** `window` 的默认值不是所有字段的常量，单独定义（与 effects.ts 的裁切窗口语义一致） */
const WINDOW_DEFAULTS = { x1: 0, y1: 0, x2: 1, y2: 1 } as const

/** 某个对象型效果组的默认值 */
const effectDefaults = (
  group: Exclude<StyleEffectsKey, 'opacity' | 'zoom'>
): Record<string, number | string> => {
  if (group === 'window') {
    return { ...WINDOW_DEFAULTS }
  }
  if (group === 'tilt') {
    return { ...TILT_DEFAULTS }
  }
  return { ...EFFECT_DEFAULTS[group] }
}

/** 一个非默认字段展示项：`field` 为对象型效果的子字段，标量效果没有子字段 */
export type StyleEffectFieldSummary = {
  field?: string
  value: string
}

/** 一个效果组（opacity / shadow / window / zoom / tilt …）的非默认字段 */
export type StyleEffectGroupSummary = {
  group: StyleEffectsKey
  values: StyleEffectFieldSummary[]
}

/** 资源的非默认效果分组；空数组 = 该资源使用默认效果 */
export type StyleEffectSummary = StyleEffectGroupSummary[]

/** 数字去掉无意义的小数尾零（0.8000000000000001 之类），颜色等字符串原样输出 */
const formatEffectValue = (value: number | string): string => {
  if (typeof value === 'number') {
    return String(Number(value.toFixed(4)))
  }
  return value
}

/** 颜色比较忽略大小写；其余值按字符串比较，数字仍按数字比较（1 与 '1' 视为等价展示） */
const isDefaultValue = (
  value: number | string,
  defaultValue: number | string | undefined
): boolean => {
  if (defaultValue === undefined) {
    return false
  }
  if (typeof value === 'number' && typeof defaultValue === 'number') {
    return value === defaultValue
  }
  return String(value).toLowerCase() === String(defaultValue).toLowerCase()
}

const asRecord = (value: unknown): Record<string, number | string | undefined> =>
  value !== null && typeof value === 'object'
    ? (value as Record<string, number | string | undefined>)
    : {}

/**
 * 汇总一个资源的 effects：按 `STYLE_EFFECT_KEYS` 的规范顺序输出；
 * 只保留显式出现、且与默认值不同的字段。没有任何非默认值时返回空数组。
 */
export const summarizeEffects = (effects: StyleEffects | undefined): StyleEffectSummary => {
  if (!effects) {
    return []
  }
  const summary: StyleEffectSummary = []
  for (const group of STYLE_EFFECT_KEYS) {
    const value = effects[group]
    if (value === undefined) {
      continue
    }
    if (group === 'opacity' || group === 'zoom') {
      const scalar = value as number
      if (isDefaultValue(scalar, EFFECT_DEFAULTS[group])) {
        continue
      }
      summary.push({
        group,
        values: [{ value: formatEffectValue(scalar) }],
      })
      continue
    }
    const defaults = effectDefaults(group)
    const record = asRecord(value)
    const values: StyleEffectFieldSummary[] = []
    for (const field of EFFECT_FIELD_ORDER[group]) {
      const fieldValue = record[field]
      if (fieldValue === undefined || isDefaultValue(fieldValue, defaults[field])) {
        continue
      }
      values.push({ field, value: formatEffectValue(fieldValue) })
    }
    if (values.length > 0) {
      summary.push({ group, values })
    }
  }
  return summary
}

/** 是否配置了任何非默认 effects（详情页用来区分「自定义」与「使用默认效果」） */
export const hasCustomEffects = (effects: StyleEffects | undefined): boolean =>
  summarizeEffects(effects).length > 0

/** 详情页展示的资源类型：背景 / 图标 / 字体 / 包图标 / 封面 */
export type StyleEffectResourceKind = 'background' | 'icon' | 'font' | 'packIcon' | 'cover'

/** 某个主题下实际提供的资源及其 effects（字体不会带 effects，保留在列表里参与默认提示） */
export type StyleEffectResource = {
  /** assets 资源用完整 ID；包图标 / 封面用固定的 `icon` / `cover` */
  id: string
  kind: StyleEffectResourceKind
  /** 包内文件路径（字体 / 包图标 / 封面展示用） */
  file: string
  effects?: StyleEffects
}

const BACKGROUND_PREFIX = `${STYLE_PREFIX}.background.`
const ICON_PREFIX = `${STYLE_PREFIX}.icon.`
const FONT_PREFIX = `${STYLE_PREFIX}.font.`

/**
 * 列出某主题下实际提供的资源：`assets` 里以 `.<theme>` 结尾的背景 / 图标 / 字体，
 * 加上该主题实际有图的包图标与封面（主题无关写法两个主题共用一个文件）。
 * 顺序沿用清单里的键顺序，包图标 / 封面排在最后。
 */
export const collectThemeEffectResources = (
  manifest: StyleManifest,
  theme: Theme
): StyleEffectResource[] => {
  const resources: StyleEffectResource[] = []
  for (const [id, entry] of Object.entries(manifest.assets)) {
    if (!id.endsWith(`.${theme}`)) {
      continue
    }
    const kind: StyleEffectResourceKind | undefined = id.startsWith(BACKGROUND_PREFIX)
      ? 'background'
      : id.startsWith(ICON_PREFIX)
        ? 'icon'
        : id.startsWith(FONT_PREFIX)
          ? 'font'
          : undefined
    if (!kind) {
      continue
    }
    resources.push({ id, kind, file: entry.file, effects: entry.effects })
  }
  const packIcon = resolveStyleFileRef(manifest.icon, theme)
  if (packIcon) {
    resources.push({ id: 'icon', kind: 'packIcon', file: packIcon.file, effects: packIcon.effects })
  }
  const cover = resolveStyleFileRef(manifest.cover, theme)
  if (cover) {
    resources.push({ id: 'cover', kind: 'cover', file: cover.file, effects: cover.effects })
  }
  return resources
}

/** 资源 ID → 展示名：去掉统一前缀与主题后缀（如 `background.main`、`icon.send`） */
export const styleAssetLabel = (assetId: string): string =>
  assetId.replace(`${STYLE_PREFIX}.`, '').replace(/\.(light|dark)$/, '')
