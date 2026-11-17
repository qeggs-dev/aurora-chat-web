/**
 * 自动上下文压缩（compaction）：参考 DSH 的 compaction-basic 实现规格，按预设
 * `compaction` 配置在每次请求前把「更早的历史」替换成一条 user 摘要消息。
 *
 * 与 DSH 的对应关系：
 * - 触发按 **token 压力估算**（chars / 4 + 每条固定开销），不是按消息条数；
 * - 保留最近 keep_recent_messages 条不动（切口落在 user 上，不拆开一问一答），
 *   更早的消息从第一条 user 起压成一条摘要；
 * - 已有上一轮摘要时，把它一起送进摘要请求合并，避免摘要套摘要无限增长；
 * - 摘要消息用 `<compacted-summary>` 包装，作为历史里的第一条 user 消息注入（见 reply.ts）；
 * - 原消息不删除，只不再进入请求；覆盖范围与摘要写在 Session.compaction 上随会话持久化；
 * - 摘要请求失败只告警并用原历史继续，不阻塞回复；同一会话同时只压一次。
 *
 * 本模块不依赖 React / zustand / 浏览器存储，协议调用由调用方以 stream 注入（复用 streamChat）。
 */
import type { ChatModel, MessageParam, MessageStreamEvent } from '../api/types.js'
import { DEFAULT_PRESET_COMPACTION, type PresetCompaction } from '../preset/types.js'
import type { Message, SessionCompaction } from './types.js'

/** 摘要文本的包装标签（规格固定，不随预设变化） */
export const COMPACTED_SUMMARY_TAG = 'compacted-summary'

/** 摘要消息前的固定说明（规格原文 CHECKPOINT_PREAMBLE） */
export const COMPACTION_PREAMBLE =
  'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.'

/** 缺省摘要提示词：规格里的八段结构化模板（预设 compaction.prompt 非空时整体覆盖） */
export const DEFAULT_COMPACTION_PROMPT = `You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.

Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write "(none)" for an empty section — never drop a section.

## Primary Request and Intent
- [the user's original and evolving goals; quote verbatim where the exact wording matters]

## Key Technical Concepts
- [technologies, frameworks, patterns, and conventions in play]

## Files and Code
- [exact path: why it matters, key changes or snippets]

## Errors and Fixes
- [error: how it was resolved, plus any related user feedback]

## Pending Jobs
- [explicitly requested work not yet completed]

## Current Work
- [precisely what was in progress at this checkpoint]

## Next Step
- [the single next action, directly in line with the most recent request, or "(none)"]

## Critical Context
- [decisions and their rationale, constraints, user preferences, open questions, data needed to continue]

Rules:
- Write concise English engineering prose. Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.
- Capture user feedback and explicit instructions faithfully, especially corrections.
- Do NOT mention this summarization request or that the context was compacted.
- Output only the checkpoint text: do not call any tool or take any other action.
- If the conversation already contains a <compacted-summary> block, it is a PRIOR checkpoint. Do not copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into a single consolidated summary under the same structure.`

/** 估算口径：4 个字符约等于 1 token（DSH token-meter 的启发式；CJK / JSON 会低估） */
export const CHARS_PER_TOKEN = 4
/** 每条消息的固定开销（role 与结构） */
export const MESSAGE_OVERHEAD_TOKENS = 4
/** 每个内容块的固定开销 */
export const BLOCK_OVERHEAD_TOKENS = 4

/**
 * 摘要请求：只带模型、system 与一条 user 消息。
 * 刻意不带 DeepSeek 扩展字段（safety_check / tools）——摘要不进入扩展模式，
 * providers 路径也不会因此打「已跳过 DeepSeek 私有字段」的降级告警。
 */
export type SummaryRequest = {
  model: ChatModel
  system: string
  messages: MessageParam[]
  thinking: { type: 'enabled' | 'disabled' }
}

/** 摘要请求的流式入口：由调用方注入（store 复用 streamChat，不新增协议实现） */
export type SummaryStream = (
  request: SummaryRequest,
  signal: AbortSignal
) => AsyncIterable<MessageStreamEvent>

