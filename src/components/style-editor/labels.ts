/**
 * 样式包编辑 / 详情共用的枚举文案映射。
 *
 * effects 组、effects 字段、fit / align / render、配色令牌在清单里都是技术值（英文 key），
 * 但界面上必须显示本地化文案；三处 UI（详情页 chips / 悬浮面板 / 元数据编辑）统一走这里，
 * 技术值只保留在数据、`data-*` 属性与 aria 里，不再直接进入可见文本。
 *
 * 查找不到映射时回退到「其他…」通用文案，不回退到原始技术名。
 */
import { useTranslate } from '../../i18n/index.js'
import type { TranslationKey } from '../../i18n/index.js'
import {
  STYLE_ALIGNS,
  STYLE_FITS,
  STYLE_RENDERS,
  type PaletteColorKey,
  type StyleAlign,
  type StyleEffectsKey,
  type StyleFit,
  type StyleRender,
} from '../../services/style/types.js'

/** effects 组 → i18n key */
export const EFFECT_GROUP_LABEL_KEYS: Record<StyleEffectsKey, TranslationKey> = {
  opacity: 'styleEffectGroupOpacity',
  shadow: 'styleEffectGroupShadow',
  outerGlow: 'styleEffectGroupOuterGlow',
  innerGlow: 'styleEffectGroupInnerGlow',
  emboss: 'styleEffectGroupEmboss',
  stroke: 'styleEffectGroupStroke',
  window: 'styleEffectGroupWindow',
  zoom: 'styleEffectGroupZoom',
  tilt: 'styleEffectGroupTilt',
}

/** effects 子字段 → i18n key（不同效果组共用同一批字段名） */
export const EFFECT_FIELD_LABEL_KEYS: Record<string, TranslationKey> = {
  x: 'styleEffectFieldX',
  y: 'styleEffectFieldY',
  blur: 'styleEffectFieldBlur',
  color: 'styleEffectFieldColor',
  radius: 'styleEffectFieldRadius',
  intensity: 'styleEffectFieldIntensity',
  depth: 'styleEffectFieldDepth',
  angle: 'styleEffectFieldAngle',
  width: 'styleEffectFieldWidth',
  x1: 'styleEffectFieldX1',
  y1: 'styleEffectFieldY1',
  x2: 'styleEffectFieldX2',
  y2: 'styleEffectFieldY2',
  maxAngle: 'styleEffectFieldMaxAngle',
  perspective: 'styleEffectFieldPerspective',
  scale: 'styleEffectFieldScale',
}

/** color_palette 语义令牌 → i18n key */
export const PALETTE_TOKEN_LABEL_KEYS: Record<PaletteColorKey, TranslationKey> = {
  background: 'stylePaletteTokenBackground',
  surface: 'stylePaletteTokenSurface',
  surface_alt: 'stylePaletteTokenSurfaceAlt',
  text: 'stylePaletteTokenText',
  text_secondary: 'stylePaletteTokenTextSecondary',
  text_tertiary: 'stylePaletteTokenTextTertiary',
  border: 'stylePaletteTokenBorder',
  accent: 'stylePaletteTokenAccent',
  accent_text: 'stylePaletteTokenAccentText',
  bubble: 'stylePaletteTokenBubble',
  code: 'stylePaletteTokenCode',
  danger: 'stylePaletteTokenDanger',
  mask: 'stylePaletteTokenMask',
}

export const STYLE_FIT_LABEL_KEYS: Record<StyleFit, TranslationKey> = {
  cover: 'styleFitCover',
  contain: 'styleFitContain',
  stretch: 'styleFitStretch',
  tile: 'styleFitTile',
}

export const STYLE_ALIGN_LABEL_KEYS: Record<StyleAlign, TranslationKey> = {
  'top-left': 'styleAlignTopLeft',
  'top-center': 'styleAlignTopCenter',
  'top-right': 'styleAlignTopRight',
  'center-left': 'styleAlignCenterLeft',
  center: 'styleAlignCenter',
  'center-right': 'styleAlignCenterRight',
  'bottom-left': 'styleAlignBottomLeft',
  'bottom-center': 'styleAlignBottomCenter',
  'bottom-right': 'styleAlignBottomRight',
  custom: 'styleAlignCustom',
}

export const STYLE_RENDER_LABEL_KEYS: Record<StyleRender, TranslationKey> = {
  auto: 'styleRenderAuto',
  smooth: 'styleRenderSmooth',
  pixelated: 'styleRenderPixelated',
  'crisp-edges': 'styleRenderCrispEdges',
  'high-quality': 'styleRenderHighQuality',
  'optimize-speed': 'styleRenderOptimizeSpeed',
  'optimize-quality': 'styleRenderOptimizeQuality',
}

/** effects 组文案 key；未登记时回退到通用文案，不显示原始技术名 */
export const effectGroupLabelKey = (group: string): TranslationKey =>
  EFFECT_GROUP_LABEL_KEYS[group as StyleEffectsKey] ?? 'styleEffectGroupOther'

/** effects 字段文案 key；未登记时回退到通用文案 */
export const effectFieldLabelKey = (field: string): TranslationKey =>
  EFFECT_FIELD_LABEL_KEYS[field] ?? 'styleEffectFieldOther'

/** 配色令牌文案 key；未登记时回退到通用文案 */
export const paletteTokenLabelKey = (token: string): TranslationKey =>
  PALETTE_TOKEN_LABEL_KEYS[token as PaletteColorKey] ?? 'stylePaletteTokenOther'

export const styleFitLabelKey = (value: string): TranslationKey =>
  STYLE_FIT_LABEL_KEYS[value as StyleFit] ?? 'styleFitOther'

export const styleAlignLabelKey = (value: string): TranslationKey =>
  STYLE_ALIGN_LABEL_KEYS[value as StyleAlign] ?? 'styleAlignOther'

export const styleRenderLabelKey = (value: string): TranslationKey =>
  STYLE_RENDER_LABEL_KEYS[value as StyleRender] ?? 'styleRenderOther'

/** 详情页 / 面板 / 元数据编辑共用的枚举文案解析 */
export const useStyleLabels = () => {
  const t = useTranslate()
  return {
    effectGroup: (group: string): string => t(effectGroupLabelKey(group)),
    effectField: (field: string): string => t(effectFieldLabelKey(field)),
    palette: (token: string): string => t(paletteTokenLabelKey(token)),
    fit: (value: string): string => t(styleFitLabelKey(value)),
    align: (value: string): string => t(styleAlignLabelKey(value)),
    render: (value: string): string => t(styleRenderLabelKey(value)),
  }
}

/** 背景 / 图标排版下拉选项（fit / align / render），label 已本地化，value 仍是技术枚举 */
export const useStyleEnumOptions = () => {
  const labels = useStyleLabels()
  return {
    fitOptions: STYLE_FITS.map((value) => ({ value, label: labels.fit(value) })),
    alignOptions: STYLE_ALIGNS.map((value) => ({ value, label: labels.align(value) })),
    renderOptions: STYLE_RENDERS.map((value) => ({ value, label: labels.render(value) })),
  }
}
