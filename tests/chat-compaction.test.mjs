// Automatic context compaction (src/services/chat/compaction.ts): token estimation,
// plan selection (threshold / keep recent / cut on user), summary request building,
// summary collection and failure fallback.
import assert from 'node:assert/strict'
import { test } from 'node:test'

globalThis.__API_ORIGIN__ = 'https://api.deepseek.com'

const compaction = await import('../.test-build/services/chat/compaction.js')
const { DEFAULT_PRESET_COMPACTION } = await import('../.test-build/services/preset/types.js')

const {
  BLOCK_OVERHEAD_TOKENS,
  CHARS_PER_TOKEN,
  COMPACTED_SUMMARY_TAG,
  COMPACTION_PREAMBLE,
  DEFAULT_COMPACTION_PROMPT,
  MESSAGE_OVERHEAD_TOKENS,
  buildCompactedSummaryText,
  buildSummarizationRequest,
  collectSummary,
  estimateHistoryTokens,
  estimateMessageTokens,
  estimateSummaryTokens,
  estimateTextTokens,
  isValidCompaction,
  planCompaction,
  runCompaction,
} = compaction

const user = (id, content, extra = {}) => ({
  id,
  role: 'user',
  content,
  files: [],
  createdAt: 1,
  ...extra,
})

const assistant = (id, text, extra = {}) => ({
  id,
  role: 'assistant',
  blocks: text === undefined ? [] : [{ type: 'text', text }],
  createdAt: 1,
  ...extra,
})

const config = (overrides = {}) => ({ ...DEFAULT_PRESET_COMPACTION, ...overrides })

/* ============================ 估算 ============================ */

test('常量与摘要包装格式', () => {
  assert.equal(CHARS_PER_TOKEN, 4)
  assert.equal(MESSAGE_OVERHEAD_TOKENS, 4)
  assert.equal(BLOCK_OVERHEAD_TOKENS, 4)
  assert.equal(COMPACTED_SUMMARY_TAG, 'compacted-summary')
  assert.ok(DEFAULT_COMPACTION_PROMPT.includes('## Primary Request and Intent'))
  assert.ok(COMPACTION_PREAMBLE.includes('automatically generated checkpoint'))

  const text = buildCompactedSummaryText('  summary body  ')
  assert.equal(
    text,
    `${COMPACTION_PREAMBLE}\n\n<compacted-summary>\nsummary body\n</compacted-summary>`
  )
})

test('estimateTextTokens：空串 0，其它按 chars/4 + 固定开销向上取整', () => {
  assert.equal(estimateTextTokens(''), 0)
  assert.equal(
    estimateTextTokens('abcd'),
    Math.ceil(4 / CHARS_PER_TOKEN) + MESSAGE_OVERHEAD_TOKENS + BLOCK_OVERHEAD_TOKENS
  )
  assert.equal(estimateTextTokens('abcde'), Math.ceil(5 / CHARS_PER_TOKEN) + 8)
})

test('estimateMessageTokens：user 计入正文与附件名，assistant 只计入会回传的块', () => {
  assert.equal(estimateMessageTokens(user('u1', 'abcd')), 1 + 4 + 4)
  // 附件名算一个文本块
  const withFiles = user('u2', 'abcd', { files: [{ name: 'a.png' }, { name: 'b.txt' }] })
  assert.equal(estimateMessageTokens(withFiles), Math.ceil((4 + 5 + 5) / CHARS_PER_TOKEN) + 4 + 12)

  // 思考 / 搜索结果不回传，不计入
  const assistantMessage = assistant('a1', 'abcd', {
    blocks: [
      { type: 'text', text: 'abcd' },
      { type: 'thinking', text: 'x'.repeat(400) },
      { type: 'web_search_tool_result', content: 'x'.repeat(400) },
    ],
  })
  assert.equal(estimateMessageTokens(assistantMessage), 1 + 4 + 4)

  // read_link 的服务端工具调用与结果计入
  const withTools = assistant('a2', undefined, {
    blocks: [
      { type: 'server_tool_use', kind: 'read_link', input: { url: 'u' } },
      { type: 'web_fetch_tool_result', kind: 'read_link', signature: 's', content: { ok: 1 } },
    ],
  })
  const expectedChars = JSON.stringify({ url: 'u' }).length + 's'.length + JSON.stringify({ ok: 1 }).length
  assert.equal(
    estimateMessageTokens(withTools),
    Math.ceil(expectedChars / CHARS_PER_TOKEN) + MESSAGE_OVERHEAD_TOKENS + 3 * BLOCK_OVERHEAD_TOKENS
  )
})

