// Multi-window chat sync (src/services/chat/sync.ts): monotonic revisions, stale-save
// rejection, remote-change filtering and BroadcastChannel message wiring.
import assert from 'node:assert/strict'
import { test } from 'node:test'

const sync = await import('../.test-build/services/chat/sync.js')

class FakeBroadcastChannel {
  static instances = []
  onmessage = null
  closed = false

  constructor(name) {
    this.name = name
    FakeBroadcastChannel.instances.push(this)
  }

  postMessage(data) {
    for (const other of FakeBroadcastChannel.instances) {
      if (other === this || other.closed || !other.onmessage) {
        continue
      }
      other.onmessage({ data })
    }
  }

  close() {
    this.closed = true
    FakeBroadcastChannel.instances = FakeBroadcastChannel.instances.filter((item) => item !== this)
  }
}

test('nextRevision：旧数据缺 revision 时从 0 起算，每次更新 +1', () => {
  assert.equal(sync.nextRevision(undefined), 1)
  assert.equal(sync.nextRevision(0), 1)
  assert.equal(sync.nextRevision(7), 8)
})

test('isStaleSave：存储里 revision 更高时放弃写入（旧快照不覆盖新数据）', () => {
  // 存储 7，本地旧快照 6：放弃
  assert.equal(sync.isStaleSave(7, 6), true)
  assert.equal(sync.isStaleSave(8, 6), true)
  // 相同是重复保存（内容一致）；本地更新则正常写入
  assert.equal(sync.isStaleSave(6, 6), false)
  assert.equal(sync.isStaleSave(5, 6), false)
  // 旧数据没有 revision：允许写入，写入后补上 revision
  assert.equal(sync.isStaleSave(undefined, 1), false)
})

test('shouldApplyRemoteRevision：只有远端更新才重载，相同 revision 视为重复通知', () => {
  assert.equal(sync.shouldApplyRemoteRevision(3, undefined), true)
  assert.equal(sync.shouldApplyRemoteRevision(3, 2), true)
  assert.equal(sync.shouldApplyRemoteRevision(3, 3), false)
  assert.equal(sync.shouldApplyRemoteRevision(2, 3), false)
})

test('isSessionChangeMessage：只接受结构完整的会话变更消息', () => {
  assert.equal(
    sync.isSessionChangeMessage({ type: 'session-changed', sessionId: 's1', revision: 2 }),
    true
  )
  const invalid = [
    null,
    undefined,
    'session-changed',
    {},
    { type: 'other', sessionId: 's1', revision: 2 },
    { type: 'session-changed', sessionId: '', revision: 2 },
    { type: 'session-changed', sessionId: 's1', revision: '2' },
    { type: 'session-changed', sessionId: 's1', revision: Number.NaN },
  ]
  for (const value of invalid) {
    assert.equal(sync.isSessionChangeMessage(value), false, JSON.stringify(value))
  }
})

test('createChatChannel：广播消息经校验后交给监听器，非法消息忽略，close 后不再转发', () => {
  const original = globalThis.BroadcastChannel
  globalThis.BroadcastChannel = FakeBroadcastChannel
  try {
    const delivered = []
    const sender = sync.createChatChannel(() => {})
    const receiver = sync.createChatChannel((message) => delivered.push(message))
    assert.ok(sender)
    assert.ok(receiver)

    sender.post({ type: 'session-changed', sessionId: 's1', revision: 3 })
    sender.post({ type: 'unknown', sessionId: 's1', revision: 4 })
    assert.deepEqual(delivered, [{ type: 'session-changed', sessionId: 's1', revision: 3 }])

    receiver.close()
    sender.post({ type: 'session-changed', sessionId: 's1', revision: 5 })
    assert.equal(delivered.length, 1)
  } finally {
    globalThis.BroadcastChannel = original
  }
})

test('createChatChannel：环境没有 BroadcastChannel 时返回 null（单窗口降级）', () => {
  const original = globalThis.BroadcastChannel
  globalThis.BroadcastChannel = undefined
  try {
    assert.equal(sync.createChatChannel(() => {}), null)
  } finally {
    globalThis.BroadcastChannel = original
  }
})
