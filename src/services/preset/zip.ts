/** preset zip 与 api_configs.json 的解析与校验：路径、大小、扩展名与清单字段都在这里把关。 */
import { readZipEntries, ZipReadError } from '../zip/reader.js'
import {
  assertPresetMetadata,
  DEFAULT_PRESET_COMPACTION,
  DEFAULT_PRESET_ID,
  DEFAULT_PRESET_MEMORY,
  DEFAULT_PRESET_PARAMS,
  PresetError,
  type PresetCompaction,
  type PresetConfig,
  type PresetFileRef,
  type PresetMemory,
  type PresetParams,
  type PresetProtocol,
} from './types.js'

const MAX_ZIP_BYTES = 5 * 1024 * 1024
const MAX_TOTAL_BYTES = 10 * 1024 * 1024
const MAX_ENTRY_BYTES = 5 * 1024 * 1024
const MAX_ENTRIES = 100
const MAX_LICENSE_BYTES = 200 * 1024
const MAX_PROMPT_BYTES = 64 * 1024
const MAX_TEXT_FIELD = 400
const MAX_COPYRIGHT_LENGTH = 500

/** 清单必须位于 zip 根目录 */
const CONFIG_FILE = 'api_configs.json'

const PROTOCOLS = new Set<PresetProtocol>(['openai', 'anthropic', 'responses'])
const ICON_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'svg'])
const PROMPT_EXT = new Set(['md', 'txt'])

/**
 * 默认路径候选（只影响清单里没写 file 时；显式路径仍然严格）。
 * 大小写不敏感匹配，按顺序尝试，命中即用。
 */
const DEFAULT_ICON_PATHS = ['icon.png', 'icon.webp', 'icon.svg', 'icon.jpg', 'icon.jpeg'] as const
const DEFAULT_LICENSE_PATHS = ['LICENSE', 'LICENSE.txt', 'LICENSE.md'] as const
/** 没写 system_prompt_file、也没写内联 system_prompt 时，按顺序尝试这两个默认提示词文件 */
const DEFAULT_PROMPT_PATHS = ['system_prompt.md', 'prompt.md'] as const

const ICON_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  svg: 'image/svg+xml',
}

const extensionOf = (name: string): string => {
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase()
}

const badConfig = (detail: string): never => {
  throw new PresetError('badConfig', detail)
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const readNumber = (
  value: unknown,
  field: string,
  min: number,
  max: number,
  fallback: number
): number => {
  if (value === undefined || value === null) {
    return fallback
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    return badConfig(`${field} must be a number between ${min} and ${max}`)
  }
  return value
}

const readInteger = (
  value: unknown,
  field: string,
  min: number,
  max: number,
  fallback: number
): number => {
  if (value === undefined || value === null) {
    return fallback
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    return badConfig(`${field} must be an integer between ${min} and ${max}`)
  }
  return value
}

const readPositiveInteger = (value: unknown, field: string, fallback: number): number => {
  if (value === undefined || value === null) {
    return fallback
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    return badConfig(`${field} must be a positive integer`)
  }
  return value
}

const readBoolean = (value: unknown, field: string, fallback: boolean): boolean => {
  if (value === undefined || value === null) {
    return fallback
  }
  if (typeof value !== 'boolean') {
    return badConfig(`${field} must be a boolean`)
  }
  return value
}

/** 可选的短文本字段：去空白后为空视作缺省 */
const readOptionalText = (value: unknown, field: string): string | undefined => {
  if (value === undefined || value === null) {
    return undefined
  }
  if (typeof value !== 'string') {
    return badConfig(`${field} must be a string`)
  }
  const text = value.trim()
  if (!text) {
    return undefined
  }
  if (text.length > MAX_TEXT_FIELD) {
    return badConfig(`${field} must be at most ${MAX_TEXT_FIELD} chars`)
  }
  return text
}

/** 控制字符检查：只放行换行 / 回车 / 制表，其余 C0 与 DEL 视为非法 */
const hasControlChars = (text: string): boolean => {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    const allowed = code === 9 || code === 10 || code === 13
    if ((code < 32 || code === 127) && !allowed) {
      return true
    }
  }
  return false
}

