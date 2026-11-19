import { isAbnormalStopReason } from '../api/types.js'
import { getVisibleMessages } from '../chat/branches.js'
import { canEditReply, getEditableReply } from '../chat/replyEdit.js'
import type { Message, Session } from '../chat/types.js'

/**
 * 自动朗读的纯逻辑：会话「生成中 → 空闲」时，朗读刚刚完成的那条回复。
 * 这里不依赖浏览器与 chat store，便于 node:test 直接单测；真实订阅在 autoReadRuntime.ts。
 */

/** streaming 快照：只关心哪些会话正在生成，值本身（AbortController）不参与判断 */
export type StreamingSnapshot = Record<string, unknown>

export type AutoReadSessionState = {
  activeId: string | null
  streaming: StreamingSnapshot
  sessionCache: Record<string, Session | undefined>
}

export type AutoReadDecision = { sessionId: string; messageId: string; text: string }

/**
 * 可自动朗读的回复正文。以下都不朗读：
 * 历史消息（调用方只在刚结束时触发）、被就地编辑的回复、错误 / 中断 / 不完整回复、
 * 安全拒绝与服务端模板提示、空正文、仍在流式中的回复。
 * 复用 replyEdit 的可编辑判断（拒绝、模板提示、空正文都不可编辑）。
 */
export const getAutoReadableText = (message: Message | undefined): string | null => {
  if (message?.role !== 'assistant' || message.edited) {
    return null
  }
  if (message.status !== 'done' || message.error || isAbnormalStopReason(message.stopReason)) {
    return null
  }
  if (!canEditReply(message, false)) {
    return null
  }
  const text = getEditableReply(message).trim()
  return text || null
}

/** 当前可见路径最后一条消息若是可朗读的助手回复，返回它的 id 与正文 */
export const findAutoReadableReply = (
  session: Session | undefined
): { messageId: string; text: string } | null => {
  if (!session) {
    return null
  }
  const last = getVisibleMessages(session).at(-1)
  if (!last || last.role !== 'assistant') {
    return null
  }
  const text = getAutoReadableText(last)
  return text ? { messageId: last.id, text } : null
}

/** 本次状态变化里「生成中 → 空闲」的会话 id */
export const getFinishedSessions = (
  previous: StreamingSnapshot,
  next: StreamingSnapshot
): string[] => Object.keys(previous).filter((id) => !Object.hasOwn(next, id))

export type AutoReadInput = {
  previousStreaming: StreamingSnapshot
  streaming: StreamingSnapshot
  activeId: string | null
  enabled: boolean
  session: Session | undefined
}

/**
 * 自动朗读状态机：开关开启、当前会话刚结束生成、且最后一条回复可朗读时给出一条朗读任务。
 * 历史消息不会触发（没有 true → false 的变化），非当前会话也不会触发。
 */
export const decideAutoRead = (input: AutoReadInput): AutoReadDecision | null => {
  if (!input.enabled || input.activeId === null) {
    return null
  }
  if (!getFinishedSessions(input.previousStreaming, input.streaming).includes(input.activeId)) {
    return null
  }
  const reply = findAutoReadableReply(input.session)
  return reply ? { sessionId: input.activeId, ...reply } : null
}

export type AutoReadStore = {
  getState: () => AutoReadSessionState
  subscribe: (
    listener: (state: AutoReadSessionState, previous: AutoReadSessionState) => void
  ) => () => void
}

export type AutoReadRuntime = {
  store: AutoReadStore
  isEnabled: () => boolean
  read: (decision: AutoReadDecision) => void
}

/** 在应用启动时订阅 streaming 变化；返回解除订阅的函数 */
export const bindAutoRead = (runtime: AutoReadRuntime): (() => void) =>
  runtime.store.subscribe((state, previous) => {
    const decision = decideAutoRead({
      previousStreaming: previous.streaming,
      streaming: state.streaming,
      activeId: state.activeId,
      enabled: runtime.isEnabled(),
      session: state.activeId === null ? undefined : state.sessionCache[state.activeId],
    })
    if (decision) {
      runtime.read(decision)
    }
  })
