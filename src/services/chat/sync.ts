/**
 * 多窗口一致性：会话用单调 revision 标出快照新旧，保存时拒绝旧快照覆盖新数据；
 * 保存成功的那一个窗口通过 BroadcastChannel 广播，其他窗口失效并重载对应缓存。
 *
 * 本模块只放可单测的纯判断与 Channel 包装，不依赖 store / IndexedDB。
 */

/** 聊天与会话数据共用的存储名（IndexedDB / BroadcastChannel 同名） */
export const CHAT_CHANNEL_NAME = 'chat-demo'

/** 会话保存成功后的广播消息 */
export type SessionChangeMessage = {
  type: 'session-changed'
  sessionId: string
  revision: number
}

/** 校验 BroadcastChannel 收到的任意数据，只有合法消息才进入 store */
export const isSessionChangeMessage = (value: unknown): value is SessionChangeMessage => {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const message = value as Record<string, unknown>
  return (
    message.type === 'session-changed' &&
    typeof message.sessionId === 'string' &&
    message.sessionId !== '' &&
    typeof message.revision === 'number' &&
    Number.isFinite(message.revision)
  )
}

/** 单调修订号：旧数据没有该字段时按 0 起算 */
export const nextRevision = (revision: number | undefined): number => (revision ?? 0) + 1

/**
 * 存储里的 revision 更高说明本窗口拿到的是旧快照（其他窗口已写入更新的数据），
 * 这次保存必须放弃，随后让内存重新加载。
 */
export const isStaleSave = (
  storedRevision: number | undefined,
  incomingRevision: number
): boolean => storedRevision !== undefined && storedRevision > incomingRevision

/** 远端 revision 比本地新才需要重载；相等视为同一次变更的重复通知 */
export const shouldApplyRemoteRevision = (
  remoteRevision: number,
  localRevision: number | undefined
): boolean => localRevision === undefined || remoteRevision > localRevision

export type ChatChannel = {
  post(message: SessionChangeMessage): void
  close(): void
}

/**
 * 创建 BroadcastChannel 包装。环境不支持（旧浏览器、SSR）时返回 null，
 * 调用方按单窗口处理，不影响保存与渲染。
 */
export const createChatChannel = (
  listener: (message: SessionChangeMessage) => void
): ChatChannel | null => {
  if (typeof BroadcastChannel === 'undefined') {
    return null
  }
  const channel = new BroadcastChannel(CHAT_CHANNEL_NAME)
  channel.onmessage = (event: MessageEvent<unknown>) => {
    if (isSessionChangeMessage(event.data)) {
      listener(event.data)
    }
  }
  return {
    post: (message) => {
      channel.postMessage(message)
    },
    close: () => {
      channel.close()
    },
  }
}
