import { nextRevision } from './sync.js'
import type { AssistantMessage, Message, ReplyBlock, Session } from './types.js'

/**
 * 编辑助手回复的正文（不是另起分支）：
 * - 只替换「最后一个非文本块之后的连续文本块」——也就是界面上的回答正文，
 *   思考、工具调用与结果块原样保留；
 * - 消息 id / parentId / selectedChildId 与其它消息都不变；
 * - 会话 revision 自增，走与用户消息编辑相同的持久化与多窗口广播。
 */

export type ReplyEditFailureReason = 'empty' | 'notEditable'

export type ReplyEditResult =
  | {
      ok: true
      /** 编辑后的会话快照；内容没变时就是传入的会话（changed=false） */
      session: Session
      message: AssistantMessage
      changed: boolean
    }
  | { ok: false; reason: ReplyEditFailureReason }

/** 回答正文的起点：尾部连续文本块的第一个索引；没有回答正文时等于 blocks.length */
const answerStart = (blocks: ReplyBlock[]): number => {
  let index = blocks.length
  while (index > 0 && blocks[index - 1].type === 'text') {
    index -= 1
  }
  return index
}

/** 当前可编辑的回答正文（未注入 [citation:N] 角标的原始块文本） */
export const getEditableReply = (message: AssistantMessage): string =>
  message.blocks
    .slice(answerStart(message.blocks))
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('')

/**
 * 只有已结束（done / stopped）、未被安全拒绝、没有服务端模板提示、且有回答正文的助手消息可编辑。
 * streaming 为 true（本会话正在生成）时一律不可编辑。
 */
export const canEditReply = (
  message: Message | undefined,
  streaming: boolean
): message is AssistantMessage => {
  if (streaming || message?.role !== 'assistant') {
    return false
  }
  if (message.status !== 'done' && message.status !== 'stopped') {
    return false
  }
  if (message.stopReason === 'refusal') {
    return false
  }
  if (message.blocks.some((block) => block.type === 'text' && block.isTemplate)) {
    return false
  }
  return answerStart(message.blocks) < message.blocks.length
}

/** 只改写回答正文块，保留消息的其它字段与所有非文本块。 */
export const editReplyContent = (
  message: AssistantMessage,
  content: string
): AssistantMessage | null => {
  const text = content.trim()
  if (!text || !canEditReply(message, false)) {
    return null
  }
  const start = answerStart(message.blocks)
  const blocks: ReplyBlock[] = [...message.blocks.slice(0, start), { type: 'text', text }]
  return { ...message, blocks, edited: true }
}

/**
 * 会话级的编辑：校验、替换正文、标记 edited、revision 自增。
 * 内容与当前正文一致时不产生新快照（changed=false），避免无意义的 revision 增长。
 */
export const editReplyInSession = (
  session: Session,
  messageId: string,
  content: string,
  now = Date.now()
): ReplyEditResult => {
  const message = session.messages.find((item) => item.id === messageId)
  if (!message || message.role !== 'assistant' || !canEditReply(message, false)) {
    return { ok: false, reason: 'notEditable' }
  }
  const text = content.trim()
  if (!text) {
    return { ok: false, reason: 'empty' }
  }
  if (getEditableReply(message) === text && message.edited) {
    return { ok: true, session, message, changed: false }
  }
  const edited = editReplyContent(message, text)
  if (!edited) {
    return { ok: false, reason: 'notEditable' }
  }
  return {
    ok: true,
    message: edited,
    changed: true,
    session: {
      ...session,
      updatedAt: now,
      revision: nextRevision(session.revision),
      messages: session.messages.map((item) => (item.id === messageId ? edited : item)),
    },
  }
}
