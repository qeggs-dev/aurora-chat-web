// In-place editing of an assistant reply (src/services/chat/replyEdit.ts):
// the edit keeps the message's branch wiring (id / parentId / selectedChildId) and every
// other message untouched, only rewrites the answer text blocks, marks the reply edited and
// bumps the session revision. Later request context (toRequestMessages) must use the new text.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

globalThis.__API_ORIGIN__ = 'https://api.deepseek.com'

const replyEdit = await import('../.test-build/services/chat/replyEdit.js')
const reply = await import('../.test-build/services/chat/reply.js')

const thinking = { type: 'thinking', thinking: 'reasoning', signature: 'sig' }
const text = (value) => ({ type: 'text', text: value })

const user = (id, content) => ({ id, role: 'user', content, files: [], createdAt: 1 })
const assistant = (id, blocks, overrides = {}) => ({
  id,
  role: 'assistant',
  createdAt: 2,
  model: null,
  prefix: true,
  status: 'done',
  blocks,
  ...overrides,
})

const makeSession = () => ({
  id: 's1',
  title: 'session',
  createdAt: 1,
  updatedAt: 5,
  revision: 7,
  rootMessageId: 'u1',
  messages: [
    { ...user('u1', 'question'), parentId: null, selectedChildId: 'a1' },
    {
      ...assistant('a1', [thinking, text('original answer')]),
      parentId: 'u1',
      selectedChildId: 'u2',
    },
    { ...user('u2', 'follow up'), parentId: 'a1', selectedChildId: 'a2' },
    { ...assistant('a2', [text('child answer')]), parentId: 'u2', selectedChildId: undefined },
  ],
})

/* ============================ structure / revision ============================ */

test('editReplyInSession：只替换回答正文块，id / parentId / selectedChildId 与会话结构不变，revision 自增', () => {
  const original = makeSession()
  const result = replyEdit.editReplyInSession(original, 'a1', 'edited answer', 1000)
  assert.equal(result.ok, true)
  assert.equal(result.changed, true)

  const next = result.session
  assert.equal(next.revision, 8)
  assert.equal(next.updatedAt, 1000)
  assert.deepEqual(
    next.messages.map((message) => message.id),
    ['u1', 'a1', 'u2', 'a2']
  )

  const edited = next.messages[1]
  assert.equal(edited.id, 'a1')
  assert.equal(edited.parentId, 'u1')
  assert.equal(edited.selectedChildId, 'u2')
  assert.equal(edited.edited, true)
  // 思考块原样保留；尾部文本块换成编辑后的正文
  assert.equal(edited.blocks.length, 2)
  assert.equal(edited.blocks[0], thinking)
  assert.deepEqual(edited.blocks[1], { type: 'text', text: 'edited answer' })
  assert.equal(replyEdit.getEditableReply(edited), 'edited answer')

  // 其它消息对象原样复用，不重算、不删除（后续子消息不受影响）
  for (const index of [0, 2, 3]) {
    assert.equal(next.messages[index], original.messages[index])
  }
  // 纯函数：原会话快照不被就地修改
  assert.equal(original.messages[1].blocks[1].text, 'original answer')
  assert.equal(original.revision, 7)
})

test('editReplyInSession：内容未变且已标记编辑时不产生新快照（revision 不再增长）', () => {
  const first = replyEdit.editReplyInSession(makeSession(), 'a1', 'original answer', 1000)
  assert.equal(first.ok, true)
  assert.equal(first.changed, true)
  assert.equal(first.session.revision, 8)

  const second = replyEdit.editReplyInSession(first.session, 'a1', 'original answer', 2000)
  assert.equal(second.ok, true)
  assert.equal(second.changed, false)
  assert.equal(second.session, first.session)
  assert.equal(second.session.revision, 8)
})

/* ============================ rejection ============================ */

test('editReplyInSession：空白内容一律拒绝，会话与消息都不变', () => {
  for (const value of ['', '   ', '\n\t ', '\r\n']) {
    const original = makeSession()
    const result = replyEdit.editReplyInSession(original, 'a1', value, 1000)
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'empty')
    assert.equal(original.revision, 7)
    assert.equal(original.messages[1].edited, undefined)
  }
})

