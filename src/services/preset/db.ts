/** 预设的 IndexedDB 存储：独立一个库，避免牵动聊天与样式包的 schema。 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { PresetConfig, PresetSummary } from './types.js'

export type StoredPreset = {
  id: string
  config: PresetConfig
  /** 清单 icon.file 指向的图片；手写 JSON 建的预设没有 */
  icon?: Blob
  license?: string
  /** 清单 system_prompt_file 指向的文本；启用时覆盖 config.system_prompt */
  promptText?: string
  importedAt: number
}

interface PresetDB extends DBSchema {
  presets: { key: string; value: StoredPreset }
}

let promise: Promise<IDBPDatabase<PresetDB>> | null = null

const getDB = () =>
  (promise ??= openDB<PresetDB>('dslike-presets', 1, {
    upgrade(db) {
      if (!db.objectStoreNames.contains('presets')) {
        db.createObjectStore('presets', { keyPath: 'id' })
      }
    },
  }))

export const listStoredPresets = async (): Promise<StoredPreset[]> =>
  (await getDB()).getAll('presets')

export const getStoredPreset = async (id: string): Promise<StoredPreset | undefined> =>
  (await getDB()).get('presets', id)

export const putStoredPreset = async (preset: StoredPreset): Promise<void> => {
  await (await getDB()).put('presets', preset)
}

export const deleteStoredPreset = async (id: string): Promise<void> => {
  await (await getDB()).delete('presets', id)
}

export const summarize = (preset: StoredPreset, iconUrl?: string): PresetSummary => ({
  id: preset.id,
  name: preset.config.name,
  description: preset.config.description,
  author: preset.config.author,
  version: preset.config.version,
  protocol: preset.config.protocol,
  baseUrl: preset.config.base_url,
  model: preset.config.model,
  iconUrl,
  importedAt: preset.importedAt,
})
