/** 样式包状态：IndexedDB 存资源，objectURL 只在启用期间存活，localStorage 记启用项。 */
/** 内置极光样式包资产：由 scripts/build-web.ps1 复制到 src/assets/builtin/，rspack 打包成可 fetch 的 URL */
import builtinPackUrl from '../../assets/builtin/aurora.zip'
import { useSyncExternalStore } from 'react'
import { create } from 'zustand'
import { useSettings, type ThemePreference } from '../settings.js'
import { applyStyleVars, type ActiveStyle } from './apply.js'
import { createEffectsImageUrl, needsCanvasProcessing, pruneEffectsCache } from './effects.js'
import {
  deleteStoredStylePack,
  getStoredStylePack,
  listStoredStylePacks,
  putStoredStylePack,
  summarize,
} from './db.js'
import { parseStylePackZip, StylePackError, type ParsedStylePack } from './zip.js'
import {
  slotId,
  STYLE_PREFIX,
  type StyleAssetEntry,
  type StylePackSummary,
  type ThemedBlobs,
  type ThemedUrls,
  type Theme,
} from './types.js'

export type StylePackState = {
  ready: boolean
  packs: StylePackSummary[]
  activeId: string | null
  active: ActiveStyle | null
  importing: boolean
  error: string | null
}

const ACTIVE_KEY = 'chat-demo:style-pack'

const readActiveId = (): string | null => {
  try {
    return localStorage.getItem(ACTIVE_KEY) || null
  } catch {
    return null
  }
}

const writeActiveId = (id: string | null) => {
  try {
    if (id === null) {
      localStorage.removeItem(ACTIVE_KEY)
    } else {
      localStorage.setItem(ACTIVE_KEY, id)
    }
  } catch {
    // 存储不可用时只在内存中生效
  }
}

export const useStylePackStore = create<StylePackState>(() => ({
  ready: false,
  packs: [],
  activeId: null,
  active: null,
  importing: false,
  error: null,
}))

const { getState: get, setState: set } = useStylePackStore

const themeQuery =
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null

const subscribeOsTheme = (listener: () => void) => {
  themeQuery?.addEventListener('change', listener)
  return () => themeQuery?.removeEventListener('change', listener)
}

const getOsTheme = (): Theme => (themeQuery?.matches ? 'dark' : 'light')

const resolveTheme = (
  preference: ThemePreference = useSettings.getState().themePreference,
  osTheme: Theme = getOsTheme()
): Theme => (preference === 'system' ? osTheme : preference)

/** 启用包的全部 objectURL：切换/清除时统一释放 */
let activeUrls: string[] = []

/**
 * 列表摘要里的 objectURL（包图标与详情页封面），按主题分开；
 * 刷新列表时整组重建并释放旧地址。
 */
let summaryUrls: { icons: Map<string, ThemedUrls>; covers: Map<string, ThemedUrls> } = {
  icons: new Map(),
  covers: new Map(),
}

/**
 * 把按主题的 Blob 各自建一个 objectURL（每个主题一个，未提供的主题跳过），
 * 并把 URL 记进 `created` 以便调用方统一 revoke。
 */
const createThemeUrls = (
  blobs: ThemedBlobs | undefined,
  created: string[]
): ThemedUrls | undefined => {
  if (!blobs) {
    return undefined
  }
  const urls: ThemedUrls = {}
  for (const theme of ['light', 'dark'] as const) {
    const blob = blobs[theme]
    if (!blob) {
      continue
    }
    const url = URL.createObjectURL(blob)
    urls[theme] = url
    created.push(url)
  }
  return urls.light || urls.dark ? urls : undefined
}

const themeUrlValues = (urls: ThemedUrls | undefined): string[] =>
  urls ? Object.values(urls).filter((url): url is string => Boolean(url)) : []

/** 当前列表摘要里仍在使用的 objectURL（派生图缓存按它判断哪些还能留） */
const summarySourceUrls = (): Set<string> => {
  const keep = new Set<string>()
  for (const urls of summaryUrls.icons.values()) {
    for (const url of themeUrlValues(urls)) {
      keep.add(url)
    }
  }
  for (const urls of summaryUrls.covers.values()) {
    for (const url of themeUrlValues(urls)) {
      keep.add(url)
    }
  }
  return keep
}

