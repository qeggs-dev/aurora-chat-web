import type {
  AssistantBlockParam,
  MessageParam,
  MessageStreamEvent,
  OutputBlockStart,
  TextBlockParam,
  ToolResultBlockParam,
} from '../api/types.js'
import { isAbnormalStopReason } from '../api/types.js'
import { getActiveResolvedPreset, renderPromptTemplate } from '../preset/index.js'
import { hasRequestContent, toFileBlocks } from './fileBlocks.js'
import type {
  AssistantMessage,
  ClientToolUsePart,
  Message,
  ReplyBlock,
  ReplyStatus,
  SessionCompaction,
  UserMessage,
} from './types.js'
import { readRuntimeEnv } from './runtimeInfo.js'
import { buildCompactedSummaryText } from './compaction.js'

/** 应用自带的系统提示词：只作为默认预设编辑器的 placeholder / 说明展示，不再用于请求兜底 */
export const APP_SYSTEM_PROMPT = '该助手为DeepSeek，由深度求索公司创造。'

/**
 * 生效的系统提示词：预设里填写的提示词原文，与编辑器里逐字一致。
 *
 * - 预设没写或只有空白时返回 `undefined`：请求体里**不出现 system 字段**，
 *   不使用任何默认提示词、也不追加运行环境等元信息。
 * - 用户显式写了 `{{preset.*}}` / `{{env.*}}` 模板变量时渲染一次；没有变量时输出与原文完全相同
 *   （不做 trim，保留用户输入的首尾空白与换行）。
 */
export const buildSystemPrompt = (): string | undefined => {
  const resolved = getActiveResolvedPreset()
  const prompt = resolved?.system_prompt ?? ''
  if (!prompt.trim()) {
    return undefined
  }
  // 一次快照同时用于模板变量渲染，避免两次读取之间环境字段不一致
  return renderPromptTemplate(prompt, resolved, readRuntimeEnv())
}

/**
 * 文件按 Files API 的 file_id（附件的 serverId）引用：图片用 image 块，其余用 document 块。
 * 发送前 streamReply 会先补齐 serverId；占位 id 与仍为 null 的附件都不进入请求（见 fileBlocks.ts）。
 */

/** 工具参数流式 JSON 解析：未收完 / 非法时返回 undefined，由调用方保留原值 */
const parseToolInput = (inputJson: string | undefined): unknown => {
  if (inputJson === undefined || inputJson.trim() === '') {
    return undefined
  }
  try {
    return JSON.parse(inputJson)
  } catch {
    return undefined
  }
}

/** 结束流式中的工具块：把 inputJson 解析成完整 input；解析失败保留块开始的 input */
const settleToolBlock = (block: ClientToolUsePart, endedAt: number): ClientToolUsePart => {
  const input = parseToolInput(block.inputJson)
  return {
    ...block,
    ...(input === undefined ? {} : { input }),
    inputJson: undefined,
    endedAt: block.endedAt ?? endedAt,
  }
}

const toReplyBlock = (block: OutputBlockStart, now: number): ReplyBlock | null => {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text, citations: block.citations ?? [] }
    case 'thinking':
      return {
        type: 'thinking',
        thinking: block.thinking,
        signature: block.signature,
        startedAt: now,
      }
    case 'server_tool_use':
    case 'web_search_tool_result':
    case 'web_fetch_tool_result':
      return block
    case 'tool_use':
      // 客户端工具调用：块起点只有 id / name（input 由 input_json_delta 到达）
      return {
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: block.input ?? {},
        inputJson: '',
        startedAt: now,
      }
    default:
      return null
  }
}

const updateBlock = (
  reply: AssistantMessage,
  index: number,
  update: (block: ReplyBlock) => ReplyBlock
): AssistantMessage => {
  const block = reply.blocks[index]
  if (!block) {
    return reply
  }
  const blocks = [...reply.blocks]
  blocks[index] = update(block)
  return { ...reply, blocks }
}