/** 摘要消息在请求里的完整正文 */
export const buildCompactedSummaryText = (summary: string): string =>
  `${COMPACTION_PREAMBLE}\n\n<${COMPACTED_SUMMARY_TAG}>\n${summary.trim()}\n</${COMPACTED_SUMMARY_TAG}>`

/** 一段文本的估算 token：字符数 / 4 + 固定开销 */
export const estimateTextTokens = (text: string): number =>
  text
    ? Math.ceil(text.length / CHARS_PER_TOKEN) + MESSAGE_OVERHEAD_TOKENS + BLOCK_OVERHEAD_TOKENS
    : 0

/**
 * 一条消息里真正会回传到请求中的文本片段：
 * - user：正文与附件名（附件以 file_id 引用，正文只有文件名级别的开销）；
 * - assistant：正文与 read_link 工具块；历史思考、搜索 / 打开网页结果不回传，因此不计入。
 */
const requestTexts = (message: Message): string[] => {
  if (message.role === 'user') {
    return [message.content, ...message.files.map((file) => file.name)]
  }
  const texts: string[] = []
  for (const block of message.blocks) {
    if (block.type === 'text') {
      if (block.text) {
        texts.push(block.text)
      }
    } else if (block.type === 'server_tool_use' && block.kind === 'read_link') {
      texts.push(JSON.stringify(block.input))
    } else if (block.type === 'web_fetch_tool_result' && block.kind === 'read_link') {
      texts.push(block.signature ?? '', JSON.stringify(block.content))
    }
  }
  return texts
}

/** 单条消息的估算 token：chars / 4 + 每条固定开销 + 每块固定开销 */
export const estimateMessageTokens = (message: Message): number => {
  const texts = requestTexts(message)
  const chars = texts.reduce((total, text) => total + text.length, 0)
  return (
    Math.ceil(chars / CHARS_PER_TOKEN) +
    MESSAGE_OVERHEAD_TOKENS +
    texts.length * BLOCK_OVERHEAD_TOKENS
  )
}

/**
 * 历史消息的估算 token；latest_reminder 只在内容变化时作为一条消息插入，
 * 与 reply.ts 的 toRequestMessages 口径一致。
 */
export const estimateHistoryTokens = (history: Message[]): number => {
  let total = 0
  let previousReminder: string | undefined
  for (const message of history) {
    total += estimateMessageTokens(message)
    if (
      message.role === 'assistant' &&
      message.latestReminder &&
      message.latestReminder !== previousReminder
    ) {
      total += estimateTextTokens(message.latestReminder)
      previousReminder = message.latestReminder
    }
  }
  return total
}

/** 摘要消息注入请求后的估算 token */
export const estimateSummaryTokens = (summary: string): number =>
  estimateTextTokens(buildCompactedSummaryText(summary))

export type CompactionSkipReason =
  | 'disabled'
  | 'below-threshold'
  | 'not-enough-messages'
  | 'nothing-to-compact'
  | 'busy'
  | 'failed'
  | 'aborted'

export type CompactionPlan =
  | { kind: 'skip'; reason: CompactionSkipReason }
  | {
      kind: 'compact'
      /** 送进摘要请求的更早消息（已排除上一轮摘要覆盖的部分） */
      compacted: Message[]
      /** 新一轮覆盖的消息 id：上一轮已覆盖的前缀 + 本次压缩的连续区间 */
      coveredMessageIds: string[]
      /** 上一轮摘要原文，存在时要并入新摘要 */
      previousSummary?: string
      /** 被替换原文加上一轮摘要的估算 token */
      shadowedTokens: number
    }

/**
 * 上一轮压缩是否仍适用于当前分支历史：覆盖范围必须仍是消息列表的前缀。
 * 切换版本、编辑旧提问后前缀会变化，旧摘要不能再注入（否则会描述另一条分支）。
 */
export const isValidCompaction = (
  history: Message[],
  previous: SessionCompaction | undefined
): previous is SessionCompaction => {
  if (!previous || previous.coveredMessageIds.length === 0) {
    return false
  }
  return (
    previous.coveredMessageIds.length <= history.length &&
    previous.coveredMessageIds.every((id, index) => history[index]?.id === id)
  )
}

