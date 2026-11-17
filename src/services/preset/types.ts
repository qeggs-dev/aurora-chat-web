/** API 配置预设的类型定义：api_configs.json 清单与设置页摘要；schema 恒为 1。 */
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

/** api_configs.json 的结构；文件（icon / license / system_prompt_file）的引用保留在清单里，内容另存 */
export type PresetConfig = {
  schema: 1
  id: string
  name: string
  description?: string
  author?: string
  version?: string
  protocol: PresetProtocol
  /** 已去掉结尾斜杠 */
  base_url: string
  model: string
  params: PresetParams
  /** 内联 system prompt；缺省时用应用自带 */
  system_prompt?: string
  /** zip 内 system prompt 文件的相对路径，文件优先于 system_prompt；不在会由解析器读成 promptText */
  system_prompt_file?: string
  compaction: PresetCompaction
  memory: PresetMemory
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
  protocol: PresetProtocol
  baseUrl: string
  model: string
  iconUrl?: string
  importedAt: number
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
