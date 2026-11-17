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
import { slotId, type StylePackSummary, type Theme } from './types.js'

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

const releaseActiveUrls = () => {
  for (const url of activeUrls) {
    URL.revokeObjectURL(url)
  }
  activeUrls = []
}

/** 列表图标单独一组 URL，刷新列表时重建 */
const summaryIconUrls = new Map<string, string>()

const releaseSummaryIcons = () => {
  for (const url of summaryIconUrls.values()) {
    URL.revokeObjectURL(url)
  }
  summaryIconUrls.clear()
}

const refreshPacks = async (): Promise<void> => {
  const stored = await listStoredStylePacks()
  releaseSummaryIcons()
  const packs = stored.map((pack) => {
    let iconUrl: string | undefined
    if (pack.icon) {
      iconUrl = URL.createObjectURL(pack.icon)
      summaryIconUrls.set(pack.id, iconUrl)
    }
    return summarize(pack, iconUrl)
  })
  packs.sort((a, b) => b.importedAt - a.importedAt)
  set({ packs })
}

/** 递增序号：并发的启用请求只有最后一次生效 */
let activationSequence = 0

export const activateStylePack = async (id: string | null): Promise<void> => {
  const sequence = ++activationSequence
  const pack = id ? await getStoredStylePack(id) : undefined
  if (sequence !== activationSequence) {
    return
  }
  releaseActiveUrls()
  if (!pack) {
    set({ activeId: null, active: null })
    writeActiveId(null)
    await applyStyleVars(null, resolveTheme())
    return
  }

  const urls: Record<string, string> = {}
  for (const [assetId, blob] of Object.entries(pack.assets)) {
    const url = URL.createObjectURL(blob)
    urls[assetId] = url
    activeUrls.push(url)
  }
  let iconUrl: string | undefined
  if (pack.icon) {
    iconUrl = URL.createObjectURL(pack.icon)
    activeUrls.push(iconUrl)
  }

  const active: ActiveStyle = {
    id: pack.id,
    manifest: pack.manifest,
    urls,
    iconUrl,
    license: pack.license,
  }
  set({ activeId: pack.id, active })
  writeActiveId(pack.id)
  await applyStyleVars(active, resolveTheme())
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

/** 当前主题下某个槽位的 objectURL（完整 ID 由 slotId 拼出） */
export const useStyleAssetUrl = (slot: string): string | undefined => {
  const preference = useSettings((state) => state.themePreference)
  const osTheme = useSyncExternalStore(subscribeOsTheme, getOsTheme)
  const active = useStylePackStore((state) => state.active)
  return active?.urls[slotId(slot, resolveTheme(preference, osTheme))]
}

export const useStyleSidebarTitle = (): string | undefined => {
  const active = useStylePackStore((state) => state.active)
  return active?.manifest.sidebarTitle
}