/** 版权声明：纯文本短声明（可多行），拒绝控制字符与 `<` / `>`，最长 500 字 */
const readCopyright = (value: unknown): string | undefined => {
  if (value === undefined || value === null) {
    return undefined
  }
  if (typeof value !== 'string') {
    return badConfig('copyright must be a string')
  }
  const text = value.trim()
  if (!text) {
    return undefined
  }
  if (hasControlChars(text)) {
    return badConfig('copyright must not contain control characters')
  }
  if (text.includes('<') || text.includes('>')) {
    return badConfig('copyright must not contain < or >')
  }
  if (text.length > MAX_COPYRIGHT_LENGTH) {
    return badConfig(`copyright must be at most ${MAX_COPYRIGHT_LENGTH} chars`)
  }
  return text
}

/** system prompt 保留原始排版，只把全空白视作缺省 */
const readSystemPrompt = (value: unknown): string | undefined => {
  if (value === undefined || value === null) {
    return undefined
  }
  if (typeof value !== 'string') {
    return badConfig('system_prompt must be a string')
  }
  return value.trim() ? value : undefined
}

const readFileRef = (value: unknown, field: string): PresetFileRef | undefined => {
  if (value === undefined || value === null) {
    return undefined
  }
  const file = typeof value === 'string' ? value : isRecord(value) ? value.file : undefined
  if (typeof file !== 'string' || !file.trim()) {
    return badConfig(`${field}.file must be a non-empty string`)
  }
  return { file: file.trim() }
}

const readStop = (value: unknown): string[] => {
  if (value === undefined || value === null) {
    return []
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    return badConfig('params.stop must be an array of strings')
  }
  return value as string[]
}

const readReasoningEffort = (value: unknown): string | null => {
  if (value === undefined || value === null) {
    return null
  }
  if (typeof value !== 'string') {
    return badConfig('params.reasoning_effort must be a string or null')
  }
  return value.trim() || null
}

const readSeed = (value: unknown): number | null => {
  if (value === undefined || value === null) {
    return null
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    return badConfig('params.seed must be an integer or null')
  }
  return value
}

/** compaction.prompt 是提示词正文，不设短文本上限，只把全空白视作缺省 */
const readNullablePrompt = (value: unknown, field: string): string | null => {
  if (value === undefined || value === null) {
    return null
  }
  if (typeof value !== 'string') {
    return badConfig(`${field} must be a string or null`)
  }
  return value.trim() ? value : null
}

const readCompaction = (raw: unknown): PresetCompaction => {
  if (raw === undefined || raw === null) {
    return { ...DEFAULT_PRESET_COMPACTION }
  }
  if (!isRecord(raw)) {
    return badConfig('compaction must be an object')
  }
  return {
    enabled: readBoolean(raw.enabled, 'compaction.enabled', DEFAULT_PRESET_COMPACTION.enabled),
    trigger_tokens: readPositiveInteger(
      raw.trigger_tokens,
      'compaction.trigger_tokens',
      DEFAULT_PRESET_COMPACTION.trigger_tokens
    ),
    keep_recent_messages: readInteger(
      raw.keep_recent_messages,
      'compaction.keep_recent_messages',
      0,
      100,
      DEFAULT_PRESET_COMPACTION.keep_recent_messages
    ),
    prompt: readNullablePrompt(raw.prompt, 'compaction.prompt'),
  }
}

const readMemory = (raw: unknown): PresetMemory => {
  if (raw === undefined || raw === null) {
    return { ...DEFAULT_PRESET_MEMORY }
  }
  if (!isRecord(raw)) {
    return badConfig('memory must be an object')
  }
  return {
    enabled: readBoolean(raw.enabled, 'memory.enabled', DEFAULT_PRESET_MEMORY.enabled),
    max_results: readInteger(
      raw.max_results,
      'memory.max_results',
      1,
      50,
      DEFAULT_PRESET_MEMORY.max_results
    ),
  }
}

const parseJsonObject = (text: string): Record<string, unknown> => {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new PresetError('badConfig', 'api_configs.json is not valid JSON')
  }
  if (!isRecord(raw)) {
    return badConfig('api_configs.json must be an object')
  }
  return raw
}

/** schema / id / name 三个基本字段：zip、手写 JSON 与内置默认预设共用 */
const readIdentity = (raw: Record<string, unknown>): { id: string; name: string } => {
  if (raw.schema !== 1) {
    return badConfig('schema must be 1')
  }
  if (typeof raw.id !== 'string' || !/^[a-z0-9._-]{1,64}$/.test(raw.id)) {
    return badConfig('id must be 1-64 chars of [a-z0-9._-]')
  }
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  if (!name || name.length > 80) {
    return badConfig('name must be 1-80 chars')
  }
  return { id: raw.id, name }
}

