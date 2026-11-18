/**
 * 就地编辑模式里控件的展示名（中文 / 英文成对，见 i18n 的 styleSlot*）。
 *
 * `targets.ts` 只负责 DOM 约定与纯函数形式的兜底名（`icon.send` 这类技术名），
 * 这里把它映射到界面文案：右键菜单标题、面板编辑标题、控件选择列表都用这套名称。
 * 未登记的槽位回退到 `styleEditTargetLabel` 的技术名，保证新增槽位不会显示为空。
 */
import { useTranslate } from '../../i18n/index.js'
import type { TranslationKey } from '../../i18n/index.js'
import { STYLE_SLOTS } from '../../services/style/types.js'
import { STYLE_EDIT_SIDEBAR_TITLE, styleEditTargetLabel } from './targets.js'

/** 资源槽位 / 侧边栏标题 → i18n key */
const SLOT_LABEL_KEYS: Record<string, TranslationKey> = {
  // 背景（10 个可编辑槽位）
  [STYLE_SLOTS.bgMain]: 'styleSlotBgMain',
  [STYLE_SLOTS.bgChat]: 'styleSlotBgChat',
  [STYLE_SLOTS.bgInputBox]: 'styleSlotBgInputBox',
  [STYLE_SLOTS.bgSidebar]: 'styleSlotBgSidebar',
  [STYLE_SLOTS.bgNewSession]: 'styleSlotBgNewSession',
  [STYLE_SLOTS.bgSelectedSession]: 'styleSlotBgSelectedSession',
  [STYLE_SLOTS.bgNormalSession]: 'styleSlotBgNormalSession',
  [STYLE_SLOTS.bgSettingGeneric]: 'styleSlotBgSettingGeneric',
  [STYLE_SLOTS.bgSettingDatas]: 'styleSlotBgSettingDatas',
  [STYLE_SLOTS.bgSettingAbout]: 'styleSlotBgSettingAbout',
  // 图标（40 个槽位，顺序与 STYLE_SLOTS 一致）
  [STYLE_SLOTS.iconNewSession]: 'styleSlotIconNewSession',
  [STYLE_SLOTS.iconEnterSidebar]: 'styleSlotIconEnterSidebar',
  [STYLE_SLOTS.iconExitSidebar]: 'styleSlotIconExitSidebar',
  [STYLE_SLOTS.iconThinking]: 'styleSlotIconThinking',
  [STYLE_SLOTS.iconNetwork]: 'styleSlotIconNetwork',
  [STYLE_SLOTS.iconSoundInput]: 'styleSlotIconSoundInput',
  [STYLE_SLOTS.iconLinkFile]: 'styleSlotIconLinkFile',
  [STYLE_SLOTS.iconEdit]: 'styleSlotIconEdit',
  [STYLE_SLOTS.iconMenu]: 'styleSlotIconMenu',
  [STYLE_SLOTS.iconDelete]: 'styleSlotIconDelete',
  [STYLE_SLOTS.iconCopy]: 'styleSlotIconCopy',
  [STYLE_SLOTS.iconRegen]: 'styleSlotIconRegen',
  [STYLE_SLOTS.iconSend]: 'styleSlotIconSend',
  [STYLE_SLOTS.iconStop]: 'styleSlotIconStop',
  [STYLE_SLOTS.iconLeftArrow]: 'styleSlotIconLeftArrow',
  [STYLE_SLOTS.iconRightArrow]: 'styleSlotIconRightArrow',
  [STYLE_SLOTS.iconSettingSetting]: 'styleSlotIconSettingSetting',
  [STYLE_SLOTS.iconSettingLight]: 'styleSlotIconSettingLight',
  [STYLE_SLOTS.iconSettingDark]: 'styleSlotIconSettingDark',
  [STYLE_SLOTS.iconSettingDevice]: 'styleSlotIconSettingDevice',
  [STYLE_SLOTS.iconSettingDatas]: 'styleSlotIconSettingDatas',
  [STYLE_SLOTS.iconSettingAbout]: 'styleSlotIconSettingAbout',
  [STYLE_SLOTS.iconClose]: 'styleSlotIconClose',
  [STYLE_SLOTS.iconRemove]: 'styleSlotIconRemove',
  [STYLE_SLOTS.iconCheck]: 'styleSlotIconCheck',
  [STYLE_SLOTS.iconRefresh]: 'styleSlotIconRefresh',
  [STYLE_SLOTS.iconSearch]: 'styleSlotIconSearch',
  [STYLE_SLOTS.iconWarning]: 'styleSlotIconWarning',
  [STYLE_SLOTS.iconLink]: 'styleSlotIconLink',
  [STYLE_SLOTS.iconChevronDown]: 'styleSlotIconChevronDown',
  [STYLE_SLOTS.iconPlay]: 'styleSlotIconPlay',
  [STYLE_SLOTS.iconUpload]: 'styleSlotIconUpload',
  [STYLE_SLOTS.iconDownload]: 'styleSlotIconDownload',
  [STYLE_SLOTS.iconAdd]: 'styleSlotIconAdd',
  [STYLE_SLOTS.iconBack]: 'styleSlotIconBack',
  [STYLE_SLOTS.iconMobileMenu]: 'styleSlotIconMobileMenu',
  [STYLE_SLOTS.iconBrowse]: 'styleSlotIconBrowse',
  [STYLE_SLOTS.iconSettingUsage]: 'styleSlotIconSettingUsage',
  [STYLE_SLOTS.iconSettingStyle]: 'styleSlotIconSettingStyle',
  [STYLE_SLOTS.iconSettingPreset]: 'styleSlotIconSettingPreset',
  // 非资源控件
  [STYLE_EDIT_SIDEBAR_TITLE]: 'styleSlotSidebarTitle',
}

/** 槽位对应的界面名称 key；未登记时返回 undefined */
export const styleSlotLabelKey = (target: string): TranslationKey | undefined =>
  SLOT_LABEL_KEYS[target]

/** 槽位的界面名称；未登记时回退到技术名（`styleEditTargetLabel`） */
export const useStyleSlotLabel = (): ((target: string) => string) => {
  const t = useTranslate()
  return (target: string): string => {
    const key = styleSlotLabelKey(target)
    return key ? t(key) : styleEditTargetLabel(target)
  }
}
