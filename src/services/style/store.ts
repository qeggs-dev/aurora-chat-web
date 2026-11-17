/** 样式包状态：IndexedDB 存资源，objectURL 只在启用期间存活，localStorage 记启用项。 */
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
import { parseStylePackZip, StylePackError } from './zip.js'
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

/** 递增序号：并发的启用请求只有最后一次生效 */
let activationSequence = 0

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

export const removeStylePack = async (id: string): Promise<void> => {
  const wasActive = get().activeId === id
  await deleteStoredStylePack(id)
  if (wasActive) {
    await activateStylePack(null)
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
      await refreshPacks()
      const saved = readActiveId()
      if (saved && get().packs.some((pack) => pack.id === saved)) {
        await activateStylePack(saved)
      } else {
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
