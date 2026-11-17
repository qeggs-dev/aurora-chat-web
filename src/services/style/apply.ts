/** 把启用样式包的资源写进 :root 的 CSS 变量；变量归零时原主题样式自然恢复。 */
import { BACKGROUND_SLOTS, STYLE_SLOTS, slotId, type StyleManifest, type Theme } from './types.js'

export type ActiveStyle = {
  id: string
  manifest: StyleManifest
  urls: Record<string, string>
  iconUrl?: string
  license?: string
}

/** 样式包字体统一注册成这个名字，字体栈里排在内置字体之前 */
const PACK_FONT_FAMILY = 'DSLikePackFont'

/** 背景槽位到 CSS 变量名的稳定映射 */
const BACKGROUND_SUFFIX: Record<string, string> = {
  [STYLE_SLOTS.bgMain]: 'main',
  [STYLE_SLOTS.bgChat]: 'chat',
  [STYLE_SLOTS.bgInputBox]: 'input-box',
  [STYLE_SLOTS.bgSidebar]: 'sidebar',
  [STYLE_SLOTS.bgNewSession]: 'new-session',
  [STYLE_SLOTS.bgSelectedSession]: 'selected-session',
  [STYLE_SLOTS.bgNormalSession]: 'normal-session',
  [STYLE_SLOTS.bgSettingGeneric]: 'setting-generic',
  [STYLE_SLOTS.bgSettingDatas]: 'setting-datas',
  [STYLE_SLOTS.bgSettingAbout]: 'setting-about',
}

type BackgroundVars = { image: string; alpha: string; brightness: string }

const backgroundVars = (slot: string): BackgroundVars | null => {
  const suffix = BACKGROUND_SUFFIX[slot]
  if (!suffix) {
    return null
  }
  return {
    image: `--dslike-bg-${suffix}-image`,
    alpha: `--dslike-bg-${suffix}-alpha`,
    brightness: `--dslike-bg-${suffix}-brightness`,
  }
}

const REMOVABLE_BACKGROUND_VARS = BACKGROUND_SLOTS.flatMap((slot) => {
  const vars = backgroundVars(slot)
  return vars ? [vars.image, vars.alpha, vars.brightness] : []
})

/** 已注册的 FontFace 与首次读取到的内置字体栈；清空时据此还原 */
let registeredFace: FontFace | null = null
let baseFontFamily: string | null = null
/** 连续切换主题/样式包时，只有最后一次调用允许写入字体 */
let applySequence = 0

const readBaseFontFamily = (): string => {
  if (baseFontFamily === null) {
    baseFontFamily =
      getComputedStyle(document.documentElement).getPropertyValue('--dsw-font-family').trim() ||
      'system-ui, sans-serif'
  }
  return baseFontFamily
}

const clearFont = () => {
  if (registeredFace) {
    document.fonts.delete(registeredFace)
    registeredFace = null
  }
  document.documentElement.style.removeProperty('--dsw-font-family')
}

const applyFont = async (active: ActiveStyle, theme: Theme, sequence: number): Promise<void> => {
  const assetId = slotId(STYLE_SLOTS.font, theme)
  const url = active.urls[assetId]
  if (!url) {
    return
  }
  const stack = readBaseFontFamily().replace(/\s+/g, ' ')
  let face: FontFace
  try {
    face = new FontFace(PACK_FONT_FAMILY, `url(${url})`)
    await face.load()
  } catch {
    // 字体加载失败时保留内置字体，不影响背景
    return
  }
  if (sequence !== applySequence) {
    return
  }
  registeredFace = face
  document.fonts.add(face)
  document.documentElement.style.setProperty('--dsw-font-family', `'${PACK_FONT_FAMILY}', ${stack}`)
}

/** 应用（active 非空）或清除（active 为 null）样式包；主题决定取哪一套资源 */
export const applyStyleVars = async (active: ActiveStyle | null, theme: Theme): Promise<void> => {
  const sequence = ++applySequence
  const root = document.documentElement
  for (const name of REMOVABLE_BACKGROUND_VARS) {
    root.style.removeProperty(name)
  }
  clearFont()

  if (!active) {
    delete root.dataset.stylePack
    return
  }

  for (const slot of BACKGROUND_SLOTS) {
    const vars = backgroundVars(slot)
    const assetId = slotId(slot, theme)
    const url = active.urls[assetId]
    if (!vars || !url) {
      continue
    }
    const asset = active.manifest.assets[assetId]
    root.style.setProperty(vars.image, `url(${url})`)
    root.style.setProperty(vars.alpha, String(asset?.alpha ?? 1))
    root.style.setProperty(vars.brightness, String(1 + (asset?.exposure ?? 0)))
  }

  root.dataset.stylePack = active.id
  await applyFont(active, theme, sequence)
}
