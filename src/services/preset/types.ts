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

export class PresetError extends Error {
  constructor(
    public code: PresetErrorCode,
    public detail?: string
  ) {
    super(detail ?? code)
    this.name = 'PresetError'
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

/** zip 内文件的引用；缺省表示不使用该文件 */
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
  /** zip 内 system prompt 文件的相对路径，文件优先于 system_prompt；不在会由解析器读成 promptText */
  system_prompt_file?: string
  compaction?: Partial<PresetCompaction>
  memory?: Partial<PresetMemory>
  icon?: PresetFileRef
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
}

/** 参数默认值：清单缺省 params 时使用，新建预设的编辑器模板也用它 */
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
  params: PresetParams
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
  config !== null && config !== undefined && (config.id === DEFAULT_PRESET_ID || config.builtin === true)

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

const resolvedParams = (params: Partial<PresetParams> | undefined): PresetParams => ({
  temperature: params?.temperature ?? DEFAULT_PRESET_PARAMS.temperature,
  top_p: params?.top_p ?? DEFAULT_PRESET_PARAMS.top_p,
  max_tokens: params?.max_tokens ?? DEFAULT_PRESET_PARAMS.max_tokens,
  stop: params?.stop === undefined ? [...DEFAULT_PRESET_PARAMS.stop] : [...params.stop],
  presence_penalty: params?.presence_penalty ?? DEFAULT_PRESET_PARAMS.presence_penalty,
  frequency_penalty: params?.frequency_penalty ?? DEFAULT_PRESET_PARAMS.frequency_penalty,
  seed: params?.seed ?? DEFAULT_PRESET_PARAMS.seed,
  reasoning_effort: params?.reasoning_effort ?? DEFAULT_PRESET_PARAMS.reasoning_effort,
})

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
 * 把预设配置解析成运行时完整配置：缺省字段（以及 null 配置）一律回落到系统默认。
 * 默认值就是「未启用预设」时的行为：DeepSeek Anthropic 兼容端点、MODEL、应用提示词、
 * 默认参数、压缩默认开启、记忆默认关闭。
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
    params: resolvedParams(config?.params),
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
