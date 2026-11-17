/** 样式包资源 ID 与清单的类型定义；ID 由包作者写进 index.json，代码只认语义槽位。 */
export type Theme = 'light' | 'dark'

/** 资源 ID 的统一前缀 */
export const STYLE_PREFIX = 'dslike_chat.style_pkg'

/** 语义槽位（不含主题后缀），运行时按当前主题拼成完整 ID */
export const STYLE_SLOTS = {
  bgMain: `${STYLE_PREFIX}.background.main`,
  bgChat: `${STYLE_PREFIX}.background.chat`,
  bgInputBox: `${STYLE_PREFIX}.background.input_box`,
  bgSidebar: `${STYLE_PREFIX}.background.sidebar`,
  bgNewSession: `${STYLE_PREFIX}.background.new_session`,
  bgSelectedSession: `${STYLE_PREFIX}.background.selected_session`,
  bgNormalSession: `${STYLE_PREFIX}.background.normal_session`,
  bgSettingGeneric: `${STYLE_PREFIX}.background.setting.generic`,
  bgSettingDatas: `${STYLE_PREFIX}.background.setting.datas`,
  bgSettingAbout: `${STYLE_PREFIX}.background.setting.about`,
  bgSettingStyle: `${STYLE_PREFIX}.background.setting.style`,
  bgSettingPreset: `${STYLE_PREFIX}.background.setting.preset`,
  bgSettingUsage: `${STYLE_PREFIX}.background.setting.usage`,
  font: `${STYLE_PREFIX}.font`,
  iconNewSession: `${STYLE_PREFIX}.icon.new_session`,
  iconEnterSidebar: `${STYLE_PREFIX}.icon.enter_sidebar`,
  iconExitSidebar: `${STYLE_PREFIX}.icon.exit_sidebar`,
  iconThinking: `${STYLE_PREFIX}.icon.thinking`,
  iconNetwork: `${STYLE_PREFIX}.icon.network`,
  iconSoundInput: `${STYLE_PREFIX}.icon.sound_input`,
  iconLinkFile: `${STYLE_PREFIX}.icon.link_file`,
  iconEdit: `${STYLE_PREFIX}.icon.edit`,
  iconMenu: `${STYLE_PREFIX}.icon.menu`,
  iconDelete: `${STYLE_PREFIX}.icon.delete`,
  iconCopy: `${STYLE_PREFIX}.icon.copy`,
  iconRegen: `${STYLE_PREFIX}.icon.regen`,
  iconSend: `${STYLE_PREFIX}.icon.send`,
  iconStop: `${STYLE_PREFIX}.icon.stop`,
  iconLeftArrow: `${STYLE_PREFIX}.icon.left_arrow`,
  iconRightArrow: `${STYLE_PREFIX}.icon.right_arrow`,
  iconSettingSetting: `${STYLE_PREFIX}.icon.setting.setting`,
  iconSettingLight: `${STYLE_PREFIX}.icon.setting.light`,
  iconSettingDark: `${STYLE_PREFIX}.icon.setting.dark`,
  iconSettingDevice: `${STYLE_PREFIX}.icon.setting.device`,
  iconSettingDatas: `${STYLE_PREFIX}.icon.setting.datas`,
  iconSettingAbout: `${STYLE_PREFIX}.icon.setting.about`,
} as const

export type StyleSlot = (typeof STYLE_SLOTS)[keyof typeof STYLE_SLOTS]

/** 背景槽位：可以带 alpha / exposure */
export const BACKGROUND_SLOTS: StyleSlot[] = [
  STYLE_SLOTS.bgMain,
  STYLE_SLOTS.bgChat,
  STYLE_SLOTS.bgInputBox,
  STYLE_SLOTS.bgSidebar,
  STYLE_SLOTS.bgNewSession,
  STYLE_SLOTS.bgSelectedSession,
  STYLE_SLOTS.bgNormalSession,
  STYLE_SLOTS.bgSettingGeneric,
  STYLE_SLOTS.bgSettingDatas,
  STYLE_SLOTS.bgSettingAbout,
]

/** 图标槽位：覆盖内置 SVG */
export const ICON_SLOTS: StyleSlot[] = [
  STYLE_SLOTS.iconNewSession,
  STYLE_SLOTS.iconEnterSidebar,
  STYLE_SLOTS.iconExitSidebar,
  STYLE_SLOTS.iconThinking,
  STYLE_SLOTS.iconNetwork,
  STYLE_SLOTS.iconSoundInput,
  STYLE_SLOTS.iconLinkFile,
  STYLE_SLOTS.iconEdit,
  STYLE_SLOTS.iconMenu,
  STYLE_SLOTS.iconDelete,
  STYLE_SLOTS.iconCopy,
  STYLE_SLOTS.iconRegen,
  STYLE_SLOTS.iconSend,
  STYLE_SLOTS.iconStop,
  STYLE_SLOTS.iconLeftArrow,
  STYLE_SLOTS.iconRightArrow,
  STYLE_SLOTS.iconSettingSetting,
  STYLE_SLOTS.iconSettingLight,
  STYLE_SLOTS.iconSettingDark,
  STYLE_SLOTS.iconSettingDevice,
  STYLE_SLOTS.iconSettingDatas,
  STYLE_SLOTS.iconSettingAbout,
]

export const slotId = (slot: string, theme: Theme) => `${slot}.${theme}`