/** 保留「当前启用包 + 列表摘要」仍引用的原图 URL，其余派生图全部 revoke */
const pruneEffects = (activeUrlsToKeep: Iterable<string>): void => {
  const keep = summarySourceUrls()
  for (const url of activeUrlsToKeep) {
    keep.add(url)
  }
  pruneEffectsCache(keep)
}

const refreshPacks = async (): Promise<void> => {
  const stored = await listStoredStylePacks()
  // 先建好新 URL 再释放旧的，避免列表在渲染间隙引用已释放的地址
  const nextIcons = new Map<string, ThemedUrls>()
  const nextCovers = new Map<string, ThemedUrls>()
  const packs = stored.map((pack) => {
    const created: string[] = []
    const iconUrls = createThemeUrls(pack.icon, created)
    const coverUrls = createThemeUrls(pack.cover, created)
    if (iconUrls) {
      nextIcons.set(pack.id, iconUrls)
    }
    if (coverUrls) {
      nextCovers.set(pack.id, coverUrls)
    }
    return summarize(pack, { iconUrls, coverUrls })
  })
  const previous = summaryUrls
  summaryUrls = { icons: nextIcons, covers: nextCovers }
  packs.sort((a, b) => b.importedAt - a.importedAt)
  set({ packs })
  const active = get().active
  const activeKeep: string[] = []
  if (active) {
    activeKeep.push(...Object.values(active.urls))
    activeKeep.push(...themeUrlValues(active.iconUrls))
    activeKeep.push(...themeUrlValues(active.coverUrls))
  }
  pruneEffects(activeKeep)
  for (const urls of previous.icons.values()) {
    for (const url of themeUrlValues(urls)) {
      URL.revokeObjectURL(url)
    }
  }
  for (const urls of previous.covers.values()) {
    for (const url of themeUrlValues(urls)) {
      URL.revokeObjectURL(url)
    }
  }
}

/** 安装包内置的极光示例包文件名（只影响 File 名字，解析只认 zip 里的 index.json） */
const BUILTIN_PACK_FILE = 'aurora.zip'

/** 内置包资产缺失 / 解析失败只 warn 一次：不能让资源问题在每次启动重复刷屏 */
let builtinWarningShown = false
const warnBuiltinOnce = (message: string): void => {
  if (builtinWarningShown) {
    return
  }
  builtinWarningShown = true
  // oxlint-disable-next-line no-console
  console.warn(`[style-pack] ${message}`)
}

/** 版本号拆段：纯数字段转 number，其余保持字符串；用于内置包「版本较旧」判断 */
const versionParts = (value: string | undefined): Array<number | string> =>
  (value ?? '')
    .split('.')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => (/^\d+$/.test(part) ? Number(part) : part))

/**
 * 比较两个版本号：left > right 返回正数、相等 0、更小为负数。
 * 数字段按数值比较（1.10.0 > 1.9.0），非数字段按字符串比较，缺失段视为 0。
 */
const compareVersions = (left: string | undefined, right: string | undefined): number => {
  const a = versionParts(left)
  const b = versionParts(right)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const leftPart = a[index] ?? 0
    const rightPart = b[index] ?? 0
    if (leftPart === rightPart) {
      continue
    }
    if (typeof leftPart === 'number' && typeof rightPart === 'number') {
      return leftPart - rightPart
    }
    return String(leftPart).localeCompare(String(rightPart))
  }
  return 0
}

/**
 * 确保内置极光样式包已安装（幂等，启动时先于恢复 active 执行）：
 * - 本机没有该 id（aurora）→ 写入并标记 `builtin: true` + `builtinVersion`；
 * - 已有 builtin 记录且安装包内资产版本更新 → 覆盖内容并刷新 `builtinVersion`；
 * - 已有用户自己导入的同 id 包（builtin=false）→ 保留用户包，不覆盖；
 * - 内置资产 fetch / 解析失败 → 只 warn 一次并返回 null，不阻塞启动。
 *
 * 返回本机内置包的 id（没有可用内置包时为 null）。
 */