const configuredKeepRecent = (compaction: PresetCompaction): number => {
  const value = Math.floor(compaction.keep_recent_messages)
  return Math.max(
    0,
    Number.isFinite(value) ? value : DEFAULT_PRESET_COMPACTION.keep_recent_messages
  )
}

const configuredTriggerTokens = (compaction: PresetCompaction): number => {
  const value = Math.floor(compaction.trigger_tokens)
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_PRESET_COMPACTION.trigger_tokens
}

/**
 * 按规格判断是否压缩并选段：
 * 1. 上一轮摘要若仍有效，先把它从「历史条数」里排除，只计量实际还会发送的消息；
 * 2. 有效历史 token 估算 ≥ trigger_tokens 且有效消息条数 > keep_recent_messages 才触发；
 * 3. 保留最近 keep_recent_messages 条，切口回退到 user 上（不拆一问一答）；
 * 4. 压缩区间 = 有效历史的前缀，从第一条 user 开始。
 */
export const planCompaction = (input: {
  history: Message[]
  previous?: SessionCompaction
  compaction: PresetCompaction
}): CompactionPlan => {
  const { history, previous, compaction } = input
  if (!compaction.enabled) {
    return { kind: 'skip', reason: 'disabled' }
  }
  const previousValid = isValidCompaction(history, previous)
  const covered = new Set(previousValid ? previous.coveredMessageIds : [])
  const effective = history.filter((message) => !covered.has(message.id))
  const keepRecent = configuredKeepRecent(compaction)
  const effectiveTokens =
    (previousValid ? estimateSummaryTokens(previous.summary) : 0) + estimateHistoryTokens(effective)
  if (effectiveTokens < configuredTriggerTokens(compaction)) {
    return { kind: 'skip', reason: 'below-threshold' }
  }
  if (effective.length <= keepRecent) {
    return { kind: 'skip', reason: 'not-enough-messages' }
  }
  // 从尾部留出 keep_recent_messages 条；切口若不是 user 就往前退，把整轮问答都留下。
  let keepFrom = effective.length - Math.min(keepRecent, effective.length)
  while (keepFrom > 0 && keepFrom < effective.length && effective[keepFrom].role !== 'user') {
    keepFrom--
  }
  if (keepFrom <= 0) {
    return { kind: 'skip', reason: 'nothing-to-compact' }
  }
  const compacted = effective.slice(0, keepFrom)
  const shadowedTokens =
    estimateHistoryTokens(compacted) + (previousValid ? estimateSummaryTokens(previous.summary) : 0)
  return {
    kind: 'compact',
    compacted,
    coveredMessageIds: [
      ...(previousValid ? previous.coveredMessageIds : []),
      ...compacted.map((message) => message.id),
    ],
    ...(previousValid ? { previousSummary: previous.summary } : {}),
    shadowedTokens,
  }
}

/** 把待压缩消息渲染成纯文本对话（摘要模型的输入） */
const buildTranscript = (messages: Message[]): string =>
  messages
    .map((message) => {
      const texts = requestTexts(message).filter((text) => text.trim())
      const body = texts.length > 0 ? texts.join('\n') : '(empty)'
      return `${message.role === 'user' ? 'USER' : 'ASSISTANT'}:\n${body}`
    })
    .join('\n\n')

export type SummarizationInput = {
  model: ChatModel
  system: string
  compacted: Message[]
  previousSummary?: string
  compaction: PresetCompaction
}

/**
 * 构造摘要请求：被压消息的纯文本记录 + 上一轮摘要（若有）+ 最终指令。
 * 提示词优先用预设 compaction.prompt，缺省用规格的八段模板。
 * 只有一条 user 消息：三种协议都不会因角色不交替被拒绝，也不新增协议代码。
 */
export const buildSummarizationRequest = (input: SummarizationInput): SummaryRequest => {
  const instruction = input.compaction.prompt?.trim() || DEFAULT_COMPACTION_PROMPT
  const parts: string[] = []
  if (input.previousSummary) {
    parts.push(
      `PRIOR CHECKPOINT (already compacted; merge it into the new summary instead of copying it verbatim):\n<${COMPACTED_SUMMARY_TAG}>\n${input.previousSummary}\n</${COMPACTED_SUMMARY_TAG}>`
    )
  }
  parts.push(`CONVERSATION TO COMPACT:\n\n${buildTranscript(input.compacted)}`)
  parts.push(instruction)
  return {
    model: input.model,
    system: input.system,
    messages: [{ role: 'user', content: parts.join('\n\n') }],
    // 摘要不需要思考。
    thinking: { type: 'disabled' },
  }
}

