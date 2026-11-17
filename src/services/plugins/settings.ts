/**
 * settings 服务插件（无依赖）：把 services/settings.ts 的公开 API 包成 Cordis 服务。
 *
 * Phase 1 只做转发：现有 React 组件继续直接 import services/settings.ts，
 * 行为与导出签名都不变；Phase 2 再把 UI 调用迁移到 `ctx.settings`。
 */
import type { Context } from 'cordis'
import {
  acceptDisclaimer,
  isChineseBrowser,
  setApiKey,
  setLocale,
  setLocation,
  setSearch,
  setSiderCollapsed,
  setThemePreference,
  setThinking,
  setTtsVoice,
  useSettings,
} from '../settings.js'
import type { AppServicePlugin } from './types.js'

/** 设置状态（settings.ts 未导出 Settings 类型，这里从 store 推导） */
export type SettingsState = ReturnType<typeof useSettings.getState>

export interface SettingsService {
  getState: typeof useSettings.getState
  subscribe: (listener: () => void) => () => void
  setApiKey: typeof setApiKey
  setLocale: typeof setLocale
  setLocation: typeof setLocation
  setThemePreference: typeof setThemePreference
  setTtsVoice: typeof setTtsVoice
  setThinking: typeof setThinking
  setSearch: typeof setSearch
  setSiderCollapsed: typeof setSiderCollapsed
  acceptDisclaimer: typeof acceptDisclaimer
  isChineseBrowser: typeof isChineseBrowser
  /** 容器生命周期钩子：容器卸载时调用 */
  dispose(): Promise<void>
}

export const settingsPlugin: AppServicePlugin<'settings'> = {
  name: 'settings',
  inject: [],
  apply(ctx: Context) {
    const service: SettingsService = {
      getState: useSettings.getState,
      subscribe: (listener) => useSettings.subscribe(listener),
      setApiKey,
      setLocale,
      setLocation,
      setThemePreference,
      setTtsVoice,
      setThinking,
      setSearch,
      setSiderCollapsed,
      acceptDisclaimer,
      isChineseBrowser,
      async dispose() {
        // 设置只有 localStorage 的同步读写，没有定时器或异步缓冲需要清理
      },
    }
    ctx.provide('settings', service)
    ctx.effect(() => () => service.dispose(), 'settings.dispose()')
  },
}
