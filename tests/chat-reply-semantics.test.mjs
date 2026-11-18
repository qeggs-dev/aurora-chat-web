// Reply end-of-stream semantics: interrupted streams must surface a clear message instead of a
// blank answer, and abnormal finish reasons must map to a recognisable "incomplete" state that is
// never replayed as usable context (src/services/chat/describe.ts, reply.ts, api providers/client).
import assert from 'node:assert/strict'
import { test } from 'node:test'

globalThis.__API_ORIGIN__ = 'https://api.deepseek.com'

const i18n = await import('../.test-build/i18n/index.js')
const apiTypes = await import('../.test-build/services/api/types.js')
const responses = await import('../.test-build/services/api/providers/responses.js')
const client = await import('../.test-build/services/api/client.js')
const describe = await import('../.test-build/services/chat/describe.js')
const reply = await import('../.test-build/services/chat/reply.js')

const assistant = (overrides = {}) => ({
  id: 'a1',
  role: 'assistant',
  createdAt: 2,
  model: null,
  prefix: true,
  status: 'done',
  blocks: [],
  ...overrides,
})

const user = (overrides = {}) => ({
  id: 'u1',
  role: 'user',
  content: 'question',
  files: [],
  createdAt: 1,
  ...overrides,
})

/* ============================ finish reason mapping ============================ */

test('isAbnormalStopReason：只有 incomplete 是异常结束', () => {
  assert.equal(apiTypes.isAbnormalStopReason('incomplete'), true)
  for (const reason of ['end_turn', 'max_tokens', 'tool_use', 'refusal', undefined]) {
    assert.equal(apiTypes.isAbnormalStopReason(reason), false, String(reason))
  }
})

test('mapIncompleteReason：只有已知原因归类，未知原因不再静默当成 end_turn', () => {
  assert.equal(responses.mapIncompleteReason('max_output_tokens'), 'max_tokens')
  assert.equal(responses.mapIncompleteReason('content_filter'), 'refusal')
  assert.equal(responses.mapIncompleteReason(undefined), 'incomplete')
  assert.equal(responses.mapIncompleteReason('some_new_reason'), 'incomplete')
})

test('mapFinishReasonToStopReason：error / incomplete 映射为 incomplete，正常原因保持', () => {
  assert.equal(client.mapFinishReasonToStopReason('error'), 'incomplete')
  assert.equal(client.mapFinishReasonToStopReason('incomplete'), 'incomplete')
  assert.equal(client.mapFinishReasonToStopReason('end_turn'), 'end_turn')
  assert.equal(client.mapFinishReasonToStopReason('max_tokens'), 'max_tokens')
  assert.equal(client.mapFinishReasonToStopReason('tool_use'), 'tool_use')
  assert.equal(client.mapFinishReasonToStopReason('refusal'), 'refusal')
  assert.equal(client.mapFinishReasonToStopReason('stop_sequence'), 'end_turn')
})

/* ============================ describeReply ============================ */

test('describeReply：interrupted 且没有内容时给出明确文案，不返回空白', () => {
  const notice = describe.describeReply(
    assistant({
      status: 'error',
      error: { kind: 'interrupted', message: '' },
    })
  )
  assert.equal(notice?.text, i18n.translate('replyInterrupted'))
})

test('describeReply：非当前版本的 interrupted 文案同样兜底翻译', () => {
  const notice = describe.describeReply(
    assistant({
      status: 'error',
      error: { kind: 'interrupted', message: '', localMessage: { key: 'replyInterrupted' } },
    })
  )
  assert.equal(notice?.text, i18n.translate('replyInterrupted'))
})

test('describeReply：incomplete 结束原因给出「不完整」提示（即使已有部分正文）', () => {
  const notice = describe.describeReply(
    assistant({
      status: 'done',
      stopReason: 'incomplete',
      blocks: [{ type: 'text', text: 'partial answer' }],
    })
  )
  assert.equal(notice?.text, i18n.translate('replyIncomplete'))
})

/* ============================ context exclusion ============================ */

test('getContextRounds：异常结束的回复不能作为可用回答进入后续上下文', () => {
  const incomplete = assistant({ id: 'a1', stopReason: 'incomplete', blocks: [{ type: 'text', text: 'cut' }] })
  const normal = assistant({ id: 'a3', blocks: [{ type: 'text', text: 'ok' }] })
  const rounds = reply.getContextRounds([
    user({ id: 'u1', content: 'first' }),
    incomplete,
    user({ id: 'u2', content: 'second' }),
    normal,
  ])
  assert.deepEqual(
    rounds.map(([question, answer]) => [question.id, answer.id]),
    [['u2', 'a3']]
  )
})

test('toRequestMessages：异常结束的轮次整轮省略，只发送后续正常轮次与本轮提问', () => {
  const messages = reply.toRequestMessages(
    [
      user({ id: 'u1', content: 'first' }),
      assistant({ id: 'a1', stopReason: 'incomplete', blocks: [{ type: 'text', text: 'cut' }] }),
    ],
    user({ id: 'u2', content: 'next' })
  )
  assert.deepEqual(messages, [{ role: 'user', content: 'next' }])
})
