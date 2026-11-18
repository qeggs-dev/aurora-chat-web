/**
 * 运行时环境快照：只用于提示词模板的 `{{env.*}}` 变量，不直接写进请求。
 *
 * 在渲染预设提示词模板时现算，不写进会话消息或历史；预设提示词为空时请求里没有 system，
 * 也不会追加任何运行环境元信息。缺失字段（拿不到版本、没有 matchMedia 等）优雅降级，绝不抛错。
 *
 * 注意：这里**不写本地时间**。提示词是请求前缀，写入时间会让同一环境下的前后请求前缀
 * 不再一致，KV cache 每轮都失效；需要展示时间的地方用会话消息，不要用提示词。
 */
import { useSettings } from '../settings.js'

export type RuntimePlatform = 'android' | 'ios' | 'desktop' | 'web'

/** 一次请求里的运行时环境快照：也用于系统提示词模板的 `{{env.*}}` 变量 */
export type RuntimeEnv = {
  platform: RuntimePlatform
  app: string
  /** 构建时写入的版本号；拿不到时省略（模板里 `{{env.version}}` 保留原样） */
  version?: string
  locale: string
  theme: 'light' | 'dark'
}

type CapacitorGlobal = {
  Capacitor?: { getPlatform?: () => string | undefined }
}

/** Capacitor 原生壳（Android / iOS）会把自己的平台告诉网页；读不到就返回 undefined */
const readCapacitorPlatform = (): string | undefined => {
  try {
    return (globalThis as CapacitorGlobal).Capacitor?.getPlatform?.()
  } catch {
    return undefined
  }
}

const readUserAgent = (): string => {
  try {
    return typeof navigator === 'undefined' ? '' : (navigator.userAgent ?? '')
  } catch {
    return ''
  }
}

/**
 * 运行平台：优先 Capacitor 原生层（android / ios），其次 UA 里的 Electron（desktop），
 * 其余按普通网页（web）。platform 必须运行时计算，不能写死。
 */
export const detectPlatform = (): RuntimePlatform => {
  const native = readCapacitorPlatform()
  if (native === 'android' || native === 'ios') {
    return native
  }
  return /Electron/i.test(readUserAgent()) ? 'desktop' : 'web'
}

/** 版本号来自构建时写入的 `<meta name="application-version">` */
const readAppVersion = (): string | undefined => {
  try {
    if (typeof document === 'undefined') {
      return undefined
    }
    const content = document
      .querySelector('meta[name="application-version"]')
      ?.getAttribute('content')
      ?.trim()
    return content ? content : undefined
  } catch {
    return undefined
  }
}

const readLocale = (): string => {
  try {
    return useSettings.getState().locale
  } catch {
    return 'zh-CN'
  }
}

/** 主题：显式偏好优先；跟随系统时用 matchMedia 解析成 light / dark */
const readTheme = (): 'light' | 'dark' => {
  try {
    const preference = useSettings.getState().themePreference
    if (preference === 'light' || preference === 'dark') {
      return preference
    }
  } catch {
    // 设置不可用时按系统主题
  }
  try {
    if (typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches) {
      return 'dark'
    }
  } catch {
    // 没有 matchMedia 的宿主按浅色处理
  }
  return 'light'
}

/**
 * 本地时间的 ISO 8601（保留 +08:00 这类时区偏移，而不是统一换算成 UTC）。
 * 保留给需要展示时间的地方使用；**不要写进 system 提示词**（会破坏 KV cache 前缀）。
 */
export const formatIsoWithOffset = (date = new Date()): string => {
  const pad = (value: number) => String(value).padStart(2, '0')
  const offsetMinutes = -date.getTimezoneOffset()
  const local = new Date(date.getTime() + offsetMinutes * 60_000)
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const absolute = Math.abs(offsetMinutes)
  return `${local.toISOString().slice(0, 19)}${sign}${pad(Math.floor(absolute / 60))}:${pad(
    absolute % 60
  )}`
}

/** 现算一次运行时环境快照（平台 / 应用名 / 版本 / 语言 / 主题，不含时间） */
export const readRuntimeEnv = (): RuntimeEnv => {
  const version = readAppVersion()
  return {
    platform: detectPlatform(),
    app: 'Aurora Chat',
    ...(version ? { version } : {}),
    locale: readLocale(),
    theme: readTheme(),
  }
}
