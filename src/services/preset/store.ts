/** 预设状态：IndexedDB 存清单与资源，localStorage 只记启用项；列表图标的 objectURL 随刷新重建。 */
import { create } from 'zustand'
import {
  deleteStoredPreset,
  getStoredPreset,
  listStoredPresets,
  putStoredPreset,
  summarize,
  type StoredPreset,
} from './db.js'
import {
  DEFAULT_PRESET_COMPACTION,
  DEFAULT_PRESET_ID,
  DEFAULT_PRESET_MEMORY,
  DEFAULT_PRESET_PARAMS,
  assertPresetEditable,
  isSystemDefaultPreset,
  PresetError,
  resolvePreset,
  type PresetConfig,
  type PresetSummary,
  type ResolvedPreset,
} from './types.js'
import { parsePresetConfigForSave, parsePresetZip } from './zip.js'

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

/** 内置默认预设的展示名（记录里也用它初始化；用户改名后以存储值为准） */
export const DEFAULT_PRESET_NAME = '默认配置'

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
  // 内置默认预设固定第一个显示，其余按导入时间倒序
  presets.sort((a, b) => {
    const aDefault = a.id === DEFAULT_PRESET_ID ? 1 : 0
    const bDefault = b.id === DEFAULT_PRESET_ID ? 1 : 0
    return aDefault === bDefault ? b.importedAt - a.importedAt : bDefault - aDefault
  })
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

/** 内置默认预设的最简存储记录：只含 schema / id / name / builtin，其余字段运行时取系统默认 */
const defaultPresetRecord = (): StoredPreset => ({
  id: DEFAULT_PRESET_ID,
  config: {
    schema: 1,
    id: DEFAULT_PRESET_ID,
    name: DEFAULT_PRESET_NAME,
    builtin: true,
  },
  importedAt: Date.now(),
  builtin: true,
})

/** 确保内置默认预设存在（幂等）：缺失时写入最小记录，旧记录缺 builtin 标记时补上 */
const ensureDefaultPreset = async (): Promise<void> => {
  const stored = await getStoredPreset(DEFAULT_PRESET_ID)
  if (!stored) {
    await putStoredPreset(defaultPresetRecord())
    return
  }
  if (stored.builtin === true && stored.config.builtin === true && stored.config.name.trim()) {
    return
  }
  await putStoredPreset({
    ...stored,
    config: {
      ...stored.config,
      id: DEFAULT_PRESET_ID,
      name: stored.config.name.trim() || DEFAULT_PRESET_NAME,
      builtin: true,
    },
    builtin: true,
  })
}

/** 导入 preset zip；同 id 覆盖，当前没有启用项时自动启用 */
export const importPresetZip = async (file: File): Promise<void> => {
  set({ importing: true, error: null })
  try {
    const parsed = await parsePresetZip(file)
    // 内置预设的 id 保留给内置记录：默认预设不能被同 id 的 zip 覆盖
    if (parsed.config.id === DEFAULT_PRESET_ID) {
      throw new PresetError('reservedId', parsed.config.id)
    }
    const previous = await getStoredPreset(parsed.config.id)
    if (previous?.builtin) {
      throw new PresetError('reservedId', parsed.config.id)
    }
    await putStoredPreset({
      id: parsed.config.id,
      config: parsed.config,
      icon: parsed.icon,
      license: parsed.license,
      promptText: parsed.promptText,
      importedAt: Date.now(),
      // 导入包只读：来源标记由服务层保存，UI 与保存接口据此拦截修改
      source: 'imported',
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
 * 保存手写的配置 JSON；普通预设的规则与 zip 清单校验完全一致，同 id 覆盖，无启用项时自动启用。
 * 内置默认预设走独立的部分字段解析：允许只含 schema / id / name，留空字段表示使用系统默认。
 * icon / license / system_prompt_file 的内容只能来自 zip：编辑已有预设时沿用旧记录里的文件，
 * 引用一个本机没有内容的文件按 missingFile 失败。
 */
export const savePresetJson = async (text: string): Promise<void> => {
  set({ importing: true, error: null })
  try {
    const config = parsePresetConfigForSave(text)
    const isDefault = config.id === DEFAULT_PRESET_ID
    const previous = await getStoredPreset(config.id)
    // 导入的预设只读：保存 / 重命名等修改一律拒绝（删除不受限）。默认预设与旧记录不受影响。
    assertPresetEditable(previous)
    // 内置演示包的配置可以被编辑，但普通预设不能占用它的 id
    if (previous?.builtin && !isDefault) {
      throw new PresetError('reservedId', config.id)
    }
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
    const storedConfig: PresetConfig =
      isDefault || previous?.builtin === true
        ? { ...config, builtin: true }
        : config
    await putStoredPreset({
      id: storedConfig.id,
      config: storedConfig,
      icon,
      license,
      promptText,
      importedAt: isDefault ? (previous?.importedAt ?? Date.now()) : Date.now(),
      ...(previous?.builtin === true || isDefault ? { builtin: true } : {}),
      // 新建 / 编辑保存的预设都是可编辑的；内置预设不记来源（内置语义优先）
      ...(isDefault || previous?.builtin === true ? {} : { source: 'created' as const }),
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
      copyright: '',
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

/**
 * 删除预设；内置预设（默认预设 / 内置演示包）拒绝删除并静默忽略。
 * 删除当前启用项后自动启用默认预设——保证永远至少有一个可用预设。
 */
export const removePreset = async (id: string): Promise<void> => {
  if (id === DEFAULT_PRESET_ID) {
    return
  }
  const stored = await getStoredPreset(id)
  if (stored?.builtin) {
    return
  }
  if (get().activeId === id) {
    // 默认预设理论上总在；先补齐再启用，避免列表为空时没有可启用项
    await ensureDefaultPreset()
    await refreshPresets()
    await activatePreset(DEFAULT_PRESET_ID)
  }
  await deleteStoredPreset(id)
  await refreshPresets()
}

let initTask: Promise<void> | undefined

/** 初始化：确保默认预设存在，读取已存预设并恢复上次启用的项；只执行一次 */
export const initPresets = (): Promise<void> =>
  (initTask ??= (async () => {
    try {
      await ensureDefaultPreset()
      await refreshPresets()
      const saved = readActiveId()
      if (saved && get().presets.some((preset) => preset.id === saved)) {
        await activatePreset(saved)
      } else {
        // 未设置启用项（首次安装 / 记录失效）时默认启用内置默认预设
        await activatePreset(DEFAULT_PRESET_ID)
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

/**
 * 给请求层用的同步读取：当前启用预设的解析结果。
 * 「默认预设 + 没有填写任何覆盖字段」与无预设完全等价，这里返回 null，
 * 让 client / reply / 压缩等调用方走与接入预设前完全相同的代码路径。
 */
export const getActiveResolvedPreset = (): ResolvedPreset | null => {
  const active = usePresetStore.getState().active
  return isSystemDefaultPreset(active) ? null : resolvePreset(active)
}

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
