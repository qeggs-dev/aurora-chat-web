/** API 配置预设的类型定义：api_configs.json 清单、设置页摘要与运行时解析结果；schema 恒为 1。 */
export type PresetProtocol = 'openai' | 'anthropic' | 'responses'

/** 导入与保存失败的稳定错误码，供 UI 映射文案 */
export type PresetErrorCode =
  | 'tooLarge'
  | 'tooManyFiles'
  | 'notZip'
  | 'noConfig'
  | 'badConfig'
  | 'badPath'
  | 'missingFile'
  | 'badFileType'
  /** 尝试导入 / 覆盖内置预设保留的 id（默认预设为 default） */
  | 'reservedId'
  /** 导入的预设只读：保存 / 重命名等修改接口一律拒绝 */
  | 'importedReadOnly'
  /** 非内置预设缺少必填元信息：描述 / 作者 / 版本 / 版权声明（导入与保存共用） */
  | 'missingDescription'
  | 'missingAuthor'
  | 'missingVersion'
  | 'missingCopyright'
  /** 导入包既没有默认位置 LICENSE，也没有 api_configs.json 的 license.file */
  | 'missingLicense'
  /** license.file（或默认 LICENSE）不存在 / 是目录 / 空文件 / 超过大小上限 */
  | 'licenseFileMissing'

export class PresetError extends Error {
  constructor(
    public code: PresetErrorCode,
    public detail?: string
  ) {
    super(detail ?? code)
    this.name = 'PresetError'
  }
}

/**
 * 名称之外、非内置预设必须提供的元信息字段。
 * zip 导入与「保存非内置预设」共用同一套规则（内置默认预设不经过这里）：
 * 四个字段 trim 后都不能为空，尤其 copyright 为空时直接拒绝整个导入包。
 */
export const PRESET_METADATA_FIELDS = ['description', 'author', 'version', 'copyright'] as const

export type PresetMetadataField = (typeof PRESET_METADATA_FIELDS)[number]

/** 每个元信息字段缺失时的稳定错误码，供 UI 映射成字段级文案 */
export const PRESET_METADATA_ERROR_CODES: Readonly<Record<PresetMetadataField, PresetErrorCode>> = {
  description: 'missingDescription',
  author: 'missingAuthor',
  version: 'missingVersion',
  copyright: 'missingCopyright',
}

/** 返回缺失（trim 后为空）的元信息字段，顺序固定。
 *  `allowMissingCopyright`：zip 内有完整 LICENSE 文件时，版权声明可由该文件承担。 */
export const missingPresetMetadata = (
  config: Pick<PresetConfig, PresetMetadataField> | null | undefined,
  options: { allowMissingCopyright?: boolean } = {}
): PresetMetadataField[] =>
  PRESET_METADATA_FIELDS.filter((field) => {
    if (field === 'copyright' && options.allowMissingCopyright) {
      return false
    }
    return !(config?.[field] ?? '').trim()
  })

/** 校验元信息；缺失时抛带字段名的稳定错误码（只报第一个缺失字段） */
export const assertPresetMetadata = (
  config: Pick<PresetConfig, PresetMetadataField>,
  options: { allowMissingCopyright?: boolean } = {}
): void => {
  const missing = missingPresetMetadata(config, options)
  if (missing.length > 0) {
    const field = missing[0]
    throw new PresetError(PRESET_METADATA_ERROR_CODES[field], field)
  }
}

/**
 * 预设来源：`imported` 为 zip 导入包，只读；`created` 为用户新建 / 编辑保存。
 * 旧记录没有该字段时按 `created` 处理（保持向后兼容，仍可编辑）。
 */
export type PresetSource = 'created' | 'imported'

/**
 * 服务层只读拦截：保存 / 重命名等修改接口在写库前调用。
 * 只有 `source === 'imported'` 会抛错（稳定错误码 importedReadOnly），
 * 内置默认预设与旧记录都不受影响。
 */