const hasValue = (value: unknown): boolean => value !== undefined && value !== null

/* ---------- 内置默认预设的「部分字段」解析：留空 = 系统默认 ---------- */

const readOptionalProtocol = (value: unknown): PresetProtocol | undefined => {
  if (!hasValue(value)) {
    return undefined
  }
  if (typeof value !== 'string' || !PROTOCOLS.has(value as PresetProtocol)) {
    return badConfig('protocol must be openai, anthropic or responses')
  }
  return value as PresetProtocol
}

const readOptionalBaseUrl = (value: unknown): string | undefined => {
  if (!hasValue(value)) {
    return undefined
  }
  if (typeof value !== 'string' || !/^https?:\/\/\S+$/i.test(value.trim())) {
    return badConfig('base_url must start with http(s)://')
  }
  return value.trim().replace(/\/+$/, '')
}

const readOptionalModel = (value: unknown): string | undefined => {
  if (!hasValue(value)) {
    return undefined
  }
  if (typeof value !== 'string' || !value.trim()) {
    return badConfig('model must be a non-empty string')
  }
  return value.trim()
}

const readPartialParams = (raw: unknown): Partial<PresetParams> | undefined => {
  if (raw === undefined || raw === null) {
    return undefined
  }
  if (!isRecord(raw)) {
    return badConfig('params must be an object')
  }
  const params: Partial<PresetParams> = {}
  if (hasValue(raw.temperature)) {
    params.temperature = readNumber(
      raw.temperature,
      'params.temperature',
      0,
      2,
      DEFAULT_PRESET_PARAMS.temperature
    )
  }
  if (hasValue(raw.top_p)) {
    params.top_p = readNumber(raw.top_p, 'params.top_p', 0, 1, DEFAULT_PRESET_PARAMS.top_p)
  }
  if (hasValue(raw.max_tokens)) {
    params.max_tokens = readPositiveInteger(
      raw.max_tokens,
      'params.max_tokens',
      DEFAULT_PRESET_PARAMS.max_tokens
    )
  }
  if (hasValue(raw.stop)) {
    params.stop = readStop(raw.stop)
  }
  if (hasValue(raw.presence_penalty)) {
    params.presence_penalty = readNumber(
      raw.presence_penalty,
      'params.presence_penalty',
      -2,
      2,
      DEFAULT_PRESET_PARAMS.presence_penalty
    )
  }
  if (hasValue(raw.frequency_penalty)) {
    params.frequency_penalty = readNumber(
      raw.frequency_penalty,
      'params.frequency_penalty',
      -2,
      2,
      DEFAULT_PRESET_PARAMS.frequency_penalty
    )
  }
  if (hasValue(raw.seed)) {
    const seed = readSeed(raw.seed)
    if (seed !== null) {
      params.seed = seed
    }
  }
  if (hasValue(raw.reasoning_effort)) {
    const effort = readReasoningEffort(raw.reasoning_effort)
    if (effort !== null) {
      params.reasoning_effort = effort
    }
  }
  return Object.keys(params).length > 0 ? params : undefined
}

const readPartialCompaction = (raw: unknown): Partial<PresetCompaction> | undefined => {
  if (raw === undefined || raw === null) {
    return undefined
  }
  if (!isRecord(raw)) {
    return badConfig('compaction must be an object')
  }
  const compaction: Partial<PresetCompaction> = {}
  if (hasValue(raw.enabled)) {
    compaction.enabled = readBoolean(
      raw.enabled,
      'compaction.enabled',
      DEFAULT_PRESET_COMPACTION.enabled
    )
  }
  if (hasValue(raw.trigger_tokens)) {
    compaction.trigger_tokens = readPositiveInteger(
      raw.trigger_tokens,
      'compaction.trigger_tokens',
      DEFAULT_PRESET_COMPACTION.trigger_tokens
    )
  }
  if (hasValue(raw.keep_recent_messages)) {
    compaction.keep_recent_messages = readInteger(
      raw.keep_recent_messages,
      'compaction.keep_recent_messages',
      0,
      100,
      DEFAULT_PRESET_COMPACTION.keep_recent_messages
    )
  }
  if (hasValue(raw.prompt)) {
    const prompt = readNullablePrompt(raw.prompt, 'compaction.prompt')
    if (prompt !== null) {
      compaction.prompt = prompt
    }
  }
  return Object.keys(compaction).length > 0 ? compaction : undefined
}