/**
 * 把一个流式事件合并进回复：只追加可识别的内容块，用本次请求的临时索引映射处理增量。
 * 跳过的块不占位；续写直接追加到已有内容之后，message_delta 更新结束原因与累计用量。
 */
export const applyEvent = (
  reply: AssistantMessage,
  event: MessageStreamEvent,
  now: number,
  blockIndexes: Map<number, number>
): AssistantMessage => {
  const next: AssistantMessage =
    reply.status === 'streaming' ? reply : { ...reply, status: 'streaming' }
  switch (event.type) {
    case 'message_start':
      return { ...next, usage: event.message.usage ?? next.usage }
    case 'content_block_start': {
      blockIndexes.delete(event.index)
      const block = toReplyBlock(event.content_block, now)
      if (!block) {
        return next
      }
      blockIndexes.set(event.index, next.blocks.length)
      return {
        ...next,
        // 客户端工具调用块不能作为续写前缀（续写语义与工具往返互斥）
        ...(event.content_block.type === 'tool_use' ? { prefix: false } : {}),
        blocks: [...next.blocks, block],
      }
    }
    case 'content_block_delta': {
      const index = blockIndexes.get(event.index)
      if (index === undefined) {
        return next
      }
      const { delta } = event
      return updateBlock(next, index, (block) => {
        if (block.type === 'text' && delta.type === 'text_delta') {
          return { ...block, text: block.text + delta.text }
        }
        if (block.type === 'thinking' && delta.type === 'thinking_delta') {
          return { ...block, thinking: block.thinking + delta.thinking }
        }
        if (block.type === 'thinking' && delta.type === 'signature_delta') {
          return { ...block, signature: (block.signature ?? '') + delta.signature }
        }
        if (block.type === 'text' && delta.type === 'citations_delta') {
          return { ...block, citations: [...(block.citations ?? []), delta.citation] }
        }
        if (block.type === 'tool_use' && delta.type === 'input_json_delta') {
          return { ...block, inputJson: (block.inputJson ?? '') + delta.partial_json }
        }
        return block
      })
    }
    case 'content_block_stop': {
      const index = blockIndexes.get(event.index)
      if (index === undefined) {
        return next
      }
      blockIndexes.delete(event.index)
      return updateBlock(next, index, (block) => {
        if (
          block.type === 'thinking' &&
          block.startedAt !== undefined &&
          block.endedAt === undefined
        ) {
          return { ...block, endedAt: now }
        }
        if (block.type === 'tool_use') {
          return settleToolBlock(block, now)
        }
        return block
      })
    }
    case 'message_delta':
      return {
        ...next,
        stopReason: event.delta.stop_reason,
        stopDetails: event.delta.stop_details,
        usage: event.usage ?? next.usage,
      }
    default:
      return next
  }
}

/**
 * 回复结束：未结束的思考块以当前时间收尾。
 * 安全拒绝（stop_reason: refusal）时已下发的思考与正文不能撤回，按协议要求由客户端丢弃，只保留工具块。
 */
export const settleReply = (
  reply: AssistantMessage,
  status: Extract<ReplyStatus, 'done' | 'stopped' | 'error'>,
  now: number,
  error?: AssistantMessage['error']
): AssistantMessage => ({
  ...reply,
  status,
  error,
  blocks: reply.blocks.flatMap((block): ReplyBlock[] => {
    if (reply.stopReason === 'refusal' && (block.type === 'thinking' || block.type === 'text')) {
      return []
    }
    if (block.type === 'thinking' && block.startedAt !== undefined && block.endedAt === undefined) {
      return [{ ...block, endedAt: now }]
    }
    // 流被中断时工具块可能没收到 content_block_stop：这里补收尾，避免 inputJson 残留
    if (block.type === 'tool_use' && block.inputJson !== undefined) {
      return [settleToolBlock(block, now)]
    }
    return [block]
  }),
})

/** 回复里所有文本块拼起来，用于复制与判断是否有回答 */
export const getReplyText = (reply: AssistantMessage) =>
  reply.blocks.map((block) => (block.type === 'text' ? block.text : '')).join('')

