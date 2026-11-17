/** 预设状态：IndexedDB 存清单与资源，localStorage 只记启用项；列表图标的 objectURL 随刷新重建。 */
import { create } from 'zustand'
import {
  deleteStoredPreset,
  getStoredPreset,
  listStoredPresets,
  putStoredPreset,
  summarize,
} from './db.js'
import {
  DEFAULT_PRESET_COMPACTION,
  DEFAULT_PRESET_MEMORY,
  DEFAULT_PRESET_PARAMS,
  PresetError,
  type PresetConfig,
  type PresetSummary,
} from './types.js'
import { parsePresetConfig, parsePresetZip } from './zip.js'

export type PresetState = {
  ready: boolean
  presets: PresetSummary[]
  activeId: string | null
  active: PresetConfig | null
  /** 导入或保存进行中 */
  importing: boolean
  /** 最近一次导入 / 保存失败的错误码（PresetErrorCode，未知错误为 importFailed / saveFailed） */
  error: string | null
}

const ACTIVE_KEY = 'chat-demo:preset'

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

export const usePresetStore = create<PresetState>(() => ({
  ready: false,
  presets: [],
  activeId: null,
  active: null,
  importing: false,
  error: null,
}))

const { getState: get, setState: set } = usePresetStore

/** 列表图标单独一组 URL，刷新列表时重建 */
const summaryIconUrls = new Map<string, string>()

const releaseSummaryIcons = () => {
  for (const url of summaryIconUrls.values()) {
    URL.revokeObjectURL(url)
  }
  summaryIconUrls.clear()
}

const refreshPresets = async (): Promise<void> => {
  const stored = await listStoredPresets()
  releaseSummaryIcons()
  const presets = stored.map((preset) => {
    let iconUrl: string | undefined
    if (preset.icon) {
      iconUrl = URL.createObjectURL(preset.icon)
      summaryIconUrls.set(preset.id, iconUrl)
    }
    return summarize(preset, iconUrl)
  })
  presets.sort((a, b) => b.importedAt - a.importedAt)
  set({ presets })
}

/** 递增序号：并发的启用请求只有最后一次生效 */
let activationSequence = 0

/** 启用某个预设（null 表示回到应用自带配置）；config 里的 system_prompt 已解析成 zip 内文件内容 */
export const activatePreset = async (id: string | null): Promise<void> => {
  const sequence = ++activationSequence
  const stored = id ? await getStoredPreset(id) : undefined
  if (sequence !== activationSequence) {
    return
  }
  if (!stored) {
    set({ activeId: null, active: null })
    writeActiveId(null)
    return
  }
  // system_prompt_file 的内容在导入时就读成 promptText，文件优先于内联 system_prompt
  const active =
    stored.promptText !== undefined
      ? { ...stored.config, system_prompt: stored.promptText }
      : stored.config
  set({ activeId: stored.id, active })
  writeActiveId(stored.id)
}

const errorCode = (error: unknown, fallback: string): string =>
  error instanceof PresetError ? error.code : fallback

/** 导入 preset zip；同 id 覆盖，当前没有启用项时自动启用 */
export const importPresetZip = async (file: File): Promise<void> => {
  set({ importing: true, error: null })
  try {
    const parsed = await parsePresetZip(file)
    await putStoredPreset({
      id: parsed.config.id,
      config: parsed.config,
      icon: parsed.icon,
      license: parsed.license,
      promptText: parsed.promptText,
      importedAt: Date.now(),
    })
    await refreshPresets()
    if (!get().activeId || get().activeId === parsed.config.id) {
      await activatePreset(parsed.config.id)
    }
    set({ importing: false })
  } catch (error) {
    set({ importing: false, error: errorCode(error, 'importFailed') })
    throw error
  }
}

/**
 * 保存手写的配置 JSON；规则与 zip 清单校验完全一致，同 id 覆盖，无启用项时自动启用。
 * icon / license / system_prompt_file 的内容只能来自 zip：编辑已有预设时沿用旧记录里的文件，
 * 引用一个本机没有内容的文件按 missingFile 失败。
 */
