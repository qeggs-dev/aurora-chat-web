/** 预设的 IndexedDB 存储：独立一个库，避免牵动聊天与样式包的 schema。 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import { isBuiltinPreset, resolvePreset, type PresetConfig, type PresetSummary } from './types.js'

export type StoredPreset = {
  id: string
  config: PresetConfig
  /** 清单 icon.file 指向的图片；手写 JSON 建的预设没有 */
  icon?: Blob
  license?: string
  /** 清单 system_prompt_file 指向的文本；启用时覆盖 config.system_prompt */
  promptText?: string
  importedAt: number
  /** 内置预设（默认预设 / 内置演示包）：不可删除，导入不能覆盖 */
  builtin?: boolean
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

/** 列表摘要：协议 / 端点 / 模型取解析后的值，默认预设也能显示完整信息 */
export const summarize = (preset: StoredPreset, iconUrl?: string): PresetSummary => {
  const resolved = resolvePreset(preset.config)
  return {
    id: preset.id,
    name: preset.config.name,
    description: preset.config.description,
    author: preset.config.author,
    version: preset.config.version,
    copyright: preset.config.copyright,
    protocol: resolved.protocol,
    baseUrl: resolved.base_url,
    model: resolved.model,
    iconUrl,
    importedAt: preset.importedAt,
    builtin: preset.builtin === true || isBuiltinPreset(preset.config) ? true : undefined,
  }
}