const ensureBuiltinPack = async (): Promise<string | null> => {
  let parsed: ParsedStylePack
  try {
    const response = await fetch(builtinPackUrl)
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }
    const blob = await response.blob()
    parsed = await parseStylePackZip(
      new File([blob], BUILTIN_PACK_FILE, { type: 'application/zip' })
    )
  } catch (error) {
    warnBuiltinOnce(
      `内置样式包不可用（${error instanceof Error ? error.message : String(error)}），已回退应用默认外观`
    )
    return null
  }

  const { manifest } = parsed
  const existing = await getStoredStylePack(manifest.id)
  // 用户自己导入的同 id 包优先：不把内置内容盖到用户包上
  if (existing && existing.builtin !== true) {
    return null
  }
  // 已安装更高或同版本的内置记录时不重复写库（避免每次启动都刷新 IndexedDB）
  if (existing && compareVersions(manifest.version, existing.builtinVersion) <= 0) {
    return manifest.id
  }

  const assets: Record<string, Blob> = {}
  for (const [assetId, asset] of Object.entries(parsed.assets)) {
    assets[assetId] = asset.blob
  }
  await putStoredStylePack({
    id: manifest.id,
    manifest,
    assets,
    icon: parsed.icon.light || parsed.icon.dark ? parsed.icon : undefined,
    cover: parsed.cover.light || parsed.cover.dark ? parsed.cover : undefined,
    license: parsed.license,
    // 升级时保留首次安装时间，列表排序不因升级跳动
    importedAt: existing?.importedAt ?? Date.now(),
    builtin: true,
    builtinVersion: manifest.version,
  })
  return manifest.id
}

/** 递增序号：并发的启用请求只有最后一次生效 */
let activationSequence = 0

/**
 * 启用指定样式包；传入的 id 取不到记录时清除全部样式变量、回到上游默认外观。
 *
 * `activateStylePack(null)` 是**内部兜底**：只在内置包不可用（资产缺失 / 解析失败 /
 * 被用户同 id 包覆盖）或初始化异常时走到。正常构建与安装下，启动、删除非内置包、
 * 「恢复默认」都指向内置极光包，UI 不提供「停用样式包 / 回到上游外观」的入口。
 */
export const activateStylePack = async (id: string | null): Promise<void> => {
  const sequence = ++activationSequence
  const pack = id ? await getStoredStylePack(id) : undefined
  if (sequence !== activationSequence) {
    return
  }

  // 释放旧 URL 放到新 URL 应用之后：否则主题切换/二次激活时，
  // 变量可能短暂指向已经 revoke 的地址，图片会静默变成空白。
  if (!pack) {
    const previous = activeUrls
    activeUrls = []
    set({ activeId: null, active: null })
    writeActiveId(null)
    pruneEffects([])
    await applyStyleVars(null, resolveTheme())
    for (const url of previous) {
      URL.revokeObjectURL(url)
    }
    return
  }

  const urls: Record<string, string> = {}
  const created: string[] = []
  for (const [assetId, blob] of Object.entries(pack.assets)) {
    const url = URL.createObjectURL(blob)
    urls[assetId] = url
    created.push(url)
  }
  // 背景的 window / zoom 需要 canvas 派生图；静态特效与 tilt 在导入时已从背景清单里移除
  for (const [assetId, url] of Object.entries(urls)) {
    const asset = pack.manifest.assets[assetId]
    const effects = asset?.effects
    if (
      !assetId.startsWith(`${STYLE_PREFIX}.background.`) ||
      !effects ||
      !needsCanvasProcessing(effects)
    ) {
      continue
    }
    const derivedUrl = await createEffectsImageUrl(url, effects)
    if (sequence !== activationSequence) {
      for (const createdUrl of created) {
        URL.revokeObjectURL(createdUrl)
      }
      if (derivedUrl) {
        URL.revokeObjectURL(derivedUrl)
      }
      return
    }
    if (derivedUrl) {
      urls[assetId] = derivedUrl
      created.push(derivedUrl)
    }
  }
  const iconUrls = createThemeUrls(pack.icon, created)
  const coverUrls = createThemeUrls(pack.cover, created)

  const previous = activeUrls
  activeUrls = created
  const active: ActiveStyle = {
    id: pack.id,
    manifest: pack.manifest,
    urls,
    iconUrls,
    coverUrls,
    license: pack.license,
  }
  set({ activeId: pack.id, active })
  writeActiveId(pack.id)
  pruneEffects(created)
  await applyStyleVars(active, resolveTheme())
  for (const url of previous) {
    URL.revokeObjectURL(url)
  }
}

