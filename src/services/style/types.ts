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

export type StyleAssetEntry = { file: string; alpha?: number; exposure?: number }

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
  license?: { file: string }
  color_palette?: StylePalette
  assets: Record<string, StyleAssetEntry>
}

/** 设置页列表用的摘要 */
export type StylePackSummary = {
  id: string
  name: string
  description?: string
  author?: string
  version?: string
  iconUrl?: string
  importedAt: number
}
