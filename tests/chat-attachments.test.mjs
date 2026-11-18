// Chat request attachments: `skipped-` placeholder files must never enter a request
// (src/services/api/files.ts, src/services/chat/fileBlocks.ts, reply.toRequestMessages), and
// removed draft attachments release their remote file only when no session still references them
// (src/services/chat/draftFiles.ts).
import assert from 'node:assert/strict'
import { test } from 'node:test'

// reply.ts → preset/index → preset/types reads the build-time API origin at module scope
globalThis.__API_ORIGIN__ = 'https://api.deepseek.com'

const files = await import('../.test-build/services/api/files.js')
const fileBlocks = await import('../.test-build/services/chat/fileBlocks.js')
const draftFiles = await import('../.test-build/services/chat/draftFiles.js')
const reply = await import('../.test-build/services/chat/reply.js')

const attachment = (overrides = {}) => ({
  id: 'file-1',
  serverId: 'file-api-1',
  name: 'doc.pdf',
  size: 10,
  isImage: false,
  mimeType: 'application/pdf',
  ...overrides,
})

const placeholder = (overrides = {}) =>
  attachment({ serverId: 'skipped-3', name: 'photo.png', isImage: true, ...overrides })

const user = (overrides = {}) => ({
  id: 'u1',
  role: 'user',
  content: 'hello',
  files: [],
  createdAt: 1,
  ...overrides,
})

const assistant = (overrides = {}) => ({
  id: 'a1',
  role: 'assistant',
  createdAt: 2,
  model: null,
  prefix: true,
  status: 'done',
  stopReason: 'end_turn',
  blocks: [{ type: 'text', text: 'answer' }],
  ...overrides,
})

/* ============================ files / fileBlocks ============================ */

test('isSkippedFileId：只识别不支持 Files 的预设返回的占位 file_id', () => {
  assert.equal(files.isSkippedFileId('skipped-1'), true)
  assert.equal(files.isSkippedFileId('file-api-abc'), false)
  assert.equal(files.SKIPPED_FILE_PREFIX, 'skipped-')
})

test('toFileBlocks：过滤占位与未补传附件，保留真实 file_id，并区分图片 / 文档', () => {
  const blocks = fileBlocks.toFileBlocks([
    attachment(),
    placeholder(),
    attachment({ id: 'file-2', serverId: null, isImage: true }),
    attachment({ id: 'file-3', serverId: 'file-api-3', isImage: true }),
  ])
  assert.deepEqual(blocks, [
    { type: 'document', source: { type: 'file', file_id: 'file-api-1' } },
    { type: 'image', source: { type: 'file', file_id: 'file-api-3' } },
  ])
})

test('hasRequestContent：只有正文或真实文件块才算可进入请求的提问', () => {
  assert.equal(fileBlocks.hasRequestContent('hi', []), true)
  assert.equal(fileBlocks.hasRequestContent('  ', []), false)
  assert.equal(fileBlocks.hasRequestContent('', [attachment()]), true)
  assert.equal(fileBlocks.hasRequestContent('', [placeholder()]), false)
  assert.equal(fileBlocks.hasRequestContent('', [attachment({ serverId: null })]), false)
  assert.equal(fileBlocks.hasRequestContent('', []), false)
})

/* ============================ toRequestMessages ============================ */

test('toRequestMessages：占位附件的历史轮次被整轮跳过，真实附件正常回传', () => {
  const history = [
    user({ id: 'u1', content: '', files: [placeholder()] }),
    assistant({ id: 'a1' }),
    user({ id: 'u2', content: 'look', files: [attachment({ id: 'file-2' })] }),
    assistant({ id: 'a2' }),
  ]
  const messages = reply.toRequestMessages(
    history,
    user({ id: 'u3', content: 'next question' })
  )
  assert.deepEqual(messages, [
    {
      role: 'user',
      content: [{ type: 'document', source: { type: 'file', file_id: 'file-api-1' } }, { type: 'text', text: 'look' }],
    },
    { role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
    { role: 'user', content: 'next question' },
  ])
})

test('toRequestMessages：占位附件 + 无正文的本轮提问不发送空 user 消息', () => {
  const messages = reply.toRequestMessages([], user({ content: '', files: [placeholder()] }))
  assert.deepEqual(messages, [])
})

test('toRequestMessages：正文 + 占位附件时正文照常发送，附件被过滤', () => {
  const messages = reply.toRequestMessages([user({ content: '', files: [placeholder()] }), assistant()], user({ content: 'hi', files: [placeholder()] }))
  assert.deepEqual(messages, [{ role: 'user', content: 'hi' }])
})

/* ============================ draft remote file cleanup ============================ */

const doneTask = (serverId) => ({ status: 'done', serverId })

test('remoteFileCleanupTarget：被会话引用不删，未引用才删，占位 / 未完成不删', () => {
  assert.equal(draftFiles.remoteFileCleanupTarget('file-1', doneTask('file-api-1'), new Set()), 'file-api-1')
  assert.equal(
    draftFiles.remoteFileCleanupTarget('file-1', doneTask('file-api-1'), new Set(['file-1'])),
    null
  )
  assert.equal(
    draftFiles.remoteFileCleanupTarget('file-1', doneTask('skipped-1'), new Set()),
    null
  )
  assert.equal(draftFiles.remoteFileCleanupTarget('file-1', { status: 'uploading' }, new Set()), null)
  assert.equal(
    draftFiles.remoteFileCleanupTarget(
      'file-1',
      { status: 'error', error: { key: 'uploadFileStatusFailed' }, retryable: true },
      new Set()
    ),
    null
  )
})

test('cleanupDraftRemoteFile：未引用时删除远端文件并返回 true', async () => {
  const deleted = []
  const cleaned = await draftFiles.cleanupDraftRemoteFile('file-1', doneTask('file-api-1'), {
    loadReferencedFileIds: async () => new Set(),
    deleteRemoteFile: async (serverId) => deleted.push(serverId),
  })
  assert.equal(cleaned, true)
  assert.deepEqual(deleted, ['file-api-1'])
})

test('cleanupDraftRemoteFile：被其他会话引用时保留（不调用删除）', async () => {
  let deleted = 0
  const cleaned = await draftFiles.cleanupDraftRemoteFile('file-1', doneTask('file-api-1'), {
    loadReferencedFileIds: async () => new Set(['file-1', 'file-9']),
    deleteRemoteFile: async () => {
      deleted += 1
    },
  })
  assert.equal(cleaned, false)
  assert.equal(deleted, 0)
})

test('cleanupDraftRemoteFile：读取引用或删除失败都静默返回 false', async () => {
  assert.equal(
    await draftFiles.cleanupDraftRemoteFile('file-1', doneTask('file-api-1'), {
      loadReferencedFileIds: async () => {
        throw new Error('storage')
      },
      deleteRemoteFile: async () => {},
    }),
    false
  )
  assert.equal(
    await draftFiles.cleanupDraftRemoteFile('file-1', doneTask('file-api-1'), {
      loadReferencedFileIds: async () => new Set(),
      deleteRemoteFile: async () => {
        throw new Error('network')
      },
    }),
    false
  )
  // 没有可删对象时不去读引用
  let reads = 0
  assert.equal(
    await draftFiles.cleanupDraftRemoteFile('file-1', doneTask('skipped-1'), {
      loadReferencedFileIds: async () => {
        reads += 1
        return new Set()
      },
      deleteRemoteFile: async () => {},
    }),
    false
  )
  assert.equal(reads, 0)
})
