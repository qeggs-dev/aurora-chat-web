/**
 * 语言包（schema 1）的格式校验与序列化（纯函数，便于单测）。
 *
 * JSON 格式：
 * {
 *   "schema": 1, "id": "...", "name": "...", "description": "...",
 *   "author": "...", "version": "1.0.0", "license": "<完整 LICENSE 文本>",
 *   "locale": "zh-CN", "messages": { "<i18n key>": "文案" }
 * }
 *
 * 规则：
 * - id 必填、1–64 位 [a-z0-9._-]，内置 zh / en 保留；
 * - name / description / author / version / license / locale 全部必填（trim 后非空）；
 * - license 是完整许可文本（≤200 KB），不联网、不运行时读文件；
 * - messages 必须是 string → string：不认识的 key 忽略并统计，缺失的 key 运行时回退内置语言。
 */
import {
  BUILTIN_LOCALE_METADATA,
  RESERVED_LOCALE_IDS,
} from '../../i18n/builtinPacks.js'
import {
  buildFullMessageTable,
  builtinLocaleOf,
  isBuiltinLocale,
  translationKeys,
  type LocaleMessages,
  type LocalePackSource,
} from '../../i18n/messages.js'

export const LOCALE_PACK_SCHEMA = 1

/** id 规则：1–64 位 [a-z0-9._-]（与需求一致，不额外要求首字符） */
export const LOCALE_ID_PATTERN = /^[a-z0-9._-]{1,64}$/

/** 整个语言文件上限：正常语言包（全部 key）约 50 KB，1 MB 足够且能挡住超大文件 */
export const MAX_LOCALE_PACK_BYTES = 1024 * 1024
/** LICENSE 文本上限（需求示例值） */
export const MAX_LOCALE_LICENSE_BYTES = 200 * 1024

export type LocalePackErrorCode =
  | 'tooLarge'
  | 'badJson'
  | 'badSchema'
  | 'badId'
  | 'reservedId'
  | 'missingField'
  | 'badMessages'

export class LocalePackError extends Error {
  constructor(
    public code: LocalePackErrorCode,
    /** 出错字段 / key / 原始细节（UI 作为 detail 展示） */
    public detail?: string
  ) {
    super(detail ?? code)
    this.name = 'LocalePackError'
  }
}

/** 解析后的语言包（不含导入时间；IndexedDB 记录在此之上加 importedAt） */
export type LocalePack = {
  schema: 1
  id: string
  name: string
  description: string
  author: string
  version: string
  license: string
  locale: string
  messages: LocaleMessages
}

export type ParsedLocalePack = {
  pack: LocalePack
  /** 被采纳的已知 key 数 */
  importedKeys: number
  /** messages 里不属于内置 key 的条目数（忽略） */
  skippedKeys: number
  /** 内置 key 中未提供、运行时回退的数量 */
  missingKeys: number
}

const REQUIRED_TEXT_FIELDS = ['name', 'description', 'author', 'version'] as const
type RequiredTextField = (typeof REQUIRED_TEXT_FIELDS)[number]

const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const readText = (raw: Record<string, unknown>, field: RequiredTextField): string => {
  const value = raw[field]
  if (typeof value !== 'string' || !value.trim()) {
    throw new LocalePackError('missingField', field)
  }
  return value.trim()
}

const readRequiredString = (raw: Record<string, unknown>, field: string): string => {
  const value = raw[field]
  if (typeof value !== 'string' || !value.trim()) {
    throw new LocalePackError('missingField', field)
  }
  return value.trim()
}

/** 内置语言保留 id 判断（不区分大小写：`ZH` 与 `zh` 同样保留） */
export const isReservedLocaleId = (id: string): boolean =>
  RESERVED_LOCALE_IDS.includes(id.toLowerCase())

/**
 * 校验并归一化一份语言包文本。
 * 抛 LocalePackError（稳定 code + detail 字段名），调用方据此显示中英文案。
 */