const readPartialMemory = (raw: unknown): Partial<PresetMemory> | undefined => {
  if (raw === undefined || raw === null) {
    return undefined
  }
  if (!isRecord(raw)) {
    return badConfig('memory must be an object')
  }
  const memory: Partial<PresetMemory> = {}
  if (hasValue(raw.enabled)) {
    memory.enabled = readBoolean(raw.enabled, 'memory.enabled', DEFAULT_PRESET_MEMORY.enabled)
  }
  if (hasValue(raw.max_results)) {
    memory.max_results = readInteger(
      raw.max_results,
      'memory.max_results',
      1,
      50,
      DEFAULT_PRESET_MEMORY.max_results
    )
  }
  return Object.keys(memory).length > 0 ? memory : undefined
}

/**
 * 严格解析：zip 导入与普通预设保存共用，protocol / base_url / model 与四项元信息必填。
 * 元信息（描述 / 作者 / 版本 / 版权声明）trim 后不能为空；copyright 为空直接拒绝整个导入包。
 * 内置默认预设走 parseDefaultPresetConfig（它只需要 name），不经过这里。
 */
const parseFullPresetConfig = (
  raw: Record<string, unknown>,
  options: { allowMissingCopyright?: boolean } = {}
): PresetConfig => {
  const { id, name } = readIdentity(raw)
  if (typeof raw.protocol !== 'string' || !PROTOCOLS.has(raw.protocol as PresetProtocol)) {
    return badConfig('protocol must be openai, anthropic or responses')
  }
  if (typeof raw.base_url !== 'string' || !/^https?:\/\/\S+$/i.test(raw.base_url.trim())) {
    return badConfig('base_url must start with http(s)://')
  }
  const model = typeof raw.model === 'string' ? raw.model.trim() : ''
  if (!model) {
    return badConfig('model must be a non-empty string')
  }
  const config: PresetConfig = {
    schema: 1,
    id,
    name,
    description: readOptionalText(raw.description, 'description'),
    author: readOptionalText(raw.author, 'author'),
    version: readOptionalText(raw.version, 'version'),
    copyright: readCopyright(raw.copyright),
    protocol: raw.protocol as PresetProtocol,
    base_url: raw.base_url.trim().replace(/\/+$/, ''),
    model,
    // 采样参数只保存显式写出的字段：留空 = 请求体不出现该字段（接口默认值）
    params: readPartialParams(raw.params),
    system_prompt: readSystemPrompt(raw.system_prompt),
    system_prompt_file: readOptionalText(raw.system_prompt_file, 'system_prompt_file'),
    compaction: readCompaction(raw.compaction),
    memory: readMemory(raw.memory),
    icon: readFileRef(raw.icon, 'icon'),
    license: readFileRef(raw.license, 'license'),
  }
  assertPresetMetadata(config, options)
  return config
}

/** 去掉值为 undefined 的键：默认预设的最小记录不落空字段（IndexedDB 会保留 undefined 属性） */
const compactPresetConfig = (config: PresetConfig): PresetConfig => {
  const next: PresetConfig = { schema: config.schema, id: config.id, name: config.name }
  const optionalKeys = [
    'description',
    'author',
    'version',
    'copyright',
    'builtin',
    'protocol',
    'base_url',
    'model',
    'params',
    'system_prompt',
    'system_prompt_file',
    'compaction',
    'memory',
    'icon',
    'license',
  ] as const
  for (const key of optionalKeys) {
    const value = config[key]
    if (value !== undefined) {
      Object.assign(next, { [key]: value })
    }
  }
  return next
}

/**
 * 内置默认预设的解析：只要求 schema / id / name，其余字段「填了才覆盖」。
 * 这是默认预设的独立保存路径，不放松 zip 与普通预设的必填校验。
 */