/** 背景图缩放方式：cover 裁切铺满、contain 完整显示、stretch 拉伸铺满、tile 原尺寸平铺 */
export type StyleFit = 'cover' | 'contain' | 'stretch' | 'tile'

/**
 * 背景图对齐方式：九宫格枚举 + custom。
 * custom 时用 position 写任意 CSS background-position（如 `50% 20%`、`left 10px bottom 20%`）。
 */
export type StyleAlign =
  | 'top-left'
  | 'top-center'
  | 'top-right'
  | 'center-left'
  | 'center'
  | 'center-right'
  | 'bottom-left'
  | 'bottom-center'
  | 'bottom-right'
  | 'custom'

/** 图片插值（缩放采样）策略；映射到 CSS image-rendering，见 RENDER_CSS */
export type StyleRender =
  | 'auto'
  | 'smooth'
  | 'pixelated'
  | 'crisp-edges'
  | 'high-quality'
  | 'optimize-speed'
  | 'optimize-quality'

/** 校验与文档共用的合法取值 */
export const STYLE_FITS: readonly StyleFit[] = ['cover', 'contain', 'stretch', 'tile']

export const STYLE_ALIGNS: readonly StyleAlign[] = [
  'top-left',
  'top-center',
  'top-right',
  'center-left',
  'center',
  'center-right',
  'bottom-left',
  'bottom-center',
  'bottom-right',
  'custom',
]

export const STYLE_RENDERS: readonly StyleRender[] = [
  'auto',
  'smooth',
  'pixelated',
  'crisp-edges',
  'high-quality',
  'optimize-speed',
  'optimize-quality',
]

/** 三个新字段缺省时的取值：与扩展前的表现完全一致（cover / center / auto） */
export const STYLE_FIT_DEFAULT: StyleFit = 'cover'
export const STYLE_ALIGN_DEFAULT = 'center'
export const STYLE_RENDER_DEFAULT: StyleRender = 'auto'

/**
 * render → CSS image-rendering 关键字。
 * smooth 在 Chromium 没有独立关键字，这里显式映射为浏览器默认的 auto；
 * high-quality / optimizeSpeed / optimizeQuality 在不支持的内核上由 CSS 无效值回退到 auto，
 * 不做 JS 特性检测。
 */
export const RENDER_CSS: Record<StyleRender, string> = {
  auto: 'auto',
  smooth: 'auto',
  pixelated: 'pixelated',
  'crisp-edges': 'crisp-edges',
  'high-quality': 'high-quality',
  'optimize-speed': 'optimizeSpeed',
  'optimize-quality': 'optimizeQuality',
}

/**
 * 自定义 background-position 的白名单：字符集、长度上限与危险函数共用一份，
 * zip.ts 在导入时校验，apply.ts 写入 CSSOM 前再兜底一次。
 */
export const POSITION_PATTERN = /^[a-zA-Z0-9 %.,/+()-]{1,60}$/
const POSITION_FORBIDDEN = /url\s*\(|expression\s*\(|\/\*/i

/** 是否为安全的 CSS background-position 片段（拒绝 ; { } < > \ @ " ' 与 url()/expression()/注释） */
export const isSafePosition = (value: unknown): value is string =>
  typeof value === 'string' && POSITION_PATTERN.test(value) && !POSITION_FORBIDDEN.test(value)

/**
 * assets 项：`file` 必填，其余可选。
 * `alpha` / `exposure` 只对图片有效；`fit` / `align` / `render` 见 README 的样式包规范。
 */
export type StyleAssetEntry = {
  file: string
  alpha?: number
  exposure?: number
  fit?: StyleFit
  align?: StyleAlign
  /** 仅 align=custom 时生效；其它情况忽略并 warn 一次 */
  position?: string
  render?: StyleRender
}

/** 配色令牌键：color_palette 里每个主题可选的 13 个语义色 */
export const PALETTE_KEYS = [
  'background',
  'surface',
  'surface_alt',
  'text',
  'text_secondary',
  'text_tertiary',
  'border',
  'accent',
  'accent_text',
  'bubble',
  'code',
  'danger',
  'mask',
] as const

export type PaletteColorKey = (typeof PALETTE_KEYS)[number]

/** 单个主题的配色覆盖；键全部可选，缺失的令牌沿用应用默认色 */
export type PaletteColors = Partial<Record<PaletteColorKey, string>>

/** color_palette：浅色与深色主题各自一套语义色 */
export type StylePalette = { light?: PaletteColors; dark?: PaletteColors }

/** index.json 的结构；schema 恒为 1 */
export type StyleManifest = {
  schema: 1
  id: string
  name: string
  description?: string
  author?: string
  version?: string
  sidebarTitle?: string
  icon?: { file: string }
  /** 详情页封面（可选）；路径规则与其它资源一致，只用包内文件 */
  cover?: { file: string }
  license?: { file: string }
  color_palette?: StylePalette
  assets: Record<string, StyleAssetEntry>
}

/** 设置页列表用的摘要；详情页需要的完整清单与许可证也在这里带出，避免再次读 IndexedDB */
export type StylePackSummary = {
  id: string
  name: string
  description?: string
  author?: string
  version?: string
  iconUrl?: string
  /** 封面图的 objectURL；列表刷新时与 iconUrl 一起 revoke */
  coverUrl?: string
  importedAt: number
  /** 详情页的完整清单（资源槽位 / 参数 / 调色板 / sidebarTitle） */
  manifest: StyleManifest
  /** 许可证全文；文件缺失或不安全时为 undefined */
  license?: string
}