test('canEditReply：只有已结束、非流式、非拒绝、非模板且有回答正文的助手消息可编辑', () => {
  const editable = assistant('a1', [thinking, text('answer')])
  assert.equal(replyEdit.canEditReply(editable, false), true)
  assert.equal(replyEdit.canEditReply(editable, true), false, '流式生成中不可编辑')
  assert.equal(replyEdit.canEditReply(user('u1', 'question'), false), false)
  assert.equal(replyEdit.canEditReply(undefined, false), false)
  assert.equal(
    replyEdit.canEditReply(assistant('a1', [text('x')], { status: 'streaming' }), false),
    false
  )
  assert.equal(
    replyEdit.canEditReply(assistant('a1', [text('x')], { status: 'pending' }), false),
    false
  )
  assert.equal(
    replyEdit.canEditReply(assistant('a1', [text('x')], { status: 'error' }), false),
    false
  )
  assert.equal(
    replyEdit.canEditReply(assistant('a1', [text('x')], { stopReason: 'refusal' }), false),
    false
  )
  assert.equal(
    replyEdit.canEditReply(
      assistant(
        'a1',
        [text('template')].map((block) => ({ ...block, isTemplate: true }))
      ),
      false
    ),
    false,
    '服务端模板提示不是可编辑正文'
  )
  assert.equal(replyEdit.canEditReply(assistant('a1', [thinking]), false), false, '没有正文')
})

test('editReplyInSession：不可编辑的消息返回 notEditable，不写任何内容', () => {
  const original = makeSession()
  const cases = [
    ['u1', 'new text'],
    ['missing', 'new text'],
  ]
  for (const [messageId, content] of cases) {
    const result = replyEdit.editReplyInSession(original, messageId, content, 1000)
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'notEditable')
  }
  const streaming = makeSession()
  streaming.messages[1] = { ...streaming.messages[1], status: 'streaming' }
  const result = replyEdit.editReplyInSession(streaming, 'a1', 'new text', 1000)
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'notEditable')
})

/* ============================ no side effects ============================ */

test('editReplyInSession：编辑不新增消息、不进入生成态（不会产生请求 / 重新生成）', () => {
  const original = makeSession()
  const result = replyEdit.editReplyInSession(original, 'a1', 'edited answer', 1000)
  assert.equal(result.ok, true)
  const next = result.session

  // 不新增消息、不新增提问、不插入 pending/streaming 的回复占位
  assert.equal(next.messages.length, original.messages.length)
  assert.deepEqual(
    next.messages.map((message) => message.id),
    original.messages.map((message) => message.id)
  )
  assert.equal(
    next.messages.filter((message) => message.role === 'user').length,
    original.messages.filter((message) => message.role === 'user').length
  )
  assert.equal(
    next.messages.filter(
      (message) => message.status === 'pending' || message.status === 'streaming'
    ).length,
    0
  )
  // 回复仍是 done，编辑后的内容直接可读，不需要等流式
  assert.equal(next.messages[1].status, 'done')
  assert.equal(replyEdit.getEditableReply(next.messages[1]), 'edited answer')
})

test('store.editReply：只更新内容并持久化，不调用 sendMessage / streamReply / regenerateReply，也不发请求', () => {
  const source = readFileSync(new URL('../src/services/chat/store.ts', import.meta.url), 'utf8')
  const start = source.indexOf('export const editReply =')
  assert.ok(start >= 0, 'editReply should exist in store.ts')
  const end = source.indexOf('\nexport ', start + 10)
  const body = source.slice(start, end === -1 ? undefined : end)
  for (const forbidden of [
    'sendMessage(',
    'streamReply(',
    'regenerateReply(',
    'editMessage(',
    'fetch(',
  ]) {
    assert.equal(body.includes(forbidden), false, `editReply must not call ${forbidden}`)
  }
  assert.ok(
    body.includes('persist(sessionId)'),
    'editReply should persist through the existing save path'
  )
})

/* ============================ request context ============================ */

test('toRequestMessages：编辑后的助手回复立即作为新的请求上下文（旧文本不再出现）', () => {
  const original = makeSession()
  const result = replyEdit.editReplyInSession(original, 'a1', 'edited answer', 1000)
  assert.equal(result.ok, true)

  const history = result.session.messages.slice(0, 2)
  const messages = reply.toRequestMessages(history, user('u3', 'next question'))
  assert.deepEqual(messages, [
    { role: 'user', content: 'question' },
    { role: 'assistant', content: [{ type: 'text', text: 'edited answer' }] },
    { role: 'user', content: 'next question' },
  ])
  assert.equal(JSON.stringify(messages).includes('original answer'), false)
})

test('toRequestMessages：编辑较早的回答不会影响后续轮次的内容', () => {
  const original = makeSession()
  const result = replyEdit.editReplyInSession(original, 'a1', 'edited answer', 1000)
  assert.equal(result.ok, true)

  const messages = reply.toRequestMessages(
    result.session.messages.slice(0, 4),
    user('u3', 'next question')
  )
  assert.deepEqual(messages, [
    { role: 'user', content: 'question' },
    { role: 'assistant', content: [{ type: 'text', text: 'edited answer' }] },
    { role: 'user', content: 'follow up' },
    { role: 'assistant', content: [{ type: 'text', text: 'child answer' }] },
    { role: 'user', content: 'next question' },
  ])
})