export const assertPresetEditable = (
  preset: { id?: string; source?: PresetSource } | null | undefined
): void => {
  if (preset?.source === 'imported') {
    throw new PresetError('importedReadOnly', preset.id)
  }
}

/** 采样与生成参数；解析时补齐缺省值，因此各字段在这里永远有值。 */
export type PresetParams = {
  temperature: number
  top_p: number
  max_tokens: number
  stop: string[]
  presence_penalty: number
  frequency_penalty: number
  seed: number | null
  reasoning_effort: string | null
}

/** 上下文压缩设置 */
export type PresetCompaction = {
  enabled: boolean
  trigger_tokens: number
  keep_recent_messages: number
  prompt: string | null
}

/** 长记忆检索设置 */
export type PresetMemory = {
  enabled: boolean
  max_results: number
}

/**
 * zip 内文件的引用。清单里可以省略（或不写该字段）：
 * 导入时会按「默认路径约定」查找（icon.<ext> / LICENSE / system_prompt.md …），
 * 找不到则该资源视为未提供；显式写出但文件不存在仍报 missingFile。
 */
export type PresetFileRef = { file: string }

/** 内置默认预设 id：开机即存在、不可删除，也不能被导入的同 id 包覆盖 */
export const DEFAULT_PRESET_ID = 'default'

/** 系统默认模型：未启用预设、或预设没写 model 时使用（与聊天请求的 MODEL 常量一致） */
export const DEFAULT_PRESET_MODEL = 'deepseek-flash'

/** 系统默认 Anthropic 兼容端点前缀：未启用预设、或预设没写 base_url 时使用 */
export const DEFAULT_PRESET_BASE_URL = `${__API_ORIGIN__}/anthropic/v1`

/**
 * api_configs.json 的结构。
 * 除 schema / id / name 外全部可选：zip 与普通预设由解析器补齐成完整配置，
 * 内置「默认预设」可以只存最简记录，缺省字段在运行时解析成系统默认。
 * 文件（icon / license / system_prompt_file）的引用保留在清单里，内容另存。
 */
export type PresetConfig = {
  schema: 1
  id: string
  name: string
  description?: string
  author?: string
  version?: string
  /** 版权声明正文（纯文本，短声明；完整许可文件走 license） */
  copyright?: string
  /** 内置预设（默认预设 / 后续内置演示包）：不可删除，导入不能覆盖 */
  builtin?: boolean
  protocol?: PresetProtocol
  /** 已去掉结尾斜杠 */
  base_url?: string
  model?: string
  params?: Partial<PresetParams>
  /** 内联 system prompt；缺省时用应用自带 */
  system_prompt?: string
  /**
   * zip 内 system prompt 文件的相对路径，文件优先于 system_prompt；内容由解析器读成 promptText。
   * 缺省时：只有内联 system_prompt 也为空，才按顺序尝试默认文件 system_prompt.md / prompt.md；
   * 显式写出但文件不存在仍报 missingFile（不回退默认文件）。
   */
  system_prompt_file?: string
  compaction?: Partial<PresetCompaction>
  memory?: Partial<PresetMemory>
  /** 包图标：缺省时按默认路径 icon.<ext>（png/webp/svg/jpg/jpeg）查找，找不到视为未提供 */
  icon?: PresetFileRef
  /** 许可证：缺省时按默认位置 LICENSE / LICENSE.txt / LICENSE.md 查找，找不到视为未提供 */
  license?: PresetFileRef
}

/** 设置页列表用的摘要 */
export type PresetSummary = {
  id: string
  name: string
  description?: string
  author?: string
  version?: string
  copyright?: string
  protocol: PresetProtocol
  baseUrl: string
  model: string
  iconUrl?: string
  importedAt: number
  /** 内置预设（默认预设 / 内置演示包）：不可删除 */
  builtin?: boolean
  /** 来源：zip 导入包只读；缺省（旧记录）按 created 处理 */
  source?: PresetSource
  /** 许可证全文（导入包必须有） */
  license?: string
  /** 许可证来源：api_configs.json 显式指定 / 默认 LICENSE 文件；旧记录没有 */
  licenseSource?: 'index' | 'default'
}

