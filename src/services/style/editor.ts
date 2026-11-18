/**
 * 轻量样式包编辑器的纯逻辑：草稿模型、id 生成、字段级校验、草稿 → StoredStylePack /
 * zip 资源的组装。不碰 DOM，因此可以在 node:test 里直接覆盖。
 *
 * 校验规则与 `zip.ts` 的导入校验共用同一份常量（id 格式、CSS 颜色、扩展名、大小上限，
 * 都从 zip.ts 导出），保证「编辑器保存 / 导出的包一定能被 parseStylePackZip 重新读取」。
 */
import type { StoredStylePack } from './db.js'
import {
  BACKGROUND_SLOTS,
  ICON_SLOTS,
  PALETTE_KEYS,
  STYLE_ALIGN_DEFAULT,
  STYLE_FIT_DEFAULT,
  STYLE_PREFIX,
  STYLE_RENDER_DEFAULT,
  STYLE_SLOTS,
  isSafePosition,
  resolveStyleFileRef,
  slotId,
  type PaletteColors,
  type StyleAlign,
  type StyleAssetEntry,
  type StyleEffects,
  type StyleFileRef,
  type StyleFit,
  type StyleManifest,
  type StylePalette,
  type StyleRender,
  type StyleSlot,
  type Theme,
  type ThemedBlobs,
} from './types.js'
import {
  COVER_EXT_ORDER,
  FONT_EXT_ORDER,
  IMAGE_EXT_ORDER,
  MAX_COVER_BYTES,
  MAX_LICENSE_BYTES,
  MAX_TOTAL_BYTES,
  STYLE_ID_PATTERN,
  isStyleCssColor,
  isUnsafeStyleText,
} from './zip.js'

/** 新建样式包 id 的前缀：`custom-<timestamp36>` */
export const EDITOR_ID_PREFIX = 'custom-'
/** 新建样式包的默认版本号 */
export const EDITOR_DEFAULT_VERSION = '1.0.0'
/** 内置极光样式包 id：编辑器不允许使用（避免覆盖内置包） */
export const BUILTIN_STYLE_PACK_ID = 'aurora'
/** zip 内清单与许可证的固定路径（与 docs/style-packs.md 的包结构一致） */
export const STYLE_DRAFT_INDEX_FILE = 'index.json'
export const STYLE_DRAFT_LICENSE_FILE = 'LICENSE'

/** 文本字段上限（与 zip.ts 导入规则一致；description 允许换行） */
export const MAX_NAME_LENGTH = 80
export const MAX_META_TEXT_LENGTH = 400
export const MAX_COPYRIGHT_LENGTH = 400
export const MAX_SIDEBAR_TITLE_LENGTH = 40

/** 单个上传文件的大小上限 */
export const MAX_BACKGROUND_FILE_BYTES = 5 * 1024 * 1024
export const MAX_ICON_FILE_BYTES = 1 * 1024 * 1024
export const MAX_FONT_FILE_BYTES = 5 * 1024 * 1024
export const MAX_PACK_ICON_FILE_BYTES = 5 * 1024 * 1024
export const MAX_COVER_FILE_BYTES = MAX_COVER_BYTES
export const MAX_LICENSE_TEXT_BYTES = MAX_LICENSE_BYTES
/** 整个样式包的原始资源总量上限（对齐导入器的解压后总大小上限） */
export const MAX_DRAFT_TOTAL_BYTES = MAX_TOTAL_BYTES

/** 主题顺序固定：数组 / 签名的顺序稳定，UI 与导出都不受对象键顺序影响 */
export const EDITOR_THEMES: readonly Theme[] = ['light', 'dark']

/** 草稿里的文件类型；决定扩展名白名单与大小上限 */
export type StyleDraftFileKind = 'background' | 'icon' | 'font' | 'packIcon' | 'cover'

/** 草稿里的单个资源文件：Blob + 扩展名 + 展示文件名 */
export type StyleDraftFile = {
  blob: Blob
  /** 小写扩展名（不含点），决定 zip 条目名与文件类型校验 */
  ext: string
  /** 展示用文件名（上传时的原名，或原包内路径的文件名） */
  fileName: string
  /** 图标 / 封面 / 包图标可带的视觉特效（effects），背景只应用其中的 window / zoom */
  effects?: StyleEffects
  /** 图标资源的缩放采样方式（映射到 image-rendering），其它资源忽略 */
  render?: StyleRender
}

/** 背景槽位在文件之外还能带 fit / align / position / render 四个排版字段 */
export type StyleDraftBackground = Omit<StyleDraftFile, 'render'> & {
  fit?: StyleFit
  align?: StyleAlign
  position?: string
  render?: StyleRender
}