/** 续写（prefill）只有 Anthropic 协议原生支持：Chat / Responses 直接禁用「继续」 */
const supportsPrefill = (): boolean => {
  const preset = getActiveResolvedPreset()
  return preset === null || preset.protocol === 'anthropic'
}

/**
 * 只有正常达到输出上限或被停止的回复可续写，报错回复不能续写。
 * 末条限制由调用方判断，拒绝和客户端工具调用不能续写。
 * 本轮含服务端工具调用或结果（含 READ_LINK 和孤立结果块）的回复不能续写。
 * 服务端模板提示不能作为续写前缀。
 * 当前预设协议不支持 prefill 时整个功能禁用（非 anthropic 的末尾 assistant 不是前缀语义）。
 */
export const canContinueReply = (reply: AssistantMessage): boolean => {
  if (
    !supportsPrefill() ||
    !reply.prefix ||
    reply.stopReason === 'refusal' ||
    reply.stopReason === 'tool_use' ||
    reply.blocks.some(
      (block) =>
        block.type === 'server_tool_use' ||
        block.type === 'web_search_tool_result' ||
        block.type === 'web_fetch_tool_result' ||
        block.type === 'tool_use' ||
        block.type === 'tool_result' ||
        (block.type === 'text' && block.isTemplate)
    )
  ) {
    return false
  }
  return (
    reply.status === 'stopped' || (reply.status === 'done' && reply.stopReason === 'max_tokens')
  )
}

/**
 * 有 tool_use 却没有对应 tool_result 的回复（工具循环被轮次上限或用户停止中断）不能作为上下文：
 * 否则下一轮请求里会出现未配对的 tool_use，Anthropic 等协议会直接拒绝。
 */
const hasUnpairedToolUse = (reply: AssistantMessage): boolean => {
  const results = new Set(
    reply.blocks.flatMap((block) => (block.type === 'tool_result' ? [block.toolUseId] : []))
  )
  return reply.blocks.some((block) => block.type === 'tool_use' && !results.has(block.id))
}

/**
 * 已结束或停止且有回答文本的回复才放进上下文；被安全拒绝的轮次不回传。
 * 异常结束（incomplete：流内错误 / 未知 incomplete 原因）的内容可能不完整，同样不回传。
 * 服务端模板提示不进入上下文。
 */
const isUsableReply = (message: Message): message is AssistantMessage =>
  message.role === 'assistant' &&
  (message.status === 'done' || message.status === 'stopped') &&
  message.stopReason !== 'refusal' &&
  !isAbnormalStopReason(message.stopReason) &&
  !message.blocks.some((block) => block.type === 'text' && block.isTemplate) &&
  !hasUnpairedToolUse(message) &&
  getReplyText(message) !== ''

/** 有文件时用内容块数组：先文件后文本，文件按 Files API 的 file_id 引用 */
const toUserParam = ({ content, files }: UserMessage): MessageParam => {
  const blocks = toFileBlocks(files)
  return blocks.length === 0
    ? { role: 'user', content }
    : {
        role: 'user',
        content: [...blocks, ...(content ? [{ type: 'text' as const, text: content }] : [])],
      }
}

/** assistant 回复在请求里的片段：assistant 消息，或紧随其后的 user(tool_result) 消息 */
type AssistantSegment =
  | { type: 'assistant'; content: AssistantBlockParam[] }
  | { type: 'tool_results'; content: ToolResultBlockParam[] }

/**
 * assistant 的内容块按历史与续写场景转换，并按协议顺序切成消息片段：
 * - 历史思考及其签名不回传；开启思考时续写只保留本轮非空白思考及其签名；
 * - 文本块去掉 citations（服务端忽略）。相邻文本直接拼接，被思考或工具隔开的文本用空行连接；
 *   省略历史思考后仍保留其前后正文的空行；
 * - 服务端工具调用和结果只保留 kind 为 read_link 的块，其他历史工具块不回传；
 * - 客户端工具调用（tool_use）回传；对应的 tool_result 必须放进独立的 user 消息，
 *   因此遇到 tool_result 时先结束当前 assistant 段，再累积结果——这样多轮工具往返保持
 *   assistant(tool_use) → user(tool_result) → assistant(…) 的交替顺序；
 * - 阅读链接结果原样回传，保留 signature：服务端解密后将页面拼回该轮提问末尾。
 */
