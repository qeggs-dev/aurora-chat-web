/**
 * 内置语言包的元信息（用于导出语言文件，也是「导入示例」的模板）。
 *
 * id 刻意不用 `zh` / `en`：这两个 id 被内置语言保留，自定义语言包不能占用。
 * 内置语言导出成 `aurora-zh-locale.json` / `aurora-en-locale.json` 后可以直接再导入，
 * 作为一份「基于当前语言改文案」的自定义语言包，这是「用户可自制语言」的主要路径。
 */
import { MIT_LICENSE_TEXT } from './license.js'
import type { BuiltinLocale } from './messages.js'

/** 内置语言保留的 id：自定义语言包不能使用（避免覆盖 / 混淆内置语言） */
export const RESERVED_LOCALE_IDS: readonly string[] = ['zh', 'en']

export type BuiltinLocaleMetadata = {
  id: string
  name: string
  description: string
  author: string
  version: string
  license: string
  locale: BuiltinLocale
}

export const BUILTIN_LOCALE_METADATA: Record<BuiltinLocale, BuiltinLocaleMetadata> = {
  'zh-CN': {
    id: 'aurora-zh',
    name: '简体中文',
    description: 'Aurora Chat 内置简体中文语言包，可作为自制语言的起点。',
    author: 'Qeggs (https://github.com/qeggs-dev)',
    version: '1.0.0',
    license: MIT_LICENSE_TEXT,
    locale: 'zh-CN',
  },
  'en-US': {
    id: 'aurora-en',
    name: 'English',
    description: 'Aurora Chat built-in English locale, usable as a starting point for your own.',
    author: 'Qeggs (https://github.com/qeggs-dev)',
    version: '1.0.0',
    license: MIT_LICENSE_TEXT,
    locale: 'en-US',
  },
}