/** 按主题分组的槽位资源（10 个背景 / 40 个图标） */
export type StyleDraftThemedSlots<T> = Record<Theme, Partial<Record<StyleSlot, T>>>

/** 编辑器草稿：保存 / 导出只依赖它，`theme` 只是「当前编辑哪个主题」的 UI 状态 */
export type StyleEditorDraft = {
  id: string
  name: string
  author: string
  version: string
  description: string
  /** 版权声明（必填；写进 LICENSE 文件） */
  copyright: string
  /** License 全文（可选） */
  licenseText: string
  sidebarTitle: string
  /** 编辑器当前编辑的目标主题（背景 / 图标 / 字体 / 配色跟着它切换） */
  theme: Theme
  backgrounds: StyleDraftThemedSlots<StyleDraftBackground>
  icons: StyleDraftThemedSlots<StyleDraftFile>
  fonts: Partial<Record<Theme, StyleDraftFile>>
  packIcons: Partial<Record<Theme, StyleDraftFile>>
  covers: Partial<Record<Theme, StyleDraftFile>>
  palette: Record<Theme, PaletteColors>
}

/** 上传文件的扩展名（小写、不含点）；无扩展名返回空串 */
export const fileExtension = (name: string): string => {
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase()
}

/** 用上传的 File（或从已存包读出的 Blob + 原路径文件名）构造草稿文件 */
export const createDraftFile = (blob: Blob, fileName: string): StyleDraftFile => ({
  blob,
  ext: fileExtension(fileName),
  fileName,
})

/**
 * 生成新建样式包的 id：`custom-<timestamp36>`。
 * 与已有 id 冲突时（同一毫秒内重复创建）追加 `-2`、`-3`… 兜底，仍符合 id 格式。
 */
export const createStylePackId = (
  now: number = Date.now(),
  takenIds: Iterable<string> = []
): string => {
  const base = `${EDITOR_ID_PREFIX}${Math.floor(now).toString(36)}`
  const taken = new Set(takenIds)
  if (!taken.has(base)) {
    return base
  }
  let suffix = 2
  while (taken.has(`${base}-${suffix}`)) {
    suffix += 1
  }
  return `${base}-${suffix}`
}

export type CreateStyleEditorDraftOptions = {
  /** 指定 id（编辑已有包时用）；省略时按当前时间生成 */
  id?: string
  theme?: Theme
  takenIds?: Iterable<string>
  now?: number
}

/** 新建空草稿：版本默认 1.0.0，主题默认亮色 */
export const createStyleEditorDraft = (
  options: CreateStyleEditorDraftOptions = {}
): StyleEditorDraft => ({
  id: options.id ?? createStylePackId(options.now, options.takenIds),
  name: '',
  author: '',
  version: EDITOR_DEFAULT_VERSION,
  description: '',
  copyright: '',
  licenseText: '',
  sidebarTitle: '',
  theme: options.theme ?? 'light',
  backgrounds: { light: {}, dark: {} },
  icons: { light: {}, dark: {} },
  fonts: {},
  packIcons: {},
  covers: {},
  palette: { light: {}, dark: {} },
})

/** 每种文件的扩展名白名单与大小上限（与 zip.ts 导入规则对齐） */
export const STYLE_DRAFT_FILE_RULES: Record<
  StyleDraftFileKind,
  { extensions: readonly string[]; maxBytes: number }
> = {
  background: { extensions: IMAGE_EXT_ORDER, maxBytes: MAX_BACKGROUND_FILE_BYTES },
  icon: { extensions: IMAGE_EXT_ORDER, maxBytes: MAX_ICON_FILE_BYTES },
  font: { extensions: FONT_EXT_ORDER, maxBytes: MAX_FONT_FILE_BYTES },
  packIcon: { extensions: IMAGE_EXT_ORDER, maxBytes: MAX_PACK_ICON_FILE_BYTES },
  cover: { extensions: COVER_EXT_ORDER, maxBytes: MAX_COVER_FILE_BYTES },
}

export type StyleDraftIssueCode =
  | 'required'
  | 'tooLong'
  | 'badId'
  | 'reservedId'
  | 'unsafeText'
  | 'badColor'
  | 'badPosition'
  | 'badFileType'
  | 'tooLarge'
  | 'totalTooLarge'
  | 'noAssets'
  | 'emptyFile'
  | 'badEffect'

export type StyleDraftIssueParams = {
  /** 文本长度 / 字节数上限 */
  max?: number
  /** 被拒绝的文件名或扩展名 */
  name?: string
  /** 允许的扩展名列表（展示用） */
  extensions?: string
  /** 被占用的 id（reservedId 用） */
  value?: string
}

