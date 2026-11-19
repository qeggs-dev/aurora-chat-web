import { showToast } from '../../components/base/toastState.js'
import { useChatStore } from '../chat/store.js'
import { setAutoReadAloud, useSettings } from '../settings.js'
import { bindAutoRead } from './autoRead.js'
import {
  describeReadAloudError,
  isReadAloudAudioError,
  primeReadAloud,
  stopReadAloud,
  toggleReadAloud,
} from './readAloud.js'

/**
 * 自动朗读开关的唯一入口：打开时在用户手势里预热 AudioContext，关闭时立即停止当前朗读。
 * 顶栏喇叭按钮与设置 → 通用设置共用，保证两处行为一致。
 */
export const setAutoReadEnabled = (enabled: boolean) => {
  if (enabled) {
    primeReadAloud()
  }
  setAutoReadAloud(enabled)
}

const reportAutoReadError = (error: unknown) => {
  if (isReadAloudAudioError(error)) {
    // 浏览器拦截了自动播放：关闭开关并提示用户手动重开一次（重开是用户手势，可预热 context）
    setAutoReadAloud(false)
    showToast({ key: 'autoReadUnavailable', type: 'error' })
    return
  }
  showToast(describeReadAloudError(error))
}

/** 应用启动时订阅会话生成状态；返回解除订阅与清理的函数（供 useEffect 复用） */
export const bindAutoReadRuntime = () => {
  let enabled = useSettings.getState().autoReadAloud
  // 关闭开关（顶栏按钮或设置里的开关）时立即停止当前朗读
  const unsubscribeSettings = useSettings.subscribe((state) => {
    if (enabled && !state.autoReadAloud) {
      stopReadAloud()
    }
    enabled = state.autoReadAloud
  })
  const unsubscribe = bindAutoRead({
    store: useChatStore,
    isEnabled: () => useSettings.getState().autoReadAloud,
    read: ({ messageId, text }) => toggleReadAloud(messageId, text, reportAutoReadError),
  })
  return () => {
    unsubscribe()
    unsubscribeSettings()
  }
}
