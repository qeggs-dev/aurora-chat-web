/** 样式包的 IndexedDB 存储：与聊天数据分开一个库，避免牵动聊天 schema 迁移。 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { StyleManifest, StylePackSummary, ThemedBlobs, ThemedUrls } from './types.js'

export type StoredStylePack = {
  id: string
  manifest: StyleManifest
  assets: Record<string, Blob>
  /** 包图标 blob，按主题分开；旧版本存的是单个 Blob，读取时归一化 */
  icon?: ThemedBlobs
  /** 详情页封面 blob，按主题分开（每个文件导入时 ≤5 MB） */
  cover?: ThemedBlobs
  license?: string
  importedAt: number
}

interface StyleDB extends DBSchema {
  packs: { key: string; value: StoredStylePack }
}

let promise: Promise<IDBPDatabase<StyleDB>> | null = null

const getDB = () =>
  (promise ??= openDB<StyleDB>('dslike-style', 1, {
    upgrade(db) {
      if (!db.objectStoreNames.contains('packs')) {
        db.createObjectStore('packs', { keyPath: 'id' })
      }
    },
  }))

/**
 * 兼容旧库：主题化之前 icon / cover 是单个 Blob，读出来归一化成两个主题共用同一张。
 * 不需要升级 IndexedDB 版本，旧 profile 直接可用。
 */
const normalizeBlobs = (value: unknown): ThemedBlobs | undefined => {
  if (value instanceof Blob) {
    return { light: value, dark: value }
  }
  if (value === null || typeof value !== 'object') {
    return undefined
  }
  const record = value as Record<string, unknown>
  const light = record.light instanceof Blob ? record.light : undefined
  const dark = record.dark instanceof Blob ? record.dark : undefined
  return light || dark ? { light, dark } : undefined
}

const normalizeStoredPack = (pack: StoredStylePack): StoredStylePack => ({
  ...pack,
  icon: normalizeBlobs(pack.icon),
  cover: normalizeBlobs(pack.cover),
})

export const listStoredStylePacks = async (): Promise<StoredStylePack[]> =>
  (await (await getDB()).getAll('packs')).map(normalizeStoredPack)

export const getStoredStylePack = async (id: string): Promise<StoredStylePack | undefined> => {
  const pack = await (await getDB()).get('packs', id)
  return pack ? normalizeStoredPack(pack) : undefined
}

export const putStoredStylePack = async (pack: StoredStylePack): Promise<void> => {
  await (await getDB()).put('packs', pack)
}

export const deleteStoredStylePack = async (id: string): Promise<void> => {
  await (await getDB()).delete('packs', id)
}

export const summarize = (
  pack: StoredStylePack,
  urls: { iconUrls?: ThemedUrls; coverUrls?: ThemedUrls } = {}
): StylePackSummary => ({
  id: pack.id,
  name: pack.manifest.name,
  description: pack.manifest.description,
  author: pack.manifest.author,
  version: pack.manifest.version,
  iconUrls: urls.iconUrls,
  coverUrls: urls.coverUrls,
  importedAt: pack.importedAt,
  manifest: pack.manifest,
  license: pack.license,
})