/** 字段级校验问题：`path` 与编辑器表单字段一一对应，UI 据此把文案贴到对应字段 */
export type StyleDraftIssue = {
  path: string
  code: StyleDraftIssueCode
  params?: StyleDraftIssueParams
}

/** 单文件校验：扩展名白名单 + 大小上限 + 拒绝空文件（空 Blob 会被完整性检查当成损坏记录） */
export const validateDraftFile = (
  file: StyleDraftFile,
  kind: StyleDraftFileKind,
  path = ''
): StyleDraftIssue | undefined => {
  const rule = STYLE_DRAFT_FILE_RULES[kind]
  if (!rule.extensions.includes(file.ext)) {
    return {
      path,
      code: 'badFileType',
      params: {
        name: file.fileName || file.ext || '?',
        extensions: rule.extensions.join(' / '),
      },
    }
  }
  if (file.blob.size === 0) {
    return { path, code: 'emptyFile', params: { name: file.fileName } }
  }
  if (file.blob.size > rule.maxBytes) {
    return { path, code: 'tooLarge', params: { max: rule.maxBytes, name: file.fileName } }
  }
  return undefined
}

/** 必填 / 长度 / 文本安全三项的通用校验 */
const textIssues = (
  path: string,
  value: string,
  options: { required: boolean; max: number; multiline?: boolean }
): StyleDraftIssue[] => {
  const issues: StyleDraftIssue[] = []
  const trimmed = value.trim()
  if (options.required && !trimmed) {
    issues.push({ path, code: 'required' })
  }
  if (trimmed.length > options.max) {
    issues.push({ path, code: 'tooLong', params: { max: options.max } })
  }
  if (isUnsafeStyleText(value, options.multiline ?? false)) {
    issues.push({ path, code: 'unsafeText' })
  }
  return issues
}

const inRange = (value: unknown, min: number, max: number): boolean =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max

/**
 * effects 校验：范围与允许矩阵与 zip.ts 的导入校验一致（见 docs/style-packs.md「视觉特效」）。
 * `allowTilt` 为 false 时出现 tilt 视为非法（背景 / 包图标不允许 tilt）。
 */
const effectIssues = (
  effects: StyleEffects | undefined,
  allowTilt: boolean,
  path: string
): StyleDraftIssue[] => {
  if (!effects) {
    return []
  }
  const issues: StyleDraftIssue[] = []
  const bad = (name: string): void => {
    issues.push({ path, code: 'badEffect', params: { name } })
  }
  const color = (value: unknown, name: string): void => {
    if (value !== undefined && !isStyleCssColor(value)) {
      issues.push({ path, code: 'badColor', params: { name } })
    }
  }
  if (effects.opacity !== undefined && !inRange(effects.opacity, 0, 1)) {
    bad('opacity')
  }
  if (effects.shadow) {
    const shadow = effects.shadow
    if (shadow.x !== undefined && !inRange(shadow.x, -100, 100)) {
      bad('shadow.x')
    }
    if (shadow.y !== undefined && !inRange(shadow.y, -100, 100)) {
      bad('shadow.y')
    }
    if (shadow.blur !== undefined && !inRange(shadow.blur, 0, 100)) {
      bad('shadow.blur')
    }
    color(shadow.color, 'shadow.color')
  }
  for (const [name, glow] of [
    ['outerGlow', effects.outerGlow],
    ['innerGlow', effects.innerGlow],
  ] as const) {
    if (!glow) {
      continue
    }
    if (glow.radius !== undefined && !inRange(glow.radius, 0, 50)) {
      bad(`${name}.radius`)
    }
    if (glow.intensity !== undefined && !inRange(glow.intensity, 0, 1)) {
      bad(`${name}.intensity`)
    }
    color(glow.color, `${name}.color`)
  }
  if (effects.emboss) {
    const emboss = effects.emboss
    if (emboss.depth !== undefined && !inRange(emboss.depth, 0, 10)) {
      bad('emboss.depth')
    }
    if (emboss.angle !== undefined && !inRange(emboss.angle, 0, 360)) {
      bad('emboss.angle')
    }
    if (emboss.intensity !== undefined && !inRange(emboss.intensity, 0, 1)) {
      bad('emboss.intensity')
    }
  }
  if (effects.stroke) {
    if (effects.stroke.width !== undefined && !inRange(effects.stroke.width, 0, 20)) {
      bad('stroke.width')
    }
    color(effects.stroke.color, 'stroke.color')
  }
  if (effects.window) {
    const window = effects.window
    const coords = [window.x1, window.y1, window.x2, window.y2]
    if (coords.some((value) => !inRange(value, 0, 1))) {
      bad('window')
    } else if ((window.x1 as number) >= (window.x2 as number)) {
      bad('window.x1 < window.x2')
    } else if ((window.y1 as number) >= (window.y2 as number)) {
      bad('window.y1 < window.y2')
    }
  }
  if (effects.zoom !== undefined && !inRange(effects.zoom, 0, 4)) {
    bad('zoom')
  }
  if (effects.tilt) {
    if (!allowTilt) {
      bad('tilt')
      return issues
    }
    const tilt = effects.tilt
    if (tilt.maxAngle !== undefined && !inRange(tilt.maxAngle, 0, 30)) {
      bad('tilt.maxAngle')
    }
    if (tilt.perspective !== undefined && !inRange(tilt.perspective, 200, 2000)) {
      bad('tilt.perspective')
    }
    if (tilt.scale !== undefined && !inRange(tilt.scale, 0.8, 1.2)) {
      bad('tilt.scale')
    }
  }
  return issues
}