const parseDefaultPresetConfig = (raw: Record<string, unknown>): PresetConfig => {
  const { id, name } = readIdentity(raw)
  if (id !== DEFAULT_PRESET_ID) {
    return badConfig(`default preset must use id ${DEFAULT_PRESET_ID}`)
  }
  return compactPresetConfig({
    schema: 1,
    id,
    name,
    description: readOptionalText(raw.description, 'description'),
    author: readOptionalText(raw.author, 'author'),
    version: readOptionalText(raw.version, 'version'),
    copyright: readCopyright(raw.copyright),
    builtin: true,
    protocol: readOptionalProtocol(raw.protocol),
    base_url: readOptionalBaseUrl(raw.base_url),
    model: readOptionalModel(raw.model),
    params: readPartialParams(raw.params),
    system_prompt: readSystemPrompt(raw.system_prompt),
    system_prompt_file: readOptionalText(raw.system_prompt_file, 'system_prompt_file'),
    compaction: readPartialCompaction(raw.compaction),
    memory: readPartialMemory(raw.memory),
    icon: readFileRef(raw.icon, 'icon'),
    license: readFileRef(raw.license, 'license'),
  })
}

/** 解析并校验 preset 清单；zip 导入与普通预设的保存共用这一套规则。 */
export const parsePresetConfig = (text: string): PresetConfig =>
  parseFullPresetConfig(parseJsonObject(text))

/**
 * zip 导入专用：内嵌 LICENSE 文件可以代替 copyright 字段，
 * 因此先跳过 copyright 校验，等解析到 LICENSE 后再在 parsePresetZip 里补判。
 */
export const parsePresetConfigForImport = (text: string): PresetConfig =>
  parseFullPresetConfig(parseJsonObject(text), { allowMissingCopyright: true })

/**
 * 保存手写 JSON 的入口：普通预设仍走严格校验；内置默认预设允许只含部分字段
 * （留空的字段在运行时解析成系统默认）。
 */
export const parsePresetConfigForSave = (text: string): PresetConfig => {
  const raw = parseJsonObject(text)
  if (raw.id === DEFAULT_PRESET_ID) {
    return parseDefaultPresetConfig(raw)
  }
  return parseFullPresetConfig(raw)
}

/** 只接受包内相对路径：允许 `/` 与 `\\` 混合，但拒绝绝对路径、盘符、`.`/`..` 与空段。 */
export const normalizeEntryPath = (path: string): string | null => {
  const normalized = path.replace(/\\/g, '/')
  if (!normalized || normalized.startsWith('/') || /^[a-z]:/i.test(normalized)) {
    return null
  }
  const parts = normalized.split('/')
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    return null
  }
  return parts.join('/')
}

export type ParsedPreset = {
  config: PresetConfig
  /** 包图标（显式 icon 或默认位置 icon.<ext>）；都没有时 undefined */
  icon?: Blob
  /** 许可证全文（显式 license 或默认位置 LICENSE*）；都没有时 undefined */
  license?: string
  /** system_prompt_file（显式或默认 system_prompt.md / prompt.md）的文本；启用时覆盖 config.system_prompt */
  promptText?: string
}

/** 流式解压错误码 → preset 导入错误码（两个模块的错误码名字一致，直接把 code 透传） */
const zipReadError = (error: unknown): PresetError =>
  error instanceof ZipReadError
    ? new PresetError(error.code, error.detail)
    : new PresetError('notZip')

