/** 自定义语言包的 IndexedDB 存储：独立 `dslike-locale` 库，避免牵动聊天 / 样式 / 预设的 schema。 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { LocalePack } from './pack.js'

/** 一条已导入的语言包：完整 schema 1 内容 + 导入时间 */
export type StoredLocalePack = LocalePack & { importedAt: number }

interface LocaleDB extends DBSchema {
  locales: { key: string; value: StoredLocalePack }
}

let promise: Promise<IDBPDatabase<LocaleDB>> | null = null

const getDB = () =>
  (promise ??= openDB<LocaleDB>('dslike-locale', 1, {
    upgrade(db) {
      if (!db.objectStoreNames.contains('locales')) {
        db.createObjectStore('locales', { keyPath: 'id' })
      }
    },
  }))

export const listStoredLocalePacks = async (): Promise<StoredLocalePack[]> =>
  getDB().then((db) => db.getAll('locales'))

export const getStoredLocalePack = async (id: string): Promise<StoredLocalePack | undefined> =>
  getDB().then((db) => db.get('locales', id))

export const putStoredLocalePack = async (pack: StoredLocalePack): Promise<void> => {
  await (await getDB()).put('locales', pack)
}

export const deleteStoredLocalePack = async (id: string): Promise<void> => {
  await (await getDB()).delete('locales', id)
}
