/** 样式包状态：IndexedDB 存资源，objectURL 只在启用期间存活，localStorage 记启用项。 */
import { useSyncExternalStore } from 'react'
import { create } from 'zustand'
import { useSettings, type ThemePreference } from '../settings.js'
import { applyStyleVars, type ActiveStyle } from './apply.js'
import {
  deleteStoredStylePack,
  getStoredStylePack,
  listStoredStylePacks,
  putStoredStylePack,
  summarize,
} from './db.js'
import { parseStylePackZip, StylePackError } from './zip.js'
import { slotId, type StyleAssetEntry, type StylePackSummary, type Theme } from './types.js'

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

/** 列表摘要里的 objectURL（包图标与详情页封面）：刷新列表时整组重建并释放旧地址 */
let summaryUrls: { icons: Map<string, string>; covers: Map<string, string> } = {
  icons: new Map(),
  covers: new Map(),
}

const refreshPacks = async (): Promise<void> => {
  const stored = await listStoredStylePacks()
  // 先建好新 URL 再释放旧的，避免列表在渲染间隙引用已释放的地址
  const nextIcons = new Map<string, string>()
  const nextCovers = new Map<string, string>()
  const packs = stored.map((pack) => {
    let iconUrl: string | undefined
    let coverUrl: string | undefined
    if (pack.icon) {
      iconUrl = URL.createObjectURL(pack.icon)
      nextIcons.set(pack.id, iconUrl)
    }
    if (pack.cover) {
      coverUrl = URL.createObjectURL(pack.cover)
      nextCovers.set(pack.id, coverUrl)
    }
    return summarize(pack, { iconUrl, coverUrl })
  })
  const previous = summaryUrls
  summaryUrls = { icons: nextIcons, covers: nextCovers }
  packs.sort((a, b) => b.importedAt - a.importedAt)
  set({ packs })
  for (const url of previous.icons.values()) {
    URL.revokeObjectURL(url)
  }
  for (const url of previous.covers.values()) {
    URL.revokeObjectURL(url)
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
  let iconUrl: string | undefined
  if (pack.icon) {
    iconUrl = URL.createObjectURL(pack.icon)
    created.push(iconUrl)
  }
  let coverUrl: string | undefined
  if (pack.cover) {
    coverUrl = URL.createObjectURL(pack.cover)
    created.push(coverUrl)
  }

  const previous = activeUrls
  activeUrls = created
  const active: ActiveStyle = {
    id: pack.id,
    manifest: pack.manifest,
    urls,
    iconUrl,
    coverUrl,
    license: pack.license,
  }
  set({ activeId: pack.id, active })
  writeActiveId(pack.id)
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
      icon: parsed.icon,
      cover: parsed.cover,
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
export type StyleAssetState = { url: string; meta?: StyleAssetEntry }

export const useStyleAsset = (slot: string): StyleAssetState | undefined => {
  const preference = useSettings((state) => state.themePreference)
  const osTheme = useSyncExternalStore(subscribeOsTheme, getOsTheme)
  const active = useStylePackStore((state) => state.active)
  const assetId = slotId(slot, resolveTheme(preference, osTheme))
  const url = active?.urls[assetId]
  return url ? { url, meta: active?.manifest.assets[assetId] } : undefined
}

/** 当前主题下某个槽位的 objectURL（完整 ID 由 slotId 拼出） */
export const useStyleAssetUrl = (slot: string): string | undefined => useStyleAsset(slot)?.url

export const useStyleSidebarTitle = (): string | undefined => {
  const active = useStylePackStore((state) => state.active)
  return active?.manifest.sidebarTitle
}