const toAssistantSegments = (
  { blocks }: AssistantMessage,
  prefix: boolean,
  thinking: boolean
): AssistantSegment[] => {
  const segments: AssistantSegment[] = []
  let content: AssistantBlockParam[] = []
  let toolResults: ToolResultBlockParam[] = []
  /** 正在拼接的文本块；遇到任何非文本块（含不回传的思考块）就结束 */
  let text: TextBlockParam | null = null
  // 成功阅读的网页靠签名恢复正文；缺少有效签名时，调用与结果都不回传。
  const unsignedReadLinks = new Set(
    blocks.flatMap((block) =>
      block.type === 'web_fetch_tool_result' &&
      block.kind === 'read_link' &&
      block.content.type === 'web_fetch_result' &&
      !block.signature?.trim()
        ? [block.tool_use_id]
        : []
    )
  )
  const flushAssistant = (): void => {
    const filtered = content.filter((block) => block.type !== 'text' || block.text !== '')
    if (filtered.length > 0) {
      segments.push({ type: 'assistant', content: filtered })
    }
    content = []
    text = null
  }
  const flushToolResults = (): void => {
    if (toolResults.length > 0) {
      segments.push({ type: 'tool_results', content: toolResults })
      toolResults = []
    }
  }
  for (const block of blocks) {
    if (block.type === 'tool_result') {
      // 工具结果属于 user 消息：先收尾当前 assistant 段
      flushAssistant()
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.toolUseId,
        content: block.content,
        ...(block.isError ? { is_error: true } : {}),
      })
      continue
    }
    // 结果之后的块属于下一轮 assistant 消息
    flushToolResults()
    // 空思考不改变续写位置，也不应把两段正文隔开，导致后端额外插入空行。
    if (prefix && block.type === 'thinking' && !block.thinking.trim()) {
      continue
    }
    if (block.type === 'text') {
      if (text) {
        text.text += block.text
      } else {
        const previous = content.at(-1)
        text = {
          type: 'text',
          text: `${previous?.type === 'text' ? '\n\n' : ''}${block.text}`,
        }
        content.push(text)
      }
      continue
    }
    text = null
    if (prefix && thinking && block.type === 'thinking') {
      // 续写保留本轮思考，历史轮次的思考省略。
      const { type, thinking, signature } = block
      content.push({ type, thinking, signature: signature ?? '' })
    } else if (
      block.type === 'server_tool_use' &&
      block.kind === 'read_link' &&
      !unsignedReadLinks.has(block.id)
    ) {
      const { type, id, name, input, kind } = block
      content.push({ type, id, name, input, kind })
    } else if (
      block.type === 'web_fetch_tool_result' &&
      block.kind === 'read_link' &&
      !unsignedReadLinks.has(block.tool_use_id)
    ) {
      content.push(block)
    } else if (block.type === 'tool_use') {
      // 客户端工具调用：input 用解析后的完整对象回传
      content.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input })
    }
  }
  flushAssistant()
  flushToolResults()
  return segments
}

const toAssistantParam = (
  reply: AssistantMessage,
  prefix = false,
  thinking = false
): Extract<MessageParam, { role: 'assistant' }> => ({
  role: 'assistant',
  content: toAssistantSegments(reply, prefix, thinking).flatMap((segment) =>
    segment.type === 'assistant' ? segment.content : []
  ),
})

/** 历史 / 工具循环统一的 assistant 消息序列（含与 tool_use 配对的 user 工具结果消息） */
const toAssistantMessages = (
  reply: AssistantMessage,
  prefix = false,
  thinking = false
): MessageParam[] =>
  toAssistantSegments(reply, prefix, thinking).map((segment) =>
    segment.type === 'assistant'
      ? { role: 'assistant', content: segment.content }
      : { role: 'user', content: segment.content }
  )