/** 背景只应用 window / zoom；出现静态特效或 tilt 时按非法上报（与导入时的忽略行为区分） */
const backgroundEffectsAllowed = (effects: StyleEffects | undefined): StyleEffects | undefined => {
  if (!effects) {
    return undefined
  }
  const result: StyleEffects = {}
  if (effects.window) {
    result.window = effects.window
  }
  if (effects.zoom !== undefined) {
    result.zoom = effects.zoom
  }
  return Object.keys(result).length > 0 ? result : undefined
}

/**
 * 校验整份草稿并返回字段级问题列表（空数组 = 可保存 / 可导出）。
 * 覆盖：id 格式与内置 id、基本信息必填与长度、文本安全、图片 / 字体的类型与大小、
 * 调色板颜色、custom 对齐必须有合法 position、整包总量、至少提供一个资源。
 */
export const validateStyleDraft = (draft: StyleEditorDraft): StyleDraftIssue[] => {
  const issues: StyleDraftIssue[] = []
  const id = draft.id.trim()
  if (!id) {
    issues.push({ path: 'id', code: 'required' })
  } else if (!STYLE_ID_PATTERN.test(id)) {
    issues.push({ path: 'id', code: 'badId' })
  }
  if (id.toLowerCase() === BUILTIN_STYLE_PACK_ID) {
    issues.push({ path: 'id', code: 'reservedId', params: { value: BUILTIN_STYLE_PACK_ID } })
  }

  issues.push(...textIssues('name', draft.name, { required: true, max: MAX_NAME_LENGTH }))
  issues.push(...textIssues('author', draft.author, { required: true, max: MAX_META_TEXT_LENGTH }))
  issues.push(...textIssues('version', draft.version, { required: true, max: MAX_META_TEXT_LENGTH }))
  issues.push(
    ...textIssues('description', draft.description, {
      required: false,
      max: MAX_META_TEXT_LENGTH,
      multiline: true,
    })
  )
  issues.push(
    ...textIssues('copyright', draft.copyright, {
      required: true,
      max: MAX_COPYRIGHT_LENGTH,
      multiline: true,
    })
  )
  issues.push(
    ...textIssues('licenseText', draft.licenseText, {
      required: false,
      max: MAX_META_TEXT_LENGTH,
      multiline: true,
    })
  )
  issues.push(
    ...textIssues('sidebarTitle', draft.sidebarTitle, {
      required: false,
      max: MAX_SIDEBAR_TITLE_LENGTH,
    })
  )

  // License 全文按 UTF-8 字节数限制（zip.ts 的许可证文件上限 200 KB）
  const licenseBytes = new TextEncoder().encode(composeLicenseText(draft)).byteLength
  if (licenseBytes > MAX_LICENSE_TEXT_BYTES) {
    issues.push({
      path: 'licenseText',
      code: 'tooLarge',
      params: { max: MAX_LICENSE_TEXT_BYTES },
    })
  }

  let assetCount = 0
  let totalBytes = 0
  const checkFile = (path: string, file: StyleDraftFile, kind: StyleDraftFileKind): void => {
    assetCount += 1
    totalBytes += file.blob.size
    const issue = validateDraftFile(file, kind, path)
    if (issue) {
      issues.push(issue)
    }
  }

  for (const theme of EDITOR_THEMES) {
    for (const slot of BACKGROUND_SLOTS) {
      const file = draft.backgrounds[theme][slot]
      if (!file) {
        continue
      }
      const path = backgroundIssuePath(theme, slot)
      checkFile(path, file, 'background')
      issues.push(...effectIssues(file.effects, false, path))
      // align: custom 必须同时给出合法的 background-position（与 zip.ts 的导入规则一致）
      const align = file.align ?? STYLE_ALIGN_DEFAULT
      if (align === 'custom') {
        const position = file.position?.trim() ?? ''
        if (!position) {
          issues.push({ path: `${path}.position`, code: 'required' })
        } else if (!isSafePosition(position)) {
          issues.push({ path: `${path}.position`, code: 'badPosition' })
        }
      }
    }
    for (const slot of ICON_SLOTS) {
      const file = draft.icons[theme][slot]
      if (file) {
        const path = iconIssuePath(theme, slot)
        checkFile(path, file, 'icon')
        issues.push(...effectIssues(file.effects, true, path))
      }
    }
    const font = draft.fonts[theme]
    if (font) {
      checkFile(`fonts.${theme}`, font, 'font')
    }
    const packIcon = draft.packIcons[theme]
    if (packIcon) {
      checkFile(`packIcons.${theme}`, packIcon, 'packIcon')
      issues.push(...effectIssues(packIcon.effects, false, `packIcons.${theme}`))
    }
    const cover = draft.covers[theme]
    if (cover) {
      checkFile(`covers.${theme}`, cover, 'cover')
      issues.push(...effectIssues(cover.effects, true, `covers.${theme}`))
    }
    for (const key of PALETTE_KEYS) {
      const value = draft.palette[theme][key]?.trim()
      if (value && !isStyleCssColor(value)) {
        issues.push({ path: `palette.${theme}.${key}`, code: 'badColor' })
      }
    }
  }

  if (assetCount === 0) {
    issues.push({ path: 'assets', code: 'noAssets' })
  }
  if (totalBytes > MAX_DRAFT_TOTAL_BYTES) {
    issues.push({
      path: 'total',
      code: 'totalTooLarge',
      params: { max: MAX_DRAFT_TOTAL_BYTES },
    })
  }
  return issues
}

