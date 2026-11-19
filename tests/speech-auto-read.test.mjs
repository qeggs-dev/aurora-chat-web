// 自动朗读（src/services/speech/autoRead.ts）：可朗读判断、streaming 状态机、订阅触发；
// 以及设置持久化（src/services/settings.ts）与共享 AudioContext 的注入（readAloud.ts）。
import assert from 'node:assert/strict'
import { test } from 'node:test'

globalThis.__API_ORIGIN__ = 'https://api.deepseek.com'

// settings.ts 在模块初始化时读 localStorage：node 里没有，先装一个内存实现再导入。
const memory = new Map()
globalThis.localStorage = {
  getItem: (key) => (memory.has(key) ? memory.get(key) : null),
  setItem: (key, value) => {
    memory.set(key, String(value))
  },
  removeItem: (key) => {
    memory.delete(key)
  },
}

const autoRead = await import('../.test-build/services/speech/autoRead.js')
const settings = await import('../.test-build/services/settings.js')
const speech = await import('../.test-build/services/speech/readAloud.js')

/** 助手回复；默认是一条已正常结束、有正文的回复 */
const assistant = (overrides = {}) => ({
  id: 'a1',
  role: 'assistant',
  createdAt: 0,
  model: 'deepseek-flash',
  prefix: true,
  status: 'done',
  blocks: [{ type: 'text', text: '你好' }],
  ...overrides,
})

/** 不写 rootMessageId 时 getVisibleMessages 直接返回 messages（线性列表） */
const session = (messages) => ({
  id: 's1',
  title: '标题',
  createdAt: 0,
  updatedAt: 0,
  revision: 1,
  messages,
})

const user = (id = 'u1') => ({ id, role: 'user', content: '问题', files: [], createdAt: 0 })

/** 状态机的标准输入：当前会话刚结束生成 */
const input = (overrides = {}) => ({
  previousStreaming: { s1: {} },
  streaming: {},
  activeId: 's1',
  enabled: true,
  session: session([user(), assistant()]),
  ...overrides,
})

/* ============================ 消息可读性判断 ============================ */

test('getAutoReadableText：正常结束且有正文的回复可朗读', () => {
  assert.equal(autoRead.getAutoReadableText(assistant()), '你好')
  // 回答正文取最后一个非文本块之后的文本块，前面的说明文字不读
  assert.equal(
    autoRead.getAutoReadableText(
      assistant({
        blocks: [
          { type: 'text', text: '前言' },
          { type: 'thinking', thinking: '思考过程' },
          { type: 'text', text: '最终回答' },
        ],
      })
    ),
    '最终回答'
  )
})

test('getAutoReadableText：历史编辑、错误、中断、不完整、空正文、流式中都不朗读', () => {
  assert.equal(autoRead.getAutoReadableText(undefined), null)
  assert.equal(autoRead.getAutoReadableText(user()), null)
  assert.equal(autoRead.getAutoReadableText(assistant({ edited: true })), null)
  assert.equal(autoRead.getAutoReadableText(assistant({ status: 'streaming' })), null)
  assert.equal(autoRead.getAutoReadableText(assistant({ status: 'pending' })), null)
  assert.equal(autoRead.getAutoReadableText(assistant({ status: 'stopped' })), null)
  assert.equal(
    autoRead.getAutoReadableText(
      assistant({ status: 'error', error: { kind: 'network', message: '断网' } })
    ),
    null
  )
  assert.equal(autoRead.getAutoReadableText(assistant({ stopReason: 'incomplete' })), null)
  assert.equal(autoRead.getAutoReadableText(assistant({ stopReason: 'refusal' })), null)
  assert.equal(autoRead.getAutoReadableText(assistant({ blocks: [] })), null)
  assert.equal(
    autoRead.getAutoReadableText(assistant({ blocks: [{ type: 'text', text: '   \n' }] })),
    null
  )
  // 服务端模板提示（isTemplate）只在界面展示，不作为可朗读正文
  assert.equal(
    autoRead.getAutoReadableText(
      assistant({ blocks: [{ type: 'text', text: '拒绝回答', isTemplate: true }] })
    ),
    null
  )
})

test('findAutoReadableReply：取可见路径最后一条消息，最后一条不是可读回复时为 null', () => {
  assert.deepEqual(autoRead.findAutoReadableReply(session([user(), assistant({ id: 'a2' })])), {
    messageId: 'a2',
    text: '你好',
  })
  assert.equal(autoRead.findAutoReadableReply(session([user(), assistant(), user('u2')])), null)
  assert.equal(autoRead.findAutoReadableReply(undefined), null)
})

/* ============================ streaming 状态机 ============================ */

test('getFinishedSessions：只返回从生成中变为空闲的会话', () => {
  assert.deepEqual(autoRead.getFinishedSessions({ a: {}, b: {} }, { a: {} }), ['b'])
  assert.deepEqual(autoRead.getFinishedSessions({}, {}), [])
  // 开始生成（false → true）不算结束
  assert.deepEqual(autoRead.getFinishedSessions({}, { a: {} }), [])
})