/**
 * 工具循环续写：把本轮已完成的 assistant 工具调用与 tool_result 按协议顺序接在提问之后。
 * store 在一轮回复以 tool_use 结束、执行完工具后调用它拼下一轮请求。
 */
export const toToolContinuationMessages = (reply: AssistantMessage): MessageParam[] =>
  toAssistantMessages(reply)

/** 历史中会进入请求上下文的轮次：提问后紧跟可用回答的才保留 */
export const getContextRounds = (history: Message[]): [UserMessage, AssistantMessage][] => {
  const rounds: [UserMessage, AssistantMessage][] = []
  for (let i = 0; i + 1 < history.length; i++) {
    const [user, reply] = [history[i], history[i + 1]]
    if (user.role === 'user' && isUsableReply(reply)) {
      rounds.push([user, reply])
      i++
    }
  }
  return rounds
}

/** 自动压缩的摘要作为历史里的第一条 user 消息注入（规格：preamble + `<compacted-summary>`）。 */
const toCompactedSummaryParam = (compaction: SessionCompaction): MessageParam => ({
  role: 'user',
  content: buildCompactedSummaryText(compaction.summary),
})

/**
 * 把会话转成请求的 messages：只保留「提问 + 有回答的回复」成对的轮次，最后接上本轮提问。
 * 失败或没有回答的轮次不进上下文。续写时末尾再带上本轮 assistant。
 *
 * 自动压缩生效时（compaction 由 store 传入）：
 * - 摘要作为历史里的第一条 user 消息注入；
 * - coveredMessageIds 覆盖的原始消息不再发送（本地会话里仍保留，可回看）。
 */
export const toRequestMessages = (
  history: Message[],
  question: UserMessage,
  prefix?: AssistantMessage,
  thinking = prefix?.thinking ?? false,
  latestReminder?: string,
  compaction?: SessionCompaction
): MessageParam[] => {
  const messages: MessageParam[] = []
  const covered = new Set(compaction?.coveredMessageIds ?? [])
  if (compaction) {
    messages.push(toCompactedSummaryParam(compaction))
  }
  let previousReminder: string | undefined
  const appendReminder = (reminder: string | undefined) => {
    // 仅在当前分支首次出现或内容变化时插入快照；缺少快照的消息保持原有内容。
    if (reminder && reminder !== previousReminder) {
      messages.push({ role: 'latest_reminder', content: reminder })
      previousReminder = reminder
    }
  }
  for (const [user, reply] of getContextRounds(history)) {
    // 已被压缩覆盖的轮次不再发送，只由摘要代表。
    if (covered.has(user.id) || covered.has(reply.id)) {
      continue
    }
    // 历史提问没有文字、附件也都没有真实 file_id（占位 / 未补传 / 没有原件）时，提问为空，连同回答一起省略。
    if (!hasRequestContent(user.content, user.files)) {
      continue
    }
    appendReminder(reply.latestReminder)
    messages.push(toUserParam(user), ...toAssistantMessages(reply))
  }
  appendReminder(latestReminder)
  // 本轮提问同样可能只剩占位附件：跳过空的 user 消息，避免服务端收到空 content（400）
  if (hasRequestContent(question.content, question.files)) {
    messages.push(toUserParam(question))
  }
  if (prefix?.prefix) {
    const assistant = toAssistantParam(prefix, true, thinking)
    // 没有非空白正文或有效思考时直接重发原问题，避免服务端拒绝空 Prefill。
    if (
      assistant.content.some(
        (block) =>
          (block.type === 'text' && block.text.trim()) ||
          (block.type === 'thinking' && block.thinking.trim())
      )
    ) {
      messages.push(assistant)
    }
  }
  return messages
}

/** 思考用时（秒），至少 1 秒 */
export const getThinkingSeconds = (startedAt: number, endedAt: number) =>
  Math.max(1, Math.round((endedAt - startedAt) / 1000))
