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
  // 第二轮扩充（P0）：把界面上直接内联的 SVG / 字符替换成样式包可覆盖的槽位。
  // 声明顺序与 README 资源 ID 表、tools/style-fixture/gen.mjs 的 40 槽位顺序保持一致。
  iconClose: `${STYLE_PREFIX}.icon.close`,
  iconRemove: `${STYLE_PREFIX}.icon.remove`,
  iconCheck: `${STYLE_PREFIX}.icon.check`,
  iconRefresh: `${STYLE_PREFIX}.icon.refresh`,
  iconSearch: `${STYLE_PREFIX}.icon.search`,
  iconWarning: `${STYLE_PREFIX}.icon.warning`,
  iconLink: `${STYLE_PREFIX}.icon.link`,
  iconChevronDown: `${STYLE_PREFIX}.icon.chevron_down`,
  iconPlay: `${STYLE_PREFIX}.icon.play`,
  iconUpload: `${STYLE_PREFIX}.icon.upload`,
  iconDownload: `${STYLE_PREFIX}.icon.download`,
  iconAdd: `${STYLE_PREFIX}.icon.add`,
  iconBack: `${STYLE_PREFIX}.icon.back`,
  iconMobileMenu: `${STYLE_PREFIX}.icon.mobile_menu`,
  iconBrowse: `${STYLE_PREFIX}.icon.browse`,
  iconSettingUsage: `${STYLE_PREFIX}.icon.setting.usage`,
  iconSettingStyle: `${STYLE_PREFIX}.icon.setting.style`,
  iconSettingPreset: `${STYLE_PREFIX}.icon.setting.preset`,
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

/**
 * 图标槽位：覆盖内置 SVG。
 * 直接从 STYLE_SLOTS 派生（过滤 `icon.` 前缀），不再手工维护第二份清单：
 * 新增图标槽位只改上面的 STYLE_SLOTS，派生顺序 = 声明顺序 = README 资源 ID 表与
 * tools/style-fixture/gen.mjs 的槽位顺序。当前没有消费方依赖这个顺序（只是列表 / 生成脚本使用）。
 */
export const ICON_SLOTS: StyleSlot[] = Object.values(STYLE_SLOTS).filter((slot) =>
  slot.startsWith(`${STYLE_PREFIX}.icon.`)
)

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
 * assets 项（解析后的清单）：`file` 一定是包内实际文件路径——导入时显式值优先，
 * 没写则按默认路径约定找到并补进来；找不到默认位置的资源不会出现在清单里。
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

/**
 * index.json 里 assets 项的原始写法（zip 解析输入）：
 * `file` 可省略，省略时按「默认路径约定」在包内查找（见 README「默认路径」）。
 */
export type StyleAssetEntryInput = Omit<StyleAssetEntry, 'file'> & { file?: string }

/** 按主题分组的图片 Blob（包图标 / 封面）；缺某个主题表示该主题没有这张图 */
export type ThemedBlobs = { light?: Blob; dark?: Blob }

/** 按主题分组的 objectURL；与 ThemedBlobs 一一对应，每个 URL 单独 revoke */
export type ThemedUrls = { light?: string; dark?: string }

/** 单个主题下的包图标 / 封面文件（effects 可按主题不同） */
export type StyleThemeFileRef = { file: string; effects?: StyleEffects }

/** index.json 里主题项的原始写法：`file` 可省略，省略时按该主题的默认位置查找 */
export type StyleThemeFileRefInput = { file?: string; effects?: StyleEffects }

/** 主题无关的单文件形式：亮/暗主题共用同一张图 */
export type StylePlainFileRef = { file: string; effects?: StyleEffects }

/** index.json 里主题无关写法的原始形式：`file` 可省略（按默认位置查找） */
export type StylePlainFileRefInput = { file?: string; effects?: StyleEffects }

/**
 * 顶层 `icon` / `cover` 解析后的引用，支持两种写法：
 *
 * - 主题无关：`{ "file": "icon.png", "effects": {...} }` —— 两个主题共用同一张图；
 * - 按主题：`{ "light": { "file": "light/icon.png" }, "dark": { "file": "dark/icon.png" } }`
 *   —— 每个主题可给不同文件；某个主题缺失文件时回退到同级的 `file`（都没有则该主题无图，
 *   不跨主题借用）。包级 `effects` 两个主题共用，写在主题项里的 `effects` 覆盖包级值。
 *
 * 解析结果里出现的主题项都带 `file`（显式值或默认路径补全）；索引里的原始写法
 * （file 可省略）见 StyleFileRefInput。
 */
