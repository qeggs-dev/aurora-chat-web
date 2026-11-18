/**
 * 自定义语言包运行时状态与操作：
 * - 启动时从 IndexedDB 加载（main.tsx 调 initLocalePacks），t() / useTranslate 同步查表；
 * - 导入 / 删除语言包；删除正在使用的语言包时回退到系统语言（中文浏览器 → 中文）；
 * - 导出当前语言文件（全部 key + 元信息），文件名 `<id>-locale.json`。
 */
import { create } from 'zustand'
import {
  buildLocalePackExport,
  LocalePackError,
  MAX_LOCALE_PACK_BYTES,
  parseLocalePackText,
} from './pack.js'
import {
  deleteStoredLocalePack,
  listStoredLocalePacks,
  putStoredLocalePack,
  type StoredLocalePack,
} from './db.js'
import { customLocaleId, type LocalePackSource } from '../../i18n/messages.js'
import { setLocale, systemLocale, useSettings } from '../settings.js'

type LocaleStoreState = {
  /** 启动加载完成（false 时语言选项里还没有自定义包） */
  ready: boolean
  packs: StoredLocalePack[]
}

export const useLocaleStore = create<LocaleStoreState>(() => ({ ready: false, packs: [] }))

/** 供 i18n 查表用的解析器：同步读当前已加载的包 */
export const resolveLocalePack = (id: string): LocalePackSource | undefined =>
  useLocaleStore.getState().packs.find((pack) => pack.id === id)

const byName = (a: StoredLocalePack, b: StoredLocalePack): number =>
  a.name.localeCompare(b.name) || a.id.localeCompare(b.id)

const applyPacks = (packs: StoredLocalePack[]): void => {
  useLocaleStore.setState({ packs: [...packs].sort(byName) })
}

let initPromise: Promise<void> | null = null

/**
 * 启动加载：读 IndexedDB，并把「已选但已不存在」的自定义语言回退到系统语言。
 * 幂等，重复调用返回同一个 Promise。
 */
export const initLocalePacks = (): Promise<void> =>
  (initPromise ??= (async () => {
    let packs: StoredLocalePack[] = []
    try {
      packs = await listStoredLocalePacks()
    } catch {
      // 存储不可用时按「没有自定义语言」处理，内置语言照常工作
      packs = []
    }
    applyPacks(packs)
    useLocaleStore.setState({ ready: true })
    const id = customLocaleId(useSettings.getState().locale)
    if (id !== null && !packs.some((pack) => pack.id === id)) {
      setLocale(systemLocale())
    }
  })())

export type LocaleImportResult = {
  pack: StoredLocalePack
  importedKeys: number
  skippedKeys: number
  missingKeys: number
}

/** 导入语言包文件：校验 → 写 IndexedDB → 刷新列表（同 id 覆盖）；不自动切换语言 */
export const importLocalePack = async (file: File): Promise<LocaleImportResult> => {
  if (file.size > MAX_LOCALE_PACK_BYTES) {
    // 先按文件大小粗筛，避免把超大文本读进内存
    throw new LocalePackError('tooLarge', `${file.size} bytes`)
  }
  const parsed = parseLocalePackText(await file.text())
  const pack: StoredLocalePack = { ...parsed.pack, importedAt: Date.now() }
  await putStoredLocalePack(pack)
  applyPacks([...useLocaleStore.getState().packs.filter((item) => item.id !== pack.id), pack])
  return {
    pack,
    importedKeys: parsed.importedKeys,
    skippedKeys: parsed.skippedKeys,
    missingKeys: parsed.missingKeys,
  }
}

/**
 * 删除语言包：从 IndexedDB 与列表移除；若正在使用则回退系统语言。
 * 返回是否发生了回退，UI 据此提示。
 */
export const removeLocalePack = async (id: string): Promise<{ fallback: boolean }> => {
  await deleteStoredLocalePack(id)
  applyPacks(useLocaleStore.getState().packs.filter((pack) => pack.id !== id))
  const current = customLocaleId(useSettings.getState().locale)
  if (current === id) {
    setLocale(systemLocale())
    return { fallback: true }
  }
  return { fallback: false }
}

/** 导出当前语言：返回完整 JSON 与下载文件名（内置 / 自定义都支持） */
export const exportCurrentLocale = (): { filename: string; json: string } => {
  const { filename, json } = buildLocalePackExport(useSettings.getState().locale, resolveLocalePack)
  return { filename, json }
}