export const importStylePack = async (file: File): Promise<void> => {
  set({ importing: true, error: null })
  try {
    const parsed = await parseStylePackZip(file)
    const assets: Record<string, Blob> = {}
    for (const [assetId, asset] of Object.entries(parsed.assets)) {
      assets[assetId] = asset.blob
    }
    await putStoredStylePack({
      id: parsed.manifest.id,
      manifest: parsed.manifest,
      assets,
      icon: parsed.icon.light || parsed.icon.dark ? parsed.icon : undefined,
      cover: parsed.cover.light || parsed.cover.dark ? parsed.cover : undefined,
      license: parsed.license,
      importedAt: Date.now(),
    })
    await refreshPacks()
    if (!get().activeId || get().activeId === parsed.manifest.id) {
      await activateStylePack(parsed.manifest.id)
    }
    set({ importing: false })
  } catch (error) {
    set({
      importing: false,
      error: error instanceof StylePackError ? error.code : 'importFailed',
    })
    throw error
  }
}

/** 当前列表里的内置样式包 id（没有内置包、只剩应用默认外观时为 null） */
export const getBuiltinStylePackId = (): string | null =>
  get().packs.find((pack) => pack.builtin === true)?.id ?? null

/**
 * 「恢复默认（极光）」：启用随安装包分发的内置包。
 * 只有内置包不可用（资产缺失 / 解析失败 / 被用户同 id 包覆盖）时才返回 null，
 * 此时 `activateStylePack(null)` 会回到上游默认外观——这是唯一合法的降级路径。
 * 正常构建 / 安装下内置包总是可用，UI 不会提供回到上游外观的入口。
 */
export const restoreDefaultStylePack = async (): Promise<void> => {
  await activateStylePack(getBuiltinStylePackId())
}

export const removeStylePack = async (id: string): Promise<void> => {
  const stored = await getStoredStylePack(id)
  // 内置样式包与内置默认预设一样不可删除：拒绝并静默返回
  if (stored?.builtin) {
    return
  }
  const wasActive = get().activeId === id
  await deleteStoredStylePack(id)
  if (wasActive) {
    // 删掉当前启用的非内置包后自动回到内置默认样式；内置包不可用时才退化为上游外观
    await activateStylePack(getBuiltinStylePackId())
  }
  await refreshPacks()
}

/** 主题变化：重新应用当前包，取另一套资源 */
let themeBound = false

const reapply = () => {
  void applyStyleVars(get().active, resolveTheme())
}

const bindTheme = () => {
  if (themeBound) {
    return
  }
  themeBound = true
  useSettings.subscribe((state, previous) => {
    if (state.themePreference !== previous.themePreference) {
      reapply()
    }
  })
  themeQuery?.addEventListener('change', reapply)
}

let initTask: Promise<void> | undefined

/** 读取已安装包并恢复上次启用的样式包；只执行一次 */
export const initStylePacks = (): Promise<void> =>
  (initTask ??= (async () => {
    bindTheme()
    try {
      // 先确保随安装包分发的内置极光包就位（全新安装写入 / 版本升级更新 / 用户同 id 包保留）
      const builtinId = await ensureBuiltinPack()
      await refreshPacks()
      const saved = readActiveId()
      if (saved && get().packs.some((pack) => pack.id === saved)) {
        await activateStylePack(saved)
      } else if (builtinId) {
        // 没有启用记录（首次安装 / 记录已失效）时启用内置包
        await activateStylePack(builtinId)
      } else {
        // 内置包也不可用时回退原有行为：应用默认外观
        await activateStylePack(null)
      }
    } catch {
      // 读取失败时保持空列表，不阻塞界面
    } finally {
      set({ ready: true })
    }
  })())

export const useStylePackState = (): StylePackState => useStylePackStore()

/** 当前主题下某个槽位的 objectURL 与清单元数据（图标插值方式等） */
export type StyleAssetState = { assetId: string; url: string; meta?: StyleAssetEntry }

export const useStyleAsset = (slot: string): StyleAssetState | undefined => {
  const preference = useSettings((state) => state.themePreference)
  const osTheme = useSyncExternalStore(subscribeOsTheme, getOsTheme)
  const active = useStylePackStore((state) => state.active)
  const assetId = slotId(slot, resolveTheme(preference, osTheme))
  const url = active?.urls[assetId]
  return url ? { assetId, url, meta: active?.manifest.assets[assetId] } : undefined
}

/** 当前主题下某个槽位的 objectURL（完整 ID 由 slotId 拼出） */
export const useStyleAssetUrl = (slot: string): string | undefined => useStyleAsset(slot)?.url

export const useStyleSidebarTitle = (): string | undefined => {
  const active = useStylePackStore((state) => state.active)
  return active?.manifest.sidebarTitle
}