test('decideAutoRead：开关开启 + 当前会话刚结束 + 可读回复才触发', () => {
  assert.deepEqual(autoRead.decideAutoRead(input()), {
    sessionId: 's1',
    messageId: 'a1',
    text: '你好',
  })
  // 历史消息不会重播：没有 true → false 的状态变化
  assert.equal(autoRead.decideAutoRead(input({ previousStreaming: {}, streaming: {} })), null)
  // 开关关闭
  assert.equal(autoRead.decideAutoRead(input({ enabled: false })), null)
  // 非当前会话刚结束
  assert.equal(
    autoRead.decideAutoRead(
      input({ previousStreaming: { s1: {}, s2: {} }, streaming: { s1: {} } })
    ),
    null
  )
  // 欢迎页（无当前会话）
  assert.equal(autoRead.decideAutoRead(input({ activeId: null })), null)
  // 最后一条回复不可朗读
  assert.equal(
    autoRead.decideAutoRead(
      input({
        session: session([
          user(),
          assistant({ status: 'error', error: { kind: 'x', message: '' } }),
        ]),
      })
    ),
    null
  )
})

test('bindAutoRead：订阅 streaming 变化，每次结束只触发一次，无关变化不触发', () => {
  let listener = null
  const store = {
    getState: () => ({ activeId: 's1', streaming: {}, sessionCache: {} }),
    subscribe: (next) => {
      listener = next
      return () => {
        listener = null
      }
    },
  }
  const reads = []
  const unbind = autoRead.bindAutoRead({
    store,
    isEnabled: () => true,
    read: (decision) => reads.push(decision),
  })

  // 生成中（false → true）：不触发
  listener(
    { activeId: 's1', streaming: { s1: {} }, sessionCache: { s1: session([user(), assistant()]) } },
    { activeId: 's1', streaming: {}, sessionCache: {} }
  )
  assert.equal(reads.length, 0)

  // 流式内容更新：不触发
  listener(
    { activeId: 's1', streaming: { s1: {} }, sessionCache: { s1: session([user(), assistant()]) } },
    { activeId: 's1', streaming: { s1: {} }, sessionCache: {} }
  )
  assert.equal(reads.length, 0)

  // 生成结束（true → false）：触发一次
  listener(
    { activeId: 's1', streaming: {}, sessionCache: { s1: session([user(), assistant()]) } },
    { activeId: 's1', streaming: { s1: {} }, sessionCache: {} }
  )
  assert.deepEqual(reads, [{ sessionId: 's1', messageId: 'a1', text: '你好' }])

  unbind()
  assert.equal(listener, null)
})

/* ============================ 设置持久化 ============================ */

test('settings：autoReadAloud 默认关闭，写入/读取 localStorage 的固定 key', async () => {
  assert.equal(settings.useSettings.getState().autoReadAloud, false)

  settings.setAutoReadAloud(true)
  assert.equal(settings.useSettings.getState().autoReadAloud, true)
  assert.equal(memory.get('chat-demo:auto-read-aloud'), 'true')

  settings.setAutoReadAloud(false)
  assert.equal(settings.useSettings.getState().autoReadAloud, false)
  assert.equal(memory.get('chat-demo:auto-read-aloud'), 'false')

  // 重新加载模块（模拟刷新页面）：从 localStorage 恢复开启状态
  memory.set('chat-demo:auto-read-aloud', 'true')
  const reloaded = await import('../.test-build/services/settings.js?restored=1')
  assert.equal(reloaded.useSettings.getState().autoReadAloud, true)
  assert.equal(reloaded.useSettings.getState().locale !== undefined, true)
})

/* ============================ AudioContext 注入 ============================ */

/** 可控的 AudioContext 替身：记录创建 / resume / close */
const fakeAudioContextFactory = () => {
  const log = { created: 0, resumed: 0, closed: 0 }
  const factory = () => {
    log.created += 1
    const context = {
      state: 'suspended',
      currentTime: 0,
      destination: {},
      resume: () => {
        log.resumed += 1
        context.state = 'running'
        return Promise.resolve()
      },
      close: () => {
        log.closed += 1
        context.state = 'closed'
        return Promise.resolve()
      },
    }
    return context
  }
  return { log, factory }
}

test('primeReadAloud：在“手势”里创建共享 AudioContext，之后复用它', () => {
  const { log, factory } = fakeAudioContextFactory()
  speech.setReadAloudAudioContextFactory(factory)

  assert.equal(speech.primeReadAloud(), true)
  assert.equal(log.created, 1)
  assert.equal(log.resumed, 1)

  // 再次预热复用同一个 context
  assert.equal(speech.primeReadAloud(), true)
  assert.equal(log.created, 1)
  assert.equal(log.resumed, 1)

  // 没有在朗读时 stopReadAloud 不应关闭共享 context（只 close 临时创建的）
  speech.stopReadAloud()
  assert.equal(log.closed, 0)

  // 恢复默认实现时释放共享 context
  speech.setReadAloudAudioContextFactory(null)
  assert.equal(log.closed, 1)
})

test('primeReadAloud：AudioContext 创建失败时返回 false，不抛错', () => {
  speech.setReadAloudAudioContextFactory(() => {
    throw new Error('AudioContext is unavailable')
  })
  assert.equal(speech.primeReadAloud(), false)
  speech.setReadAloudAudioContextFactory(null)
})

test('ReadAloudAudioError：可识别，并映射成“暂时无法朗读”文案', () => {
  const error = new speech.ReadAloudAudioError()
  assert.equal(speech.isReadAloudAudioError(error), true)
  assert.equal(speech.isReadAloudAudioError(new Error('nope')), false)
  assert.deepEqual(speech.describeReadAloudError(error), { key: 'ttsUnavailable' })
})