/** 背景槽位的表单字段路径（UI 用它把错误贴到对应行） */
export const backgroundIssuePath = (theme: Theme, slot: StyleSlot): string =>
  `backgrounds.${theme}.${slot}`
/** 图标槽位的表单字段路径 */
export const iconIssuePath = (theme: Theme, slot: StyleSlot): string => `icons.${theme}.${slot}`

const STYLE_BACKGROUND_PREFIX = `${STYLE_PREFIX}.background.`
const STYLE_ICON_PREFIX = `${STYLE_PREFIX}.icon.`

/** 资源 ID → 包内文件名片段：去掉统一前缀（如 `background.setting.generic` → `setting.generic`） */
export const backgroundSlotName = (slot: StyleSlot): string =>
  slot.slice(STYLE_BACKGROUND_PREFIX.length)
export const iconSlotName = (slot: StyleSlot): string => slot.slice(STYLE_ICON_PREFIX.length)

/**
 * 草稿资源的 zip 内路径（全部走文档里的默认位置；显式写进 index.json 的 file）。
 * 背景 / 图标 / 包图标 / 封面用「主题目录」形式，字体用 `assets/fonts/<theme>.<ext>`。
 */
export const styleDraftAssetPath = {
  background: (slot: StyleSlot, theme: Theme, ext: string): string =>
    `assets/${theme}/${backgroundSlotName(slot)}.${ext}`,
  icon: (slot: StyleSlot, theme: Theme, ext: string): string =>
    `assets/icons/${theme}/${iconSlotName(slot)}.${ext}`,
  font: (theme: Theme, ext: string): string => `assets/fonts/${theme}.${ext}`,
  packIcon: (theme: Theme, ext: string): string => `assets/${theme}/icon.${ext}`,
  cover: (theme: Theme, ext: string): string => `assets/${theme}/cover.${ext}`,
}

/** ZIP 内的一个文件（LICENSE 也在其中） */
export type StyleDraftZipFile = { path: string; blob: Blob }

/** 编译结果：保存（manifest + Blob）与导出（manifest + files）共用同一份组装结果 */
export type CompiledStyleDraft = {
  manifest: StyleManifest
  /** assetId → Blob（写入 IndexedDB 的 assets） */
  assets: Record<string, Blob>
  icon?: ThemedBlobs
  cover?: ThemedBlobs
  /** LICENSE 全文（版权声明 + License 文本） */
  license: string
  /** 要写进 zip 的全部文件（不含 index.json） */
  files: StyleDraftZipFile[]
}

/** 包图标 / 封面的一个主题项：包内路径 + 可选 effects */
type CompiledImageRef = { file: string; effects?: StyleEffects }

/** 去掉 effects 里的 tilt（包图标不允许 tilt，导入时会报 badConfig） */
const stripTilt = (effects: StyleEffects | undefined): StyleEffects | undefined => {
  if (!effects?.tilt) {
    return effects
  }
  const copy = { ...effects }
  delete copy.tilt
  return Object.keys(copy).length > 0 ? copy : undefined
}