/**
 * 消费摘要流，只接受文本；输出为空或被 max_tokens 截断都算失败（不落不完整摘要）。
 * 非流式语义：这里把流式事件收完再返回完整文本。
 */
export const collectSummary = async (
  request: SummaryRequest,
  stream: SummaryStream,
  signal: AbortSignal
): Promise<string> => {
  let text = ''
  let truncated = false
  for await (const event of stream(request, signal)) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      text += event.delta.text
    } else if (event.type === 'message_delta' && event.delta.stop_reason === 'max_tokens') {
      truncated = true
    }
  }
  if (truncated) {
    throw new Error('compaction summary was truncated at the token cap')
  }
  const summary = text.trim()
  if (!summary) {
    throw new Error('compaction summary produced no text')
  }
  return summary
}

export type CompactionInput = {
  sessionId: string
  /** 当前分支的历史消息（不含本轮提问） */
  history: Message[]
  /** 会话里已持久化的上一轮压缩 */
  previous?: SessionCompaction
  compaction: PresetCompaction
  model: ChatModel
  system: string
  signal: AbortSignal
  stream: SummaryStream
}

export type CompactionOutcome = {
  /** 本次请求应注入的压缩元数据；未压缩或摘要失败时是仍有效的上一轮压缩 */
  compaction?: SessionCompaction
  /** 是否新生成了摘要（调用方需要写回会话并持久化） */
  compacted: boolean
  /** 会话里的旧压缩元数据已与当前分支不符，需要清除 */
  stalePrevious: boolean
  /** 未生成摘要的原因 */
  reason?: CompactionSkipReason
  error?: unknown
}

/** 进行中的压缩：同一会话同时只允许一次，结束后释放，失败后允许下次重试。 */
const activeCompactions = new Set<string>()

/**
 * 请求前执行一次自动压缩。绝不向调用方抛错：
 * 未达阈值 / 条数不够 / 并发 / 摘要失败都返回未压缩的结果，由调用方继续用原历史发请求。
 */
export const runCompaction = async (input: CompactionInput): Promise<CompactionOutcome> => {
  const previous = isValidCompaction(input.history, input.previous) ? input.previous : undefined
  const keep: Pick<CompactionOutcome, 'compaction' | 'stalePrevious'> = {
    ...(previous ? { compaction: previous } : {}),
    stalePrevious: input.previous !== undefined && previous === undefined,
  }
  if (activeCompactions.has(input.sessionId)) {
    return { ...keep, compacted: false, reason: 'busy' }
  }
  if (input.signal.aborted) {
    return { ...keep, compacted: false, reason: 'aborted' }
  }
  const plan = planCompaction({
    history: input.history,
    previous,
    compaction: input.compaction,
  })
  if (plan.kind === 'skip') {
    return { ...keep, compacted: false, reason: plan.reason }
  }
  activeCompactions.add(input.sessionId)
  try {
    const summary = await collectSummary(
      buildSummarizationRequest({
        model: input.model,
        system: input.system,
        compacted: plan.compacted,
        ...(plan.previousSummary ? { previousSummary: plan.previousSummary } : {}),
        compaction: input.compaction,
      }),
      input.stream,
      input.signal
    )
    return {
      compaction: {
        summary,
        coveredMessageIds: plan.coveredMessageIds,
        tokens: plan.shadowedTokens,
        at: Date.now(),
      },
      compacted: true,
      stalePrevious: false,
    }
  } catch (error) {
    if (input.signal.aborted) {
      return { ...keep, compacted: false, reason: 'aborted', error }
    }
    // 摘要失败不阻塞回复：只告警一条，本次用原历史继续、不再重试。
    // oxlint-disable-next-line no-console
    console.warn('[compaction] 自动压缩摘要生成失败，继续使用原历史', error)
    return { ...keep, compacted: false, reason: 'failed', error }
  } finally {
    activeCompactions.delete(input.sessionId)
  }
}