test('estimateHistoryTokens / estimateSummaryTokens：latestReminder 只在内容变化时插入一次', () => {
  const history = [
    user('u1', 'abcd'),
    assistant('a1', 'abcd', { latestReminder: 'reminder-text' }),
    assistant('a2', 'abcd', { latestReminder: 'reminder-text' }),
  ]
  const base = estimateMessageTokens(history[0]) + estimateMessageTokens(history[1]) + estimateMessageTokens(history[2])
  assert.equal(estimateHistoryTokens(history), base + estimateTextTokens('reminder-text'))

  const changed = [
    assistant('a1', 'x', { latestReminder: 'one' }),
    assistant('a2', 'x', { latestReminder: 'two' }),
  ]
  assert.equal(
    estimateHistoryTokens(changed),
    estimateMessageTokens(changed[0]) + estimateTextTokens('one') + estimateMessageTokens(changed[1]) + estimateTextTokens('two')
  )
  assert.equal(estimateSummaryTokens('abcd'), estimateTextTokens(buildCompactedSummaryText('abcd')))
})

/* ============================ isValidCompaction ============================ */

test('isValidCompaction：覆盖范围必须是当前历史的前缀', () => {
  const history = [user('u1', 'a'), assistant('a1', 'b'), user('u2', 'c')]
  assert.equal(isValidCompaction(history, undefined), false)
  assert.equal(isValidCompaction(history, { summary: 's', coveredMessageIds: [], tokens: 0, at: 0 }), false)
  assert.equal(
    isValidCompaction(history, { summary: 's', coveredMessageIds: ['u1', 'a1'], tokens: 0, at: 0 }),
    true
  )
  assert.equal(
    isValidCompaction(history, { summary: 's', coveredMessageIds: ['u1', 'wrong'], tokens: 0, at: 0 }),
    false
  )
  assert.equal(
    isValidCompaction(history, { summary: 's', coveredMessageIds: ['u1', 'a1', 'u2', 'extra'], tokens: 0, at: 0 }),
    false
  )
  assert.equal(isValidCompaction([], { summary: 's', coveredMessageIds: ['u1'], tokens: 0, at: 0 }), false)
})

/* ============================ planCompaction ============================ */

test('planCompaction：禁用 / 低于阈值 / 消息不够都跳过', () => {
  const history = [user('u1', 'x'.repeat(1000)), assistant('a1', 'y'.repeat(1000))]
  assert.deepEqual(planCompaction({ history, compaction: config({ enabled: false }) }), {
    kind: 'skip',
    reason: 'disabled',
  })
  assert.deepEqual(
    planCompaction({ history, compaction: config({ trigger_tokens: 1_000_000, keep_recent_messages: 1 }) }),
    { kind: 'skip', reason: 'below-threshold' }
  )
  assert.deepEqual(
    planCompaction({ history, compaction: config({ trigger_tokens: 1, keep_recent_messages: 10 }) }),
    { kind: 'skip', reason: 'not-enough-messages' }
  )
})

