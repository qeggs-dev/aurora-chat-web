/**
 * 文案查表的基础设施（不依赖 React / IndexedDB，便于单测与避免循环依赖）。
 *
 * 查表顺序（i18n/index.ts 的 t() / useTranslate 与语言包导入统计共用这一套）：
 * 当前自定义语言 messages → 内置当前语言 → 内置英文兜底。
 * - 「内置当前语言」：自定义语言包按其 `locale` 字段取内置 zh / en；内置语言就是自身。
 * - 任何一层都没有该 key 时返回 key 本身，保证界面不会出现 undefined。
 */
import { en } from './en.js'
import { zh } from './zh.js'

export type BuiltinLocale = 'zh-CN' | 'en-US'
export type LocaleMessages = Record<string, string>

/** 自定义语言包在运行时需要的最小结构（IndexedDB 记录比这里多） */
export type LocalePackSource = {
  id: string
  /** 导出语言文件用的元信息（IndexedDB 记录都有；缺省时导出给空串） */
  name?: string
  description?: string
  author?: string
  version?: string
  license?: string
  /** 语言包声明的基准语言（如 zh-CN） */
  locale: string
  messages: Readonly<LocaleMessages>
}

export const BUILTIN_LOCALES: readonly BuiltinLocale[] = ['zh-CN', 'en-US']

export const isBuiltinLocale = (locale: string): locale is BuiltinLocale =>
  locale === 'zh-CN' || locale === 'en-US'

/** 自定义语言在设置里存成 `custom:<id>`，与内置语言共用一个偏好字段 */
const CUSTOM_PREFIX = 'custom:'

export const isCustomLocale = (locale: string): locale is `custom:${string}` =>
  locale.startsWith(CUSTOM_PREFIX)

export const customLocalePreference = (id: string): `custom:${string}` => `${CUSTOM_PREFIX}${id}`

export const customLocaleId = (locale: string): string | null =>
  isCustomLocale(locale) ? locale.slice(CUSTOM_PREFIX.length) : null

/** 内置中英文两张完整表（也是语言文件的「全部 key」来源） */
export const builtinMessages = (locale: BuiltinLocale): LocaleMessages =>
  locale === 'en-US' ? en : zh

/** 全部内置 key（keyof zh）；导入语言包时不在其中的 key 会被忽略并计数 */
export const translationKeys: readonly string[] = Object.keys(zh)

export const hasTranslationKey = (key: string): boolean => Object.hasOwn(zh, key)

/**
 * 自定义语言包声明的基准语言：只有 en-US 用英文，其它（含无法识别的 locale）
 * 都回退到中文——应用只有 zh / en 两套内置语言。
 */
export const builtinLocaleOf = (locale: string): BuiltinLocale =>
  locale === 'en-US' ? 'en-US' : 'zh-CN'

export type LocalePackResolver = (id: string) => LocalePackSource | undefined

/**
 * 单条文案查表：custom → 内置当前语言 → 内置英文。
 * resolve 负责把 `custom:<id>` 解析成已加载的语言包；找不到时按内置偏好处理。
 */
export const lookupMessage = (
  key: string,
  locale: string,
  resolve: LocalePackResolver = () => undefined
): string => {
  const id = customLocaleId(locale)
  const pack = id === null ? undefined : resolve(id)
  const base = builtinMessages(
    pack ? builtinLocaleOf(pack.locale) : isBuiltinLocale(locale) ? locale : 'zh-CN'
  )
  const fromCustom = pack?.messages[key]
  if (typeof fromCustom === 'string') {
    return fromCustom
  }
  const fromBase = base[key]
  if (typeof fromBase === 'string') {
    return fromBase
  }
  const english: LocaleMessages = en
  return english[key] ?? key
}

/** 当前语言下全部 key 的完整文案表：导出语言文件时用它保证「全部 key」都有值 */
export const buildFullMessageTable = (
  locale: string,
  resolve: LocalePackResolver = () => undefined
): LocaleMessages => {
  const table: LocaleMessages = {}
  for (const key of translationKeys) {
    table[key] = lookupMessage(key, locale, resolve)
  }
  return table
}
