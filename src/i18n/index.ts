import { useMemo } from 'react'
import { useSettings } from '../services/settings.js'
import { useLocaleStore } from '../services/locale/store.js'
import { zh } from './zh.js'
import {
  lookupMessage,
  type LocalePackResolver,
  type LocaleMessages,
  type LocalePackSource,
} from './messages.js'

export type TranslationKey = keyof typeof zh
export type TranslationParams = Record<string, string | number>
export type TranslationMessage = { key: TranslationKey; params?: TranslationParams }
/** 带文字链接的提示：link 跟在正文后，在新窗口打开；type 为 error 时前面带错误图标 */
export type LinkedMessage = TranslationMessage & {
  type?: 'error'
  link?: { key: TranslationKey; href: string }
}

export const isTranslationKey = (key: unknown): key is TranslationKey =>
  typeof key === 'string' && Object.hasOwn(zh, key)

const interpolate = (template: string, params?: TranslationParams): string =>
  template.replace(/\{(\w+)\}/g, (placeholder, name: string) => {
    const value = params?.[name]
    return typeof value === 'string' || typeof value === 'number' ? String(value) : placeholder
  })

export type Translate = (key: TranslationKey, params?: TranslationParams) => string

/**
 * 按「当前自定义语言 messages → 内置当前语言 → 内置英文兜底」生成查表函数。
 * packs 传入 IndexedDB 里已加载的语言包（启动时加载），切换语言 / 导入删除后自动重算。
 */
export const createTranslate = (
  locale: string,
  packs: readonly LocalePackSource[] = []
): Translate => {
  const resolve: LocalePackResolver = (id) => packs.find((pack) => pack.id === id)
  return (key, params) => interpolate(lookupMessage(key, locale, resolve), params)
}

/** 组件订阅语言变化（内置语言或语言包列表变化都会重新渲染）；普通函数在调用时读取当前语言。 */
export const useTranslate = (): Translate => {
  const locale = useSettings((state) => state.locale)
  const packs = useLocaleStore((state) => state.packs)
  return useMemo(() => createTranslate(locale, packs), [locale, packs])
}

export const translate = (key: TranslationKey, params?: TranslationParams): string =>
  createTranslate(useSettings.getState().locale, useLocaleStore.getState().packs)(key, params)

export type { LocaleMessages, LocalePackSource }