test('planCompaction：保留最近 N 条，切口回退到 user 上（不拆开一问一答）', () => {
  const history = [
    user('u1', 'x'.repeat(400)),
    assistant('a1', 'y'.repeat(400)),
    user('u2', 'z'.repeat(400)),
    assistant('a2', 'w'.repeat(400)),
    user('u3', 'v'.repeat(400)),
  ]
  const plan = planCompaction({ history, compaction: config({ trigger_tokens: 1, keep_recent_messages: 2 }) })
  assert.equal(plan.kind, 'compact')
  // 保留最近 2 条会从 a1 之后切；切口不是 user → 回退到 u2
  assert.deepEqual(
    plan.compacted.map((message) => message.id),
    ['u1', 'a1']
  )
  assert.deepEqual(plan.coveredMessageIds, ['u1', 'a1'])
  assert.equal(plan.previousSummary, undefined)
  assert.equal(plan.shadowedTokens, estimateHistoryTokens(history.slice(0, 2)))
})

test('planCompaction：keep_recent_messages=0 压缩全部历史', () => {
  const history = [user('u1', 'x'.repeat(100)), assistant('a1', 'y'.repeat(100))]
  const plan = planCompaction({ history, compaction: config({ trigger_tokens: 1, keep_recent_messages: 0 }) })
  assert.equal(plan.kind, 'compact')
  assert.deepEqual(plan.compacted.map((message) => message.id), ['u1', 'a1'])
})

test('planCompaction：历史以 assistant 开头且无法回退到 user 时放弃压缩', () => {
  const history = [assistant('a1', 'x'.repeat(100)), assistant('a2', 'y'.repeat(100))]
  assert.deepEqual(
    planCompaction({ history, compaction: config({ trigger_tokens: 1, keep_recent_messages: 1 }) }),
    { kind: 'skip', reason: 'nothing-to-compact' }
  )
})

test('planCompaction：有效上一轮摘要被并入本次压缩范围与 token 计量', () => {
  const history = [
    user('u1', 'x'.repeat(100)),
    assistant('a1', 'y'.repeat(100)),
    user('u2', 'x'.repeat(100)),
    assistant('a2', 'y'.repeat(100)),
    user('u3', 'x'.repeat(100)),
    assistant('a3', 'y'.repeat(100)),
  ]
  const previous = {
    summary: 'previous summary',
    coveredMessageIds: ['u1', 'a1'],
    tokens: 10,
    at: 1,
  }
  const plan = planCompaction({
    history,
    previous,
    compaction: config({ trigger_tokens: 1, keep_recent_messages: 2 }),
  })
  assert.equal(plan.kind, 'compact')
  // 已覆盖的前缀不再重复压缩，本轮从 u2 开始
  assert.deepEqual(plan.compacted.map((message) => message.id), ['u2', 'a2'])
  assert.deepEqual(plan.coveredMessageIds, ['u1', 'a1', 'u2', 'a2'])
  assert.equal(plan.previousSummary, 'previous summary')
  assert.equal(
    plan.shadowedTokens,
    estimateHistoryTokens(history.slice(2, 4)) + estimateSummaryTokens('previous summary')
  )
})

test('planCompaction：上一轮摘要与当前分支前缀不符时忽略它', () => {
  const history = [
    user('u1', 'x'.repeat(100)),
    assistant('a1', 'y'.repeat(100)),
    user('u2', 'z'.repeat(100)),
  ]
  const stale = { summary: 'old', coveredMessageIds: ['other'], tokens: 1, at: 1 }
  const plan = planCompaction({
    history,
    previous: stale,
    compaction: config({ trigger_tokens: 1, keep_recent_messages: 1 }),
  })
  assert.equal(plan.kind, 'compact')
  assert.deepEqual(plan.coveredMessageIds, ['u1', 'a1'])
  assert.equal(plan.previousSummary, undefined)
})

/* ============================ 摘要请求 / 收集 ============================ */