export const parseLocalePackText = (text: string): ParsedLocalePack => {
  if (utf8Bytes(text) > MAX_LOCALE_PACK_BYTES) {
    throw new LocalePackError('tooLarge', `${utf8Bytes(text)} bytes`)
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new LocalePackError('badJson')
  }
  if (!isPlainObject(raw)) {
    throw new LocalePackError('badSchema', 'root')
  }
  if (raw.schema !== LOCALE_PACK_SCHEMA) {
    throw new LocalePackError('badSchema', 'schema')
  }
  const id = raw.id
  if (typeof id !== 'string' || !LOCALE_ID_PATTERN.test(id)) {
    throw new LocalePackError('badId', typeof id === 'string' ? id : 'id')
  }
  if (isReservedLocaleId(id)) {
    throw new LocalePackError('reservedId', id)
  }
  const version = readText(raw, 'version')
  const name = readText(raw, 'name')
  const description = readText(raw, 'description')
  const author = readText(raw, 'author')
  const locale = readRequiredString(raw, 'locale')
  if (locale.length > 35) {
    throw new LocalePackError('missingField', 'locale')
  }
  const license = raw.license
  if (typeof license !== 'string' || !license.trim()) {
    throw new LocalePackError('missingField', 'license')
  }
  if (utf8Bytes(license) > MAX_LOCALE_LICENSE_BYTES) {
    throw new LocalePackError('tooLarge', 'license')
  }
  if (!isPlainObject(raw.messages)) {
    throw new LocalePackError('badMessages', 'messages')
  }
  const messages: LocaleMessages = {}
  let skippedKeys = 0
  for (const [key, value] of Object.entries(raw.messages)) {
    if (typeof value !== 'string') {
      throw new LocalePackError('badMessages', key)
    }
    if (!translationKeys.includes(key)) {
      // 不认识的 key（可能是旧版 / 未来的 key）：忽略并统计，不阻断导入
      skippedKeys += 1
      continue
    }
    messages[key] = value
  }
  return {
    pack: { schema: LOCALE_PACK_SCHEMA, id, name, description, author, version, license, locale, messages },
    importedKeys: Object.keys(messages).length,
    skippedKeys,
    missingKeys: translationKeys.length - Object.keys(messages).length,
  }
}

/**
 * 导出当前语言的完整 JSON：元信息取当前语言（内置用内置元信息 + MIT 文本，
 * 自定义用语言包自身元信息），messages 覆盖全部内置 key（缺失的按回退链补齐）。
 * 文件名为 `<id>-locale.json`。
 */
export const buildLocalePackExport = (
  locale: string,
  findPack: (id: string) => LocalePackSource | undefined
): { id: string; filename: string; json: string; pack: LocalePack } => {
  const customId = locale.startsWith('custom:') ? locale.slice('custom:'.length) : ''
  const custom = isBuiltinLocale(locale) ? undefined : findPack(customId)
  const builtin = isBuiltinLocale(locale) ? locale : builtinLocaleOf(custom?.locale ?? 'zh-CN')
  const metadata = BUILTIN_LOCALE_METADATA[builtin]
  const id = custom?.id ?? metadata.id
  const pack: LocalePack = {
    schema: LOCALE_PACK_SCHEMA,
    id,
    name: custom?.name ?? metadata.name,
    description: custom?.description ?? metadata.description,
    author: custom?.author ?? metadata.author,
    version: custom?.version ?? metadata.version,
    license: custom?.license ?? metadata.license,
    locale: custom?.locale ?? builtin,
    messages: buildFullMessageTable(locale, findPack),
  }
  return {
    id,
    filename: `${id}-locale.json`,
    json: `${JSON.stringify(pack, null, 2)}\n`,
    pack,
  }
}

/** 完整消息表（供测试 / 高级调用复用） */
export const localeMessagesForBase = (locale: string): LocaleMessages =>
  buildFullMessageTable(locale)
