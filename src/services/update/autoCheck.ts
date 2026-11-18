/**
 * 启动时自动检查更新：延迟 5s（不打断启动），只在有新版本时由 App 层弹 toast / 亮小红点。
 * 设置里关掉后不再自动请求；结果走 store 的 24h 缓存，所以频繁重启也只会消耗一次 API 配额。
 */

import { useSettings } from '../settings.js'
import { useUpdateStore } from './store.js'

export const AUTO_UPDATE_CHECK_DELAY_MS = 5000

/** 安排一次自动检查，返回取消函数（组件卸载 / 设置变化时清理） */
export const startAutoUpdateCheck = (
  delayMs: number = AUTO_UPDATE_CHECK_DELAY_MS
): (() => void) => {
  if (!useSettings.getState().autoCheckUpdates) {
    return () => {}
  }
  const timer = setTimeout(() => {
    if (!useSettings.getState().autoCheckUpdates) {
      return
    }
    if (useUpdateStore.getState().status !== 'idle') {
      return
    }
    void useUpdateStore.getState().check({ manual: false })
  }, delayMs)
  return () => clearTimeout(timer)
}