test('buildSummarizationRequest：默认提示词、上一轮摘要与纯文本 transcript', () => {
  const request = buildSummarizationRequest({
    model: 'deepseek-flash',
    compacted: [user('u1', 'hello'), assistant('a1', 'world'), assistant('a2', undefined)],
    compaction: config(),
  })
  assert.equal(request.model, 'deepseek-flash')
  assert.equal('system' in request, false)
  assert.deepEqual(request.thinking, { type: 'disabled' })
  assert.equal(request.messages.length, 1)
  assert.equal(request.messages[0].role, 'user')
  const content = request.messages[0].content
  assert.ok(content.includes(DEFAULT_COMPACTION_PROMPT))
  assert.ok(content.includes('USER:\nhello'))
  assert.ok(content.includes('ASSISTANT:\nworld'))
  assert.ok(content.includes('ASSISTANT:\n(empty)'))
  // 默认提示词正文里提到过 compacted-summary 标签，但这里只是纯文本，不含上一轮摘要包装
  assert.equal(content.includes(COMPACTION_PREAMBLE), false)

  const withSystem = buildSummarizationRequest({
    model: 'm',
    system: 'sys',
    compacted: [user('u1', 'hello')],
    previousSummary: 'prior',
    compaction: config({ prompt: '  Custom prompt  ' }),
  })
  assert.equal(withSystem.system, 'sys')
  const withPrevious = withSystem.messages[0].content
  assert.ok(withPrevious.startsWith('PRIOR CHECKPOINT'))
  assert.ok(withPrevious.includes('<compacted-summary>\nprior\n</compacted-summary>'))
  assert.ok(withPrevious.includes('Custom prompt'))
  assert.equal(withPrevious.includes(DEFAULT_COMPACTION_PROMPT), false)
})

test('collectSummary：只累加文本 delta；空文本或被 max_tokens 截断都算失败', async () => {
  const stream = async function* () {
    yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' sum ' } }
    yield { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'ignored' } }
    yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'mary ' } }
    yield { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null } }
  }
  const summary = await collectSummary({}, stream, new AbortController().signal)
  assert.equal(summary, 'sum mary')

  const truncatedStream = async function* () {
    yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } }
    yield { type: 'message_delta', delta: { stop_reason: 'max_tokens', stop_sequence: null } }
  }
  await assert.rejects(
    collectSummary({}, truncatedStream, new AbortController().signal),
    /truncated at the token cap/
  )

  const emptyStream = async function* () {
    yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '   ' } }
  }
  await assert.rejects(collectSummary({}, emptyStream, new AbortController().signal), /no text/)
})

/* ============================ runCompaction ============================ */

const bigHistory = () => [
  user('u1', 'x'.repeat(400)),
  assistant('a1', 'y'.repeat(400)),
  user('u2', 'z'.repeat(400)),
  assistant('a2', 'w'.repeat(400)),
]

const textStream = (text) =>
  async function* () {
    yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }
    yield { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null } }
  }

test('runCompaction：禁用 / 已达阈值外等情况返回未压缩原因', async () => {
  const disabled = await runCompaction({
    sessionId: 's-disabled',
    history: bigHistory(),
    compaction: config({ enabled: false }),
    model: 'm',
    signal: new AbortController().signal,
    stream: textStream('summary'),
  })
  assert.deepEqual(disabled, { compacted: false, stalePrevious: false, reason: 'disabled' })

  const short = await runCompaction({
    sessionId: 's-below',
    history: [user('u1', 'hi')],
    compaction: config({ trigger_tokens: 1_000_000 }),
    model: 'm',
    signal: new AbortController().signal,
    stream: textStream('summary'),
  })
  assert.equal(short.reason, 'below-threshold')
  assert.equal(short.compacted, false)
})

test('runCompaction：信号已中止时不发摘要请求', async () => {
  const controller = new AbortController()
  controller.abort()
  let called = false
  const stream = async function* () {
    called = true
    yield { type: 'message_stop' }
  }
  const result = await runCompaction({
    sessionId: 's-aborted',
    history: bigHistory(),
    compaction: config({ trigger_tokens: 1, keep_recent_messages: 2 }),
    model: 'm',
    signal: controller.signal,
    stream,
  })
  assert.equal(result.reason, 'aborted')
  assert.equal(called, false)
})

