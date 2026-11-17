/** 把启用样式包的资源写进 CSS 变量（资源在 :root，配色在 body）；变量归零时原主题样式自然恢复。 */
import {
  BACKGROUND_SLOTS,
  PALETTE_KEYS,
  STYLE_SLOTS,
  slotId,
  type PaletteColorKey,
  type PaletteColors,
  type StyleManifest,
  type Theme,
} from './types.js'

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

/** 语义色 → 主题别名变量；别名定义在 body 上，所以配色必须写到 body.style 才盖得住 */
const PALETTE_VARS: Record<PaletteColorKey, string[]> = {
  background: ['--dsw-alias-bg-base'],
  surface: [
    '--dsw-alias-bg-layer-2',
    '--dsw-alias-bg-layer-3',
    '--dsw-specific-input-major',
    '--dsw-specific-menu',
    '--dsw-alias-button-elevated-fill',
  ],
  surface_alt: [
    '--dsw-specific-sidebar-fill',
    '--dsw-specific-selector',
    '--dsw-alias-markdown-code-block',
    '--dsw-alias-markdown-code-block-banner',
    '--dsw-alias-markdown-inline-code',
    '--dsw-alias-markdown-tag',
    '--dsw-alias-markdown-placeholder',
  ],
  text: ['--dsw-alias-label-primary', '--dsw-alias-label-primary-inverted'],
  text_secondary: [
    '--dsw-alias-label-secondary',
    '--dsw-alias-toast-bg',
    '--dsw-alias-tooltip-bg',
    '--dsw-alias-button-contrast-fill',
  ],
  text_tertiary: ['--dsw-alias-label-tertiary', '--dsw-alias-label-caption', '--dsw-alias-label-dimmed'],
  border: [
    '--dsw-alias-border-l1',
    '--dsw-alias-border-l2',
    '--dsw-alias-border-l3',
    '--dsw-alias-border-l2-darkmode-thin',
  ],
  accent: [
    '--dsw-alias-brand-primary',
    '--dsw-alias-brand-text',
    '--dsw-alias-button-primary-fill',
    '--dsw-alias-button-primary-hover',
    '--dsw-alias-button-ghost-active-border',
  ],
  accent_text: ['--dsw-alias-label-primary-foreground', '--dsw-static-neutral-bluish-00'],
  bubble: ['--dsw-specific-bubble'],
  code: ['--dsw-alias-markdown-code-block', '--dsw-alias-markdown-code-block-banner'],
  danger: ['--dsw-alias-state-error-primary', '--dsw-alias-state-error-secondary'],
  mask: ['--dslike-mask'],
}

/** text 存在时派生的半透明交互层（百分比 = 颜色叠加强度） */
const PALETTE_TEXT_DERIVED: Array<[string, string]> = [
  ['--dsw-alias-interactive-bg-hover', '6%'],
  ['--dsw-alias-interactive-bg-active', '10%'],
  ['--dsw-alias-interactive-bg-hover-accent', '14%'],
  ['--dsw-alias-interactive-bg-hover-danger', '8%'],
  ['--dsw-specific-sidebar-nav-item-hover', '8%'],
  ['--dsw-alias-bg-skeleton', '4%'],
]

/** accent 存在时派生的半透明强调层 */
const PALETTE_ACCENT_DERIVED: Array<[string, string]> = [
  ['--dsw-alias-button-ghost-active-fill', '12%'],
  ['--dsw-alias-button-ghost-active-hover', '20%'],
  ['--dsw-specific-sidebar-nav-item-active-accent', '16%'],
]

/** 清空时要移除的全部配色变量（映射 + 派生） */
const REMOVABLE_PALETTE_VARS = [
  ...new Set([
    ...Object.values(PALETTE_VARS).flat(),
    ...PALETTE_TEXT_DERIVED.map(([name]) => name),
    ...PALETTE_ACCENT_DERIVED.map(([name]) => name),
  ]),
]

/** 配色里的 background 当前是否正通过 inline style 控制页面画布 */
let paletteBackgroundApplied = false

const themeColorMeta = (): HTMLMetaElement | null => document.querySelector('meta[name="theme-color"]')

/** background 存在时同步根画布与浏览器栏；不存在时回到 body 计算出的主题默认背景 */
const syncPaletteBackground = (background: string | undefined): void => {
  const root = document.documentElement
  const meta = themeColorMeta()
  if (background) {
    root.style.backgroundColor = background
    meta?.setAttribute('content', background)
    paletteBackgroundApplied = true
    return
  }
  if (!paletteBackgroundApplied) {
    return
  }
  paletteBackgroundApplied = false
  // 配色变量已移除，此时 body 的计算背景色就是主题默认值
  const fallback = getComputedStyle(document.body).backgroundColor
  root.style.backgroundColor = fallback
  meta?.setAttribute('content', fallback)
}

/** 按当前主题应用（colors 为空则清除）配色：先清掉上一次写入的变量，再写映射与派生 */
const applyPalette = (colors: PaletteColors | undefined): void => {
  const body = document.body
  for (const name of REMOVABLE_PALETTE_VARS) {
    body.style.removeProperty(name)
  }
  if (colors) {
    for (const key of PALETTE_KEYS) {
      const value = colors[key]
      if (!value) {
        continue
      }
      for (const name of PALETTE_VARS[key]) {
        body.style.setProperty(name, value)
      }
    }
    if (colors.text) {
      for (const [name, strength] of PALETTE_TEXT_DERIVED) {
        body.style.setProperty(name, `color-mix(in srgb, ${colors.text} ${strength}, transparent)`)
      }
    }
    if (colors.accent) {
      for (const [name, strength] of PALETTE_ACCENT_DERIVED) {
        body.style.setProperty(name, `color-mix(in srgb, ${colors.accent} ${strength}, transparent)`)
      }
    }
  }
  syncPaletteBackground(colors?.background)
}

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
    applyPalette(undefined)
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

  applyPalette(active.manifest.color_palette?.[theme])

  root.dataset.stylePack = active.id
  await applyFont(active, theme, sequence)
}
