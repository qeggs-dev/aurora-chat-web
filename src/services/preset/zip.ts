/** preset zip 与 api_configs.json 的解析与校验：路径、大小、扩展名与清单字段都在这里把关。 */
import { unzipSync } from 'fflate'
import {
  DEFAULT_PRESET_COMPACTION,
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
const MAX_ENTRIES = 100
const MAX_LICENSE_BYTES = 200 * 1024
const MAX_PROMPT_BYTES = 64 * 1024
const MAX_TEXT_FIELD = 400

/** 清单必须位于 zip 根目录 */
const CONFIG_FILE = 'api_configs.json'

const PROTOCOLS = new Set<PresetProtocol>(['openai', 'anthropic', 'responses'])
const ICON_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'svg'])
const PROMPT_EXT = new Set(['md', 'txt'])

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

const readParams = (raw: unknown): PresetParams => {
  if (raw === undefined || raw === null) {
    return { ...DEFAULT_PRESET_PARAMS, stop: [] }
  }
  if (!isRecord(raw)) {
    return badConfig('params must be an object')
  }
  return {
    temperature: readNumber(
      raw.temperature,
      'params.temperature',
      0,
      2,
      DEFAULT_PRESET_PARAMS.temperature
    ),
    top_p: readNumber(raw.top_p, 'params.top_p', 0, 1, DEFAULT_PRESET_PARAMS.top_p),
    max_tokens: readPositiveInteger(
      raw.max_tokens,
      'params.max_tokens',
      DEFAULT_PRESET_PARAMS.max_tokens
    ),
    stop: readStop(raw.stop),
    presence_penalty: readNumber(
      raw.presence_penalty,
      'params.presence_penalty',
      -2,
      2,
      DEFAULT_PRESET_PARAMS.presence_penalty
    ),
    frequency_penalty: readNumber(
      raw.frequency_penalty,
      'params.frequency_penalty',
      -2,
      2,
      DEFAULT_PRESET_PARAMS.frequency_penalty
    ),
    seed: readSeed(raw.seed),
    reasoning_effort: readReasoningEffort(raw.reasoning_effort),
  }
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

/** 解析并校验 preset 清单；zip 导入与手写 JSON 共用这一套规则。 */
export const parsePresetConfig = (text: string): PresetConfig => {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new PresetError('badConfig', 'api_configs.json is not valid JSON')
  }
  if (!isRecord(raw)) {
    return badConfig('api_configs.json must be an object')
  }
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
  return {
    schema: 1,
    id: raw.id,
    name,
    description: readOptionalText(raw.description, 'description'),
    author: readOptionalText(raw.author, 'author'),
    version: readOptionalText(raw.version, 'version'),
    protocol: raw.protocol as PresetProtocol,
    base_url: raw.base_url.trim().replace(/\/+$/, ''),
    model,
    params: readParams(raw.params),
    system_prompt: readSystemPrompt(raw.system_prompt),
    system_prompt_file: readOptionalText(raw.system_prompt_file, 'system_prompt_file'),
    compaction: readCompaction(raw.compaction),
    memory: readMemory(raw.memory),
    icon: readFileRef(raw.icon, 'icon'),
    license: readFileRef(raw.license, 'license'),
  }
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
  icon?: Blob
  license?: string
  /** system_prompt_file 的文本；启用时覆盖 config.system_prompt */
  promptText?: string
}

export const parsePresetZip = async (file: File): Promise<ParsedPreset> => {
  if (file.size > MAX_ZIP_BYTES) {
    throw new PresetError('tooLarge', `${file.size} bytes`)
  }
  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(new Uint8Array(await file.arrayBuffer()))
  } catch {
    throw new PresetError('notZip')
  }

  // 目录条目没有内容，跳过；只对文件做路径、数量与大小校验
  const names = Object.keys(entries).filter((name) => !name.endsWith('/') && !name.endsWith('\\'))
  if (names.length === 0) {
    throw new PresetError('noConfig')
  }
  if (names.length > MAX_ENTRIES) {
    throw new PresetError('tooManyFiles', String(names.length))
  }

  const paths = new Map<string, Uint8Array>()
  let total = 0
  for (const name of names) {
    const normalized = normalizeEntryPath(name)
    if (!normalized) {
      throw new PresetError('badPath', name)
    }
    total += entries[name].length
    if (total > MAX_TOTAL_BYTES) {
      throw new PresetError('tooLarge', 'uncompressed limit')
    }
    paths.set(normalized, entries[name])
  }

  // 清单必须位于根目录：子目录里的同名文件不算
  const configPath = [...paths.keys()].find(
    (name) => !name.includes('/') && name.toLowerCase() === CONFIG_FILE
  )
  if (!configPath) {
    throw new PresetError('noConfig')
  }
  const config = parsePresetConfig(new TextDecoder().decode(paths.get(configPath) as Uint8Array))

  // TS 的 Uint8Array<ArrayBufferLike> 与 BlobPart 不兼容，这里复制一份有独立 ArrayBuffer 的副本
  const bytesOf = (name: string): Uint8Array<ArrayBuffer> => {
    const source = paths.get(name) as Uint8Array
    const copy = new Uint8Array(source.byteLength)
    copy.set(source)
    return copy
  }

  let icon: Blob | undefined
  if (config.icon) {
    const path = normalizeEntryPath(config.icon.file)
    if (!path || !paths.has(path)) {
      throw new PresetError('missingFile', config.icon.file)
    }
    const ext = extensionOf(path)
    if (!ICON_EXT.has(ext)) {
      throw new PresetError('badFileType', config.icon.file)
    }
    icon = new Blob([bytesOf(path)], { type: ICON_MIME[ext] })
  }

  let promptText: string | undefined
  if (config.system_prompt_file) {
    const path = normalizeEntryPath(config.system_prompt_file)
    if (!path || !paths.has(path)) {
      throw new PresetError('missingFile', config.system_prompt_file)
    }
    if (!PROMPT_EXT.has(extensionOf(path))) {
      throw new PresetError('badFileType', config.system_prompt_file)
    }
    const bytes = paths.get(path) as Uint8Array
    if (bytes.length > MAX_PROMPT_BYTES) {
      throw new PresetError('tooLarge', config.system_prompt_file)
    }
    promptText = new TextDecoder().decode(bytes)
  }

  let license: string | undefined
  if (config.license) {
    const path = normalizeEntryPath(config.license.file)
    if (!path || !paths.has(path)) {
      throw new PresetError('missingFile', config.license.file)
    }
    const bytes = paths.get(path) as Uint8Array
    if (bytes.length > MAX_LICENSE_BYTES) {
      throw new PresetError('tooLarge', config.license.file)
    }
    license = new TextDecoder().decode(bytes)
  }

  return { config, icon, license, promptText }
}