/**
 * 把草稿编译成清单 + Blob 集合。
 * 只消费草稿里实际存在的资源；文本字段做 trim，空的可选字段不写进清单。
 * 不负责校验（调用方先跑 validateStyleDraft），因此也能用于「预览」这种半成品草稿。
 */
export const compileStyleDraft = (draft: StyleEditorDraft): CompiledStyleDraft => {
  const files: StyleDraftZipFile[] = []
  const assets: Record<string, Blob> = {}
  const assetEntries: Record<string, StyleAssetEntry> = {}
  const iconRefs: Partial<Record<Theme, CompiledImageRef>> = {}
  const coverRefs: Partial<Record<Theme, CompiledImageRef>> = {}
  const iconBlobs: ThemedBlobs = {}
  const coverBlobs: ThemedBlobs = {}

  const addAsset = (assetId: string, blob: Blob, path: string, entry: StyleAssetEntry): void => {
    assets[assetId] = blob
    assetEntries[assetId] = entry
    files.push({ path, blob })
  }

  for (const theme of EDITOR_THEMES) {
    for (const slot of BACKGROUND_SLOTS) {
      const file = draft.backgrounds[theme][slot]
      if (!file) {
        continue
      }
      const path = styleDraftAssetPath.background(slot, theme, file.ext)
      const entry: StyleAssetEntry = { file: path }
      // 与缺省值相同的排版字段不写，保持导出清单精简
      if (file.fit && file.fit !== STYLE_FIT_DEFAULT) {
        entry.fit = file.fit
      }
      if (file.align && file.align !== STYLE_ALIGN_DEFAULT) {
        entry.align = file.align
      }
      if (file.render && file.render !== STYLE_RENDER_DEFAULT) {
        entry.render = file.render
      }
      const position = file.position?.trim()
      if (entry.align === 'custom' && position && isSafePosition(position)) {
        entry.position = position
      }
      const effects = backgroundEffectsAllowed(file.effects)
      if (effects) {
        entry.effects = effects
      }
      addAsset(slotId(slot, theme), file.blob, path, entry)
    }

    for (const slot of ICON_SLOTS) {
      const file = draft.icons[theme][slot]
      if (!file) {
        continue
      }
      const path = styleDraftAssetPath.icon(slot, theme, file.ext)
      const entry: StyleAssetEntry = { file: path }
      if (file.render && file.render !== STYLE_RENDER_DEFAULT) {
        entry.render = file.render
      }
      if (file.effects && Object.keys(file.effects).length > 0) {
        entry.effects = file.effects
      }
      addAsset(slotId(slot, theme), file.blob, path, entry)
    }

    const font = draft.fonts[theme]
    if (font) {
      const path = styleDraftAssetPath.font(theme, font.ext)
      addAsset(slotId(STYLE_SLOTS.font, theme), font.blob, path, { file: path })
    }

    const packIcon = draft.packIcons[theme]
    if (packIcon) {
      const path = styleDraftAssetPath.packIcon(theme, packIcon.ext)
      const effects = stripTilt(packIcon.effects)
      iconRefs[theme] = effects ? { file: path, effects } : { file: path }
      iconBlobs[theme] = packIcon.blob
      files.push({ path, blob: packIcon.blob })
    }

    const cover = draft.covers[theme]
    if (cover) {
      const path = styleDraftAssetPath.cover(theme, cover.ext)
      const effects = cover.effects && Object.keys(cover.effects).length > 0 ? cover.effects : undefined
      coverRefs[theme] = effects ? { file: path, effects } : { file: path }
      coverBlobs[theme] = cover.blob
      files.push({ path, blob: cover.blob })
    }
  }

  const manifest: StyleManifest = {
    schema: 1,
    id: draft.id.trim(),
    name: draft.name.trim(),
    description: draft.description.trim() || undefined,
    author: draft.author.trim() || undefined,
    version: draft.version.trim() || undefined,
    sidebarTitle: draft.sidebarTitle.trim() || undefined,
    icon: manifestImageRef(iconRefs),
    cover: manifestImageRef(coverRefs),
    license: { file: STYLE_DRAFT_LICENSE_FILE },
    color_palette: compilePalette(draft),
    assets: assetEntries,
  }

  const license = composeLicenseText(draft)
  files.push({
    path: STYLE_DRAFT_LICENSE_FILE,
    blob: new Blob([license], { type: 'text/plain;charset=utf-8' }),
  })

  return {
    manifest,
    assets,
    icon: iconBlobs.light || iconBlobs.dark ? iconBlobs : undefined,
    cover: coverBlobs.light || coverBlobs.dark ? coverBlobs : undefined,
    license,
    files,
  }
}