/**
 * 采样参数的「参考默认值」：只用于设置页 placeholder 展示与新建预设 JSON 模板，
 * **不会**被写进请求体——留空的参数一律不发送，由接口提供方使用自己的默认值。
 */
export const DEFAULT_PRESET_PARAMS: PresetParams = {
  temperature: 1,
  top_p: 1,
  max_tokens: 4096,
  stop: [],
  presence_penalty: 0,
  frequency_penalty: 0,
  seed: null,
  reasoning_effort: null,
}

export const DEFAULT_PRESET_COMPACTION: PresetCompaction = {
  enabled: true,
  trigger_tokens: 32000,
  keep_recent_messages: 8,
  prompt: null,
}

export const DEFAULT_PRESET_MEMORY: PresetMemory = { enabled: false, max_results: 8 }

/** 预设显式覆盖了哪些字段：空集合表示完全使用系统默认（与无预设等价） */
export type PresetOverrides = {
  protocol: boolean
  base_url: boolean
  model: boolean
  params: ReadonlySet<keyof PresetParams>
  system_prompt: boolean
  compaction: ReadonlySet<keyof PresetCompaction>
  memory: ReadonlySet<keyof PresetMemory>
}

/** 运行时使用的完整预设：缺省字段已解析成系统默认，overrides 记录哪些来自预设本身 */
export type ResolvedPreset = {
  id: string
  name: string
  description?: string
  author?: string
  version?: string
  copyright?: string
  builtin: boolean
  protocol: PresetProtocol
  base_url: string
  model: string
  /**
   * 采样参数：只包含预设里显式写出的字段。
   * 留空 = 请求体里不出现该字段，由接口提供方使用自己的默认值（不是发 0 / 系统默认）。
   */
  params: Partial<PresetParams>
  /** 空串 = 使用应用自带系统提示词 */
  system_prompt: string
  compaction: PresetCompaction
  memory: PresetMemory
  overrides: PresetOverrides
}

/** 内置默认预设的 id 固定为 default */
export const isDefaultPresetId = (id: string): boolean => id === DEFAULT_PRESET_ID

/** 是否为内置预设（默认预设或后续内置演示包） */
export const isBuiltinPreset = (config: PresetConfig | null | undefined): boolean =>
  config !== null &&
  config !== undefined &&
  (config.id === DEFAULT_PRESET_ID || config.builtin === true)

const definedKeys = <T extends object>(value: T | undefined): Set<keyof T> => {
  const keys = new Set<keyof T>()
  if (value === undefined) {
    return keys
  }
  for (const key of Object.keys(value) as (keyof T)[]) {
    if (value[key] !== undefined) {
      keys.add(key)
    }
  }
  return keys
}

/**
 * 采样参数只保留预设里显式写出的字段：留空 = 请求体不出现该字段（接口自己的默认值）。
 * stop 的空数组与 seed / reasoning_effort 的 null 都视作「未设置」，不会写进请求。
 */
const explicitParams = (params: Partial<PresetParams> | undefined): Partial<PresetParams> => {
  const resolved: Partial<PresetParams> = {}
  if (params === undefined) {
    return resolved
  }
  if (params.temperature !== undefined) {
    resolved.temperature = params.temperature
  }
  if (params.top_p !== undefined) {
    resolved.top_p = params.top_p
  }
  if (params.max_tokens !== undefined) {
    resolved.max_tokens = params.max_tokens
  }
  if (params.stop !== undefined) {
    const stop = params.stop.filter((item) => item.trim() !== '')
    if (stop.length > 0) {
      resolved.stop = stop
    }
  }
  if (params.presence_penalty !== undefined) {
    resolved.presence_penalty = params.presence_penalty
  }
  if (params.frequency_penalty !== undefined) {
    resolved.frequency_penalty = params.frequency_penalty
  }
  if (params.seed !== undefined && params.seed !== null) {
    resolved.seed = params.seed
  }
  if (params.reasoning_effort !== undefined && params.reasoning_effort !== null) {
    resolved.reasoning_effort = params.reasoning_effort
  }
  return resolved
}