export const parsePresetZip = async (file: File): Promise<ParsedPreset> => {
  if (file.size > MAX_ZIP_BYTES) {
    throw new PresetError('tooLarge', `${file.size} bytes`)
  }
  let entries: Map<string, Uint8Array>
  try {
    // 逐条流式解压并在累计未压缩字节超限时立即中止，不先整包解压
    entries = readZipEntries(new Uint8Array(await file.arrayBuffer()), {
      maxEntries: MAX_ENTRIES,
      maxEntryBytes: MAX_ENTRY_BYTES,
      maxTotalBytes: MAX_TOTAL_BYTES,
    })
  } catch (error) {
    throw zipReadError(error)
  }

  // 目录条目已由 readZipEntries 跳过，这里只对文件做路径校验
  if (entries.size === 0) {
    throw new PresetError('noConfig')
  }
  const paths = new Map<string, Uint8Array>()
  for (const [name, bytes] of entries) {
    const normalized = normalizeEntryPath(name)
    if (!normalized) {
      throw new PresetError('badPath', name)
    }
    paths.set(normalized, bytes)
  }

  // 大小写不敏感索引：小写归一化路径 → 真实条目名（读取一律用真实条目名，zip 内容字节不变）
  const lowerPaths = new Map<string, string>()
  for (const name of paths.keys()) {
    const key = name.toLowerCase()
    if (!lowerPaths.has(key)) {
      lowerPaths.set(key, name)
    }
  }

  /** 按候选路径（大小写不敏感）找第一个命中的真实条目名 */
  const findEntry = (candidates: readonly string[]): string | undefined => {
    for (const candidate of candidates) {
      const actual = lowerPaths.get(candidate.toLowerCase())
      if (actual) {
        return actual
      }
    }
    return undefined
  }

  /** 显式路径：文件必须存在，否则报 missingFile（显式路径错误不回退默认位置） */
  const requireEntry = (file: string): string => {
    const path = normalizeEntryPath(file)
    const actual = path ? lowerPaths.get(path.toLowerCase()) : undefined
    if (!actual) {
      throw new PresetError('missingFile', file)
    }
    return actual
  }

  // 清单必须位于根目录：小写索引键不带 `/` 即根目录条目，子目录里的同名文件不算
  const configPath = lowerPaths.get(CONFIG_FILE)
  if (!configPath) {
    throw new PresetError('noConfig')
  }
  const config = parsePresetConfigForImport(
    new TextDecoder().decode(paths.get(configPath) as Uint8Array)
  )

  // TS 的 Uint8Array<ArrayBufferLike> 与 BlobPart 不兼容，这里复制一份有独立 ArrayBuffer 的副本
  const bytesOf = (name: string): Uint8Array<ArrayBuffer> => {
    const source = paths.get(name) as Uint8Array
    const copy = new Uint8Array(source.byteLength)
    copy.set(source)
    return copy
  }

  /** 读取 icon：显式 icon 严格（缺失报 missingFile）；没写时按默认 icon.<ext> 查找 */
  let icon: Blob | undefined
  if (config.icon) {
    const path = requireEntry(config.icon.file)
    const ext = extensionOf(path)
    if (!ICON_EXT.has(ext)) {
      throw new PresetError('badFileType', config.icon.file)
    }
    icon = new Blob([bytesOf(path)], { type: ICON_MIME[ext] })
    config.icon = { file: path }
  } else {
    const path = findEntry(DEFAULT_ICON_PATHS)
    if (path) {
      const ext = extensionOf(path)
      icon = new Blob([bytesOf(path)], { type: ICON_MIME[ext] })
      config.icon = { file: path }
    }
  }

  /**
   * 读取 system prompt 文件：
   * - 显式 system_prompt_file 严格（缺失 / 类型不符 / 超限都报错）；
   * - 没写时：若也没有内联 system_prompt，按顺序尝试默认文件 system_prompt.md / prompt.md。
   */
  let promptText: string | undefined
  if (config.system_prompt_file) {
    const path = requireEntry(config.system_prompt_file)
    if (!PROMPT_EXT.has(extensionOf(path))) {
      throw new PresetError('badFileType', config.system_prompt_file)
    }
    const bytes = paths.get(path) as Uint8Array
    if (bytes.length > MAX_PROMPT_BYTES) {
      throw new PresetError('tooLarge', config.system_prompt_file)
    }
    promptText = new TextDecoder().decode(bytes)
    config.system_prompt_file = path
  } else if (!config.system_prompt) {
    const path = findEntry(DEFAULT_PROMPT_PATHS)
    if (path) {
      const bytes = paths.get(path) as Uint8Array
      if (bytes.length > MAX_PROMPT_BYTES) {
        throw new PresetError('tooLarge', path)
      }
      promptText = new TextDecoder().decode(bytes)
      config.system_prompt_file = path
    }
  }

  /** 读取 license：显式 license 严格；没写时按默认位置 LICENSE / LICENSE.txt / LICENSE.md 查找 */
  let license: string | undefined
  const licensePath = config.license
    ? requireEntry(config.license.file)
    : findEntry(DEFAULT_LICENSE_PATHS)
  if (licensePath) {
    const path = licensePath
    const bytes = paths.get(path) as Uint8Array
    if (bytes.length > MAX_LICENSE_BYTES) {
      throw new PresetError('tooLarge', path)
    }
    license = new TextDecoder().decode(bytes)
    config.license = { file: path }
  }

  // 版权声明可以由包内完整 LICENSE 文件承担；两者都没有才拒绝导入
  if (!license && !(config.copyright ?? '').trim()) {
    throw new PresetError('missingCopyright', 'copyright')
  }

  // 解析结果里的 file 已补齐（显式值或默认位置），下游 / IndexedDB 不需要再做默认路径查找
  return { config, icon, license, promptText }
}
