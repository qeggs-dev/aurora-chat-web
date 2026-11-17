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
  /** 仅图标资源生效：alpha 通道静态特效；背景 / 字体 / 文本上出现时导入忽略并 warn */
  effects?: StyleEffects
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

/**
 * 视觉特效：只用于图标类资源（icon.* 与包图标）。
 * 字段缺省时按 EFFECT_DEFAULTS 补齐；所有长度 / 角度都以资源原图像素为坐标系。
 */
export type StyleShadowEffect = {
  /** 水平偏移，-100..100 */
  x?: number
  /** 垂直偏移，-100..100 */
  y?: number
  /** 模糊半径，0..100 */
  blur?: number
  /** 阴影颜色，严格 CSS 颜色校验 */
  color?: string
}

export type StyleGlowEffect = {
  /** 半径，0..50 */
  radius?: number
  color?: string
  /** 强度，0..1 */
  intensity?: number
}

/**
 * 裁切窗口：归一化坐标（0–1，相对原图宽高），表示从 (x1,y1) 到 (x2,y2) 的可见区域。
 * 四个数都必须出现、在 0–1 之间，且 x1 < x2、y1 < y2。
 */
export type StyleWindowEffect = {
  x1?: number
  y1?: number
  x2?: number
  y2?: number
}

export type StyleEmbossEffect = {
  /** 浮雕深度（像素偏移），0..10 */
  depth?: number
  /** 光照方向，0..360 度（0 = 右，逆时针） */
  angle?: number
  /** 强度，0..1 */
  intensity?: number
}

export type StyleStrokeEffect = {
  /** 描边宽度，0..20 */
  width?: number
  color?: string
}

/** 卡片伪 3D 偏转：顶层 index.json 的 card.tilt，不是图片资源字段 */
export type StyleTiltEffect = {
  /** 最大偏转角，0..30 度 */
  maxAngle?: number
  /** 视距，200..2000 px */
  perspective?: number
  /** 偏转时的缩放，0.8..1.2 */
  scale?: number
}

export type StyleEffects = {
  /** 整体不透明度，0..1 */
  opacity?: number
  /** 映射为 CSS filter: drop-shadow()，天然按 alpha 生效 */
  shadow?: StyleShadowEffect
  /** alpha 外发光：派生图底层 */
  outerGlow?: StyleGlowEffect
  /** alpha 内发光：派生图层 */
  innerGlow?: StyleGlowEffect
  emboss?: StyleEmbossEffect
  stroke?: StyleStrokeEffect
  /** 裁切窗口：背景 / 图标 / 封面都可用 */
  window?: StyleWindowEffect
  /** 缩放倍率 0–4：1 不缩放、0 不显示；先在 window 内裁切，再以裁切区域中心缩放 */
  zoom?: number
  /**
   * 只用于校验拦截：图标资源上出现 tilt 报 badConfig。
   * 真正的卡片偏转配置在 StyleManifest.card.tilt 上。
   */
  tilt?: StyleTiltEffect
}

/** effects 允许的键（未知键导入时忽略并 warn） */
export const STYLE_EFFECT_KEYS = [
  'opacity',
  'shadow',
  'outerGlow',
  'innerGlow',
  'emboss',
  'stroke',
  'window',
  'zoom',
  'tilt',
] as const

/**
 * 特效字段缺省值：字段对象存在但没写某个子字段时用这里的值。
 * 例：`outerGlow: {}` 等价于 radius 10 / 白色 / 强度 1。
 */
export const EFFECT_DEFAULTS = {
  opacity: 1,
  shadow: { x: 0, y: 4, blur: 12, color: '#00000066' },
  outerGlow: { radius: 10, color: '#ffffff', intensity: 1 },
  innerGlow: { radius: 6, color: '#ffffff', intensity: 1 },
  emboss: { depth: 1.5, angle: 45, intensity: 0.6 },
  stroke: { width: 2, color: '#000000' },
  zoom: 1,
} as const

/** card.tilt 缺省值：只有写了 card.tilt 才启用，子字段按这里补齐 */
export const TILT_DEFAULTS = {
  maxAngle: 12,
  perspective: 700,
  scale: 1.02,
} as const

/** index.json 的结构；schema 恒为 1 */
export type StyleManifest = {
  schema: 1
  id: string
  name: string
  description?: string
  author?: string
  version?: string
  sidebarTitle?: string
  /** 包图标：可带静态 effects（tilt 报 badConfig） */
  icon?: { file: string; effects?: StyleEffects }
  /** 详情页封面（可选）：允许静态 effects 与 tilt（卡片偏转只在这里与图标资源上生效） */
  cover?: { file: string; effects?: StyleEffects }
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
