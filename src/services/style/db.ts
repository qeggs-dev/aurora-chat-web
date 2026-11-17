/** 样式包的 IndexedDB 存储：与聊天数据分开一个库，避免牵动聊天 schema 迁移。 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { StyleManifest, StylePackSummary } from './types.js'

export type StoredStylePack = {
  id: string
  manifest: StyleManifest
  assets: Record<string, Blob>
  icon?: Blob
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

export const listStoredStylePacks = async (): Promise<StoredStylePack[]> => (await getDB()).getAll('packs')

export const getStoredStylePack = async (id: string): Promise<StoredStylePack | undefined> =>
  (await getDB()).get('packs', id)

export const putStoredStylePack = async (pack: StoredStylePack): Promise<void> => {
  await (await getDB()).put('packs', pack)
}

export const deleteStoredStylePack = async (id: string): Promise<void> => {
  await (await getDB()).delete('packs', id)
}

export const summarize = (pack: StoredStylePack, iconUrl?: string): StylePackSummary => ({
  id: pack.id,
  name: pack.manifest.name,
  description: pack.manifest.description,
  author: pack.manifest.author,
  version: pack.manifest.version,
  iconUrl,
  importedAt: pack.importedAt,
})
