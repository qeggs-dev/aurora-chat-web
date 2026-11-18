import type { LinkedMessage } from '../i18n/index.js'

const listeners = new Set<(notice: LinkedMessage) => void>()

/**
 * 服务层需要 toast 的提示（如「预设不支持附件，不能只发附件」）。
 * 服务层不直接依赖 React / 组件，界面在启动时订阅并转成 toast。
 */
export const onChatNotice = (listener: (notice: LinkedMessage) => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export const notifyChat = (notice: LinkedMessage) => {
  for (const listener of listeners) {
    listener(notice)
  }
}