/** 包图标 / 封面引用：两个主题都有 → 按主题写；只有一个 → 主题无关写法（两个主题共用） */
const manifestImageRef = (
  refs: Partial<Record<Theme, CompiledImageRef>>
): StyleFileRef | undefined => {
  if (refs.light && refs.dark) {
    return {
      light: { file: refs.light.file, effects: refs.light.effects },
      dark: { file: refs.dark.file, effects: refs.dark.effects },
    }
  }
  const only = refs.light ?? refs.dark
  if (!only) {
    return undefined
  }
  return only.effects ? { file: only.file, effects: only.effects } : { file: only.file }
}

/** 调色板：只保留非空颜色的主题，空主题不写进清单 */
const compilePalette = (draft: StyleEditorDraft): StylePalette | undefined => {
  const palette: StylePalette = {}
  for (const theme of EDITOR_THEMES) {
    const colors: PaletteColors = {}
    for (const key of PALETTE_KEYS) {
      const value = draft.palette[theme][key]?.trim()
      if (value) {
        colors[key] = value
      }
    }
    if (Object.keys(colors).length > 0) {
      palette[theme] = colors
    }
  }
  return Object.keys(palette).length > 0 ? palette : undefined
}

/** LICENSE 文件内容：版权声明在前，License 全文（可选）在后，用空行分隔 */
export const composeLicenseText = (draft: StyleEditorDraft): string => {
  const copyright = draft.copyright.trim()
  const licenseText = draft.licenseText.trim()
  return licenseText ? `${copyright}\n\n${licenseText}` : copyright
}

/**
 * 把 LICENSE 全文拆回「版权声明 / License 文本」：编辑导入的包（没有 editor 元信息）时用。
 * 以第一个空行为界；没有空行时整段都当版权声明。
 */
export const splitLicenseText = (
  license: string | undefined
): { copyright: string; licenseText: string } => {
  const trimmed = (license ?? '').trim()
  if (!trimmed) {
    return { copyright: '', licenseText: '' }
  }
  const index = trimmed.indexOf('\n\n')
  if (index < 0) {
    return { copyright: trimmed, licenseText: '' }
  }
  return {
    copyright: trimmed.slice(0, index).trim(),
    licenseText: trimmed.slice(index + 2).trim(),
  }
}

/**
 * 草稿 → StoredStylePack（写 IndexedDB）：builtin 恒为 false；
 * 编辑已有包时传入它的 importedAt（保留列表排序），新建时用当前时间。
 */
export const draftToStoredStylePack = (
  draft: StyleEditorDraft,
  options: { importedAt?: number; existing?: StoredStylePack } = {}
): StoredStylePack => {
  const compiled = compileStyleDraft(draft)
  return {
    id: compiled.manifest.id,
    manifest: compiled.manifest,
    assets: compiled.assets,
    icon: compiled.icon,
    cover: compiled.cover,
    license: compiled.license,
    importedAt: options.importedAt ?? options.existing?.importedAt ?? Date.now(),
    builtin: false,
    editor: {
      copyright: draft.copyright.trim(),
      licenseText: draft.licenseText.trim() || undefined,
    },
  }
}

/** 从原包路径取出文件名（用于展示与扩展名） */
const pathFileName = (path: string | undefined): string => {
  if (!path) {
    return ''
  }
  const parts = path.split('/')
  return parts[parts.length - 1] ?? ''
}

/**
 * StoredStylePack → 草稿（再次编辑）：还原文本、资源 Blob、排版参数与配色。
 * 只还原编辑器支持的槽位（10 个背景 + 40 个图标 + 字体 + 包图标 / 封面 + 13 个配色令牌），
 * 包内其它资源（如 background.setting.style）不在编辑器范围内。
 */