export type StyleThemedFileRef = {
  light?: StyleThemeFileRef
  dark?: StyleThemeFileRef
  file?: string
  effects?: StyleEffects
}

export type StyleFileRef = StylePlainFileRef | StyleThemedFileRef

/** index.json 里 `icon` / `cover` 的原始写法：所有 `file` 都可省略（按默认位置查找） */
export type StyleThemedFileRefInput = {
  light?: StyleThemeFileRefInput
  dark?: StyleThemeFileRefInput
  file?: string
  effects?: StyleEffects
}

export type StyleFileRefInput = StylePlainFileRefInput | StyleThemedFileRefInput

/** 是否按主题分开了文件：只有出现 light / dark 时才算；只写 file 的仍按主题无关处理 */
export const isThemedFileRef = (ref: StyleFileRef): ref is StyleThemedFileRef =>
  'light' in ref || 'dark' in ref

/**
 * 取某个主题实际生效的文件与 effects。
 * 按主题写法里该主题缺文件时只用同级的 `file` 兜底，不会借用另一主题的文件；
 * 调用方如需「亮/暗互借」的展示回退，自行决定（列表图标 / 详情封面在 UI 层做）。
 */
export const resolveStyleFileRef = (
  ref: StyleFileRef | undefined,
  theme: Theme
): StyleThemeFileRef | undefined => {
  if (!ref) {
    return undefined
  }
  if (!isThemedFileRef(ref)) {
    return ref.file ? { file: ref.file, effects: ref.effects } : undefined
  }
  const entry = ref[theme]
  const file = entry?.file ?? ref.file
  return file ? { file, effects: entry?.effects ?? ref.effects } : undefined
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
  /**
   * 包图标：解析后的引用（file 为包内实际路径）。可带静态 effects（tilt 报 badConfig）；
   * `file` 或 `light` / `dark` 两种写法；导入时显式值优先，否则按默认路径补齐。
   */
  icon?: StyleFileRef
  /**
   * 详情页封面（可选）：整页背景，亮/暗主题可各给一张；解析后的引用（file 为实际路径）。
   * 仍接受静态 effects 与 tilt（旧包兼容），但整页背景只让 window / zoom 改变取图；
   * opacity / shadow / 光效 / tilt 对铺满内容区的背景不再产生视觉效果（README 已说明）。
   */
  cover?: StyleFileRef
  license?: { file: string }
  color_palette?: StylePalette
  assets: Record<string, StyleAssetEntry>
}

/**
 * index.json 的原始结构（zip 解析输入）：所有 `file` 字段都可省略。
 * 省略时按默认路径约定解析（显式值 > 默认位置）；解析完成后输出 StyleManifest，
 * 其中的 file 已补成包内实际条目名。
 */
export type StyleManifestInput = Omit<StyleManifest, 'icon' | 'cover' | 'license' | 'assets'> & {
  icon?: StyleFileRefInput
  cover?: StyleFileRefInput
  /** `{ file }` 或 `{}`（`{}` 与省略一样按默认位置查找 LICENSE） */
  license?: { file?: string }
  assets: Record<string, StyleAssetEntryInput>
}

/** 设置页列表用的摘要；详情页需要的完整清单与许可证也在这里带出，避免再次读 IndexedDB */
export type StylePackSummary = {
  id: string
  name: string
  description?: string
  author?: string
  version?: string
  /**
   * 包图标 objectURL，按主题分开；列表按当前主题取，缺该主题时回退另一主题。
   * 旧字段 `iconUrl` 已移除：读库时把旧的单个 Blob 归一化成两个主题同一个图。
   */
  iconUrls?: ThemedUrls
  /** 封面 objectURL，按主题分开；列表刷新时与 iconUrls 的每个主题 URL 一起 revoke */
  coverUrls?: ThemedUrls
  importedAt: number
  /** 随安装包分发的内置样式包：首次启动自动安装、不可删除、「恢复默认」回到它 */
  builtin?: boolean
  /**
   * 记录不完整（assets 缺失 / 零字节 Blob，来自备份恢复或异常写入）：
   * 列表标记「损坏」并提示重新导入，激活 / 恢复时跳过该记录。
   */
  broken?: boolean
  /** 详情页的完整清单（资源槽位 / 参数 / 调色板 / sidebarTitle） */
  manifest: StyleManifest
  /** 许可证全文；文件缺失或不安全时为 undefined */
  license?: string
}