test('runCompaction：成功生成摘要，返回覆盖范围 / tokens / 时间', async () => {
  const result = await runCompaction({
    sessionId: 's-ok',
    history: bigHistory(),
    compaction: config({ trigger_tokens: 1, keep_recent_messages: 2 }),
    model: 'm',
    signal: new AbortController().signal,
    stream: textStream('  the summary  '),
  })
  assert.equal(result.compacted, true)
  assert.equal(result.stalePrevious, false)
  assert.equal(result.compaction.summary, 'the summary')
  assert.deepEqual(result.compaction.coveredMessageIds, ['u1', 'a1'])
  assert.ok(result.compaction.tokens > 0)
  assert.equal(typeof result.compaction.at, 'number')
})

test('runCompaction：摘要失败不抛错，返回 failed 并保留仍有效的上一轮压缩', async () => {
  const previous = { summary: 'old', coveredMessageIds: ['u1', 'a1'], tokens: 1, at: 1 }
  const failing = async function* () {
    throw new Error('provider down')
  }
  const originalWarn = console.warn
  const warnings = []
  console.warn = (message) => warnings.push(message)
  try {
    const result = await runCompaction({
      sessionId: 's-fail',
      history: [...bigHistory(), user('u3', 'v'.repeat(400)), assistant('a3', 'w'.repeat(400))],
      previous,
      compaction: config({ trigger_tokens: 1, keep_recent_messages: 2 }),
      model: 'm',
      signal: new AbortController().signal,
      stream: failing,
    })
    assert.equal(result.compacted, false)
    assert.equal(result.reason, 'failed')
    assert.equal(result.error.message, 'provider down')
    assert.equal(result.compaction, previous)
    assert.equal(warnings.length, 1)
  } finally {
    console.warn = originalWarn
  }
})

test('runCompaction：摘要期间中止 → aborted；旧压缩与分支不符时标记 stalePrevious', async () => {
  const controller = new AbortController()
  const stream = async function* () {
    controller.abort()
    throw new Error('aborted by user')
  }
  const aborted = await runCompaction({
    sessionId: 's-abort-during',
    history: bigHistory(),
    compaction: config({ trigger_tokens: 1, keep_recent_messages: 2 }),
    model: 'm',
    signal: controller.signal,
    stream,
  })
  assert.equal(aborted.reason, 'aborted')
  assert.equal(aborted.compacted, false)

  const stale = await runCompaction({
    sessionId: 's-stale',
    history: bigHistory(),
    previous: { summary: 'old', coveredMessageIds: ['nope'], tokens: 1, at: 1 },
    compaction: config({ trigger_tokens: 1_000_000 }),
    model: 'm',
    signal: new AbortController().signal,
    stream: textStream('unused'),
  })
  assert.equal(stale.stalePrevious, true)
  assert.equal(stale.compaction, undefined)
})

test('runCompaction：同一会话同时只压一次（并发第二个返回 busy）', async () => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const slowStream = async function* () {
    yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } }
    await gate
    yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' done' } }
    yield { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null } }
  }
  const input = {
    sessionId: 's-busy',
    history: bigHistory(),
    compaction: config({ trigger_tokens: 1, keep_recent_messages: 2 }),
    model: 'm',
    signal: new AbortController().signal,
  }
  const first = runCompaction({ ...input, stream: slowStream })
  const second = await runCompaction({ ...input, stream: textStream('should not run') })
  assert.equal(second.reason, 'busy')
  assert.equal(second.compacted, false)
  release()
  const firstResult = await first
  assert.equal(firstResult.compacted, true)

  // 释放后同一会话可以再次压缩
  const after = await runCompaction({ ...input, stream: textStream('again') })
  assert.equal(after.compacted, true)
})