export const storedPackToDraft = (
  pack: StoredStylePack,
  options: { theme?: Theme } = {}
): StyleEditorDraft => {
  const draft = createStyleEditorDraft({
    id: pack.id,
    theme: options.theme,
  })
  const manifest = pack.manifest
  const license = pack.editor
    ? {
        copyright: pack.editor.copyright ?? '',
        licenseText: pack.editor.licenseText ?? '',
      }
    : splitLicenseText(pack.license)

  for (const theme of EDITOR_THEMES) {
    for (const slot of BACKGROUND_SLOTS) {
      const assetId = slotId(slot, theme)
      const blob = pack.assets[assetId]
      const entry = manifest.assets[assetId]
      if (!blob || !entry) {
        continue
      }
      const file = createDraftFile(blob, pathFileName(entry.file) || `asset.${fileExtension(entry.file)}`)
      draft.backgrounds[theme][slot] = {
        ...file,
        fit: entry.fit,
        align: entry.align,
        position: entry.position,
        render: entry.render,
        effects: entry.effects,
      }
    }
    for (const slot of ICON_SLOTS) {
      const assetId = slotId(slot, theme)
      const blob = pack.assets[assetId]
      const entry = manifest.assets[assetId]
      if (!blob || !entry) {
        continue
      }
      draft.icons[theme][slot] = {
        ...createDraftFile(
          blob,
          pathFileName(entry.file) || `asset.${fileExtension(entry.file)}`
        ),
        render: entry.render,
        effects: entry.effects,
      }
    }
    const fontId = slotId(STYLE_SLOTS.font, theme)
    const fontBlob = pack.assets[fontId]
    const fontEntry = manifest.assets[fontId]
    if (fontBlob && fontEntry) {
      draft.fonts[theme] = createDraftFile(
        fontBlob,
        pathFileName(fontEntry.file) || `font.${fileExtension(fontEntry.file)}`
      )
    }
    const iconRef = resolveThemeFileRef(manifest.icon, theme)
    const iconBlob = pack.icon?.[theme]
    if (iconBlob) {
      draft.packIcons[theme] = {
        ...createDraftFile(
          iconBlob,
          pathFileName(iconRef?.file) || `icon.${fileExtension(iconRef?.file ?? '')}`
        ),
        effects: iconRef?.effects,
      }
    }
    const coverRef = resolveThemeFileRef(manifest.cover, theme)
    const coverBlob = pack.cover?.[theme]
    if (coverBlob) {
      draft.covers[theme] = {
        ...createDraftFile(
          coverBlob,
          pathFileName(coverRef?.file) || `cover.${fileExtension(coverRef?.file ?? '')}`
        ),
        effects: coverRef?.effects,
      }
    }
    const colors = manifest.color_palette?.[theme]
    if (colors) {
      for (const key of PALETTE_KEYS) {
        const value = colors[key]
        if (value) {
          draft.palette[theme][key] = value
        }
      }
    }
  }

  return {
    ...draft,
    name: manifest.name,
    author: manifest.author ?? '',
    version: manifest.version ?? EDITOR_DEFAULT_VERSION,
    description: manifest.description ?? '',
    sidebarTitle: manifest.sidebarTitle ?? '',
    copyright: license.copyright,
    licenseText: license.licenseText,
  }
}

/** 某个主题实际使用的 icon / cover 引用（主题无关写法两个主题共用同一个文件与 effects） */
const resolveThemeFileRef = (
  ref: StyleFileRef | undefined,
  theme: Theme
): { file: string; effects?: StyleEffects } | undefined => resolveStyleFileRef(ref, theme)

const fileSignature = (file: StyleDraftFile | undefined): unknown[] | null =>
  file
    ? [
        file.fileName,
        file.ext,
        file.blob.size,
        'lastModified' in file.blob ? (file.blob as File).lastModified : 0,
        file.effects ? JSON.stringify(file.effects) : '',
        file.render ?? '',
      ]
    : null

const backgroundSignature = (file: StyleDraftBackground | undefined): unknown[] | null =>
  file
    ? [
        ...(fileSignature(file) as unknown[]),
        file.fit ?? '',
        file.align ?? '',
        file.position ?? '',
        file.render ?? '',
      ]
    : null

/**
 * 草稿指纹：用于判断「有没有未保存的修改」（换主题不算修改）。
 * 只比较展示信息与文件元数据，不读文件内容；上传同名同大小但内容不同的文件属于极端情况。
 */
export const styleDraftSignature = (draft: StyleEditorDraft): string =>
  JSON.stringify({
    id: draft.id,
    name: draft.name,
    author: draft.author,
    version: draft.version,
    description: draft.description,
    copyright: draft.copyright,
    licenseText: draft.licenseText,
    sidebarTitle: draft.sidebarTitle,
    palette: EDITOR_THEMES.map((theme) =>
      PALETTE_KEYS.map((key) => draft.palette[theme][key] ?? '')
    ),
    backgrounds: EDITOR_THEMES.map((theme) =>
      BACKGROUND_SLOTS.map((slot) => backgroundSignature(draft.backgrounds[theme][slot]))
    ),
    icons: EDITOR_THEMES.map((theme) =>
      ICON_SLOTS.map((slot) => fileSignature(draft.icons[theme][slot]))
    ),
    fonts: EDITOR_THEMES.map((theme) => fileSignature(draft.fonts[theme])),
    packIcons: EDITOR_THEMES.map((theme) => fileSignature(draft.packIcons[theme])),
    covers: EDITOR_THEMES.map((theme) => fileSignature(draft.covers[theme])),
  })