export const savePresetJson = async (text: string): Promise<void> => {
  set({ importing: true, error: null })
  try {
    const config = parsePresetConfig(text)
    const previous = await getStoredPreset(config.id)
    const icon = config.icon ? previous?.icon : undefined
    const license = config.license ? previous?.license : undefined
    // 编辑器回填的是已解析的 system_prompt，允许用它改写旧的文件内容；否则沿用旧文件内容
    const promptText = config.system_prompt_file
      ? (config.system_prompt ?? previous?.promptText)
      : undefined
    if (config.icon && !icon) {
      throw new PresetError('missingFile', config.icon.file)
    }
    if (config.license && license === undefined) {
      throw new PresetError('missingFile', config.license.file)
    }
    if (config.system_prompt_file && promptText === undefined) {
      throw new PresetError('missingFile', config.system_prompt_file)
    }
    await putStoredPreset({
      id: config.id,
      config,
      icon,
      license,
      promptText,
      importedAt: Date.now(),
    })
    await refreshPresets()
    if (!get().activeId || get().activeId === config.id) {
      await activatePreset(config.id)
    }
    set({ importing: false })
  } catch (error) {
    set({ importing: false, error: errorCode(error, 'saveFailed') })
    throw error
  }
}

/** 新建预设时预填的 JSON 模板：字段自带说明，可直接编辑保存 */
export const createPresetDraft = (): string =>
  JSON.stringify(
    {
      $comment:
        '直接编辑后保存。system_prompt 留空则使用应用自带提示词；icon / license / system_prompt_file 只能来自 zip 包，手写 JSON 请勿填写。',
      schema: 1,
      id: `custom-${Date.now().toString(36)}`,
      name: '自定义预设',
      description: '',
      author: '',
      version: '1.0.0',
      protocol: 'openai',
      base_url: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      params: { ...DEFAULT_PRESET_PARAMS, stop: [] },
      system_prompt: '',
      compaction: { ...DEFAULT_PRESET_COMPACTION },
      memory: { ...DEFAULT_PRESET_MEMORY },
    },
    null,
    2
  )

/** 删除预设；若是启用项先置空，再删库 */
export const removePreset = async (id: string): Promise<void> => {
  if (get().activeId === id) {
    await activatePreset(null)
  }
  await deleteStoredPreset(id)
  await refreshPresets()
}

let initTask: Promise<void> | undefined

/** 读取已存预设并恢复上次启用的项；只执行一次 */
export const initPresets = (): Promise<void> =>
  (initTask ??= (async () => {
    try {
      await refreshPresets()
      const saved = readActiveId()
      if (saved && get().presets.some((preset) => preset.id === saved)) {
        await activatePreset(saved)
      } else {
        await activatePreset(null)
      }
    } catch {
      // 读取失败时保持空列表，不阻塞界面
    } finally {
      set({ ready: true })
    }
  })())

export const usePresetState = (): PresetState => usePresetStore()

/** 当前启用的预设配置（非 hook 的读取见 getActivePreset） */
export const useActivePreset = (): PresetConfig | null => usePresetStore((state) => state.active)

/** 给 API 层用的同步读取：当前启用的预设配置，未启用时为 null */
export const getActivePreset = (): PresetConfig | null => usePresetStore.getState().active
/** 读取某个预设的完整配置（供编辑器回填；启用项也可直接用 usePresetState().active） */
export const loadPresetConfig = async (id: string): Promise<PresetConfig | null> => {
  const stored = await getStoredPreset(id)
  if (!stored) {
    return null
  }
  // zip 里的提示词文件在导入时已经读成 promptText，编辑器回填时要合并进 config
  return stored.promptText !== undefined
    ? { ...stored.config, system_prompt: stored.promptText }
    : stored.config
}