const resolvedCompaction = (
  compaction: Partial<PresetCompaction> | undefined
): PresetCompaction => ({
  enabled: compaction?.enabled ?? DEFAULT_PRESET_COMPACTION.enabled,
  trigger_tokens: compaction?.trigger_tokens ?? DEFAULT_PRESET_COMPACTION.trigger_tokens,
  keep_recent_messages:
    compaction?.keep_recent_messages ?? DEFAULT_PRESET_COMPACTION.keep_recent_messages,
  prompt: compaction?.prompt ?? DEFAULT_PRESET_COMPACTION.prompt,
})

const resolvedMemory = (memory: Partial<PresetMemory> | undefined): PresetMemory => ({
  enabled: memory?.enabled ?? DEFAULT_PRESET_MEMORY.enabled,
  max_results: memory?.max_results ?? DEFAULT_PRESET_MEMORY.max_results,
})

/**
 * 把预设配置解析成运行时配置：端点 / 模型 / 压缩 / 记忆缺省回落到系统默认；
 * 采样参数只保留显式写出的字段（留空 = 请求里不发送该字段），提示词空串 = 不发送 system。
 * 默认值描述的就是「未启用预设」时的行为：DeepSeek Anthropic 兼容端点、MODEL、默认压缩与记忆。
 */
export const resolvePreset = (config: PresetConfig | null): ResolvedPreset => {
  const baseUrl = config?.base_url?.trim()
  const model = config?.model?.trim()
  const systemPrompt = config?.system_prompt?.trim() ? config.system_prompt : ''
  return {
    id: config?.id ?? '',
    name: config?.name ?? '',
    ...(config?.description === undefined ? {} : { description: config.description }),
    ...(config?.author === undefined ? {} : { author: config.author }),
    ...(config?.version === undefined ? {} : { version: config.version }),
    ...(config?.copyright === undefined ? {} : { copyright: config.copyright }),
    builtin: isBuiltinPreset(config),
    protocol: config?.protocol ?? 'anthropic',
    base_url: baseUrl ? baseUrl.replace(/\/+$/, '') : DEFAULT_PRESET_BASE_URL,
    model: model ? model : DEFAULT_PRESET_MODEL,
    params: explicitParams(config?.params),
    system_prompt: systemPrompt,
    compaction: resolvedCompaction(config?.compaction),
    memory: resolvedMemory(config?.memory),
    overrides: {
      protocol: config?.protocol !== undefined,
      base_url: baseUrl !== undefined && baseUrl !== '',
      model: model !== undefined && model !== '',
      params: definedKeys(config?.params),
      system_prompt: systemPrompt !== '',
      compaction: definedKeys(config?.compaction),
      memory: definedKeys(config?.memory),
    },
  }
}

/**
 * 「默认预设 + 没有填写任何覆盖字段」等价于无预设：只要没有任何字段覆盖，
 * 请求就走与未启用预设完全相同的老路径（端点、MODEL、默认参数、扩展字段全部保留）。
 */
export const isSystemDefaultPreset = (config: PresetConfig | null): boolean => {
  if (config === null) {
    return true
  }
  if (config.id !== DEFAULT_PRESET_ID) {
    return false
  }
  const overrides = resolvePreset(config).overrides
  return (
    !overrides.protocol &&
    !overrides.base_url &&
    !overrides.model &&
    overrides.params.size === 0 &&
    !overrides.system_prompt &&
    overrides.compaction.size === 0 &&
    overrides.memory.size === 0
  )
}
