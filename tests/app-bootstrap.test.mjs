// App bootstrap (src/app/bootstrap.ts): Cordis start() failure must not leave the UI stuck
// on "loading chats"; direct-module fallback initialization still runs and the error is surfaced.
import assert from 'node:assert/strict'
import { test } from 'node:test'

const bootstrap = await import('../.test-build/app/bootstrap.js')

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

const makeServices = (calls, options = {}) => {
  let memoryEnabled = options.memoryEnabled ?? false
  const listeners = new Set()
  return {
    initChat: async () => {
      calls.push('initChat')
    },
    style: {
      init: async () => {
        calls.push('style')
      },
    },
    presets: {
      init: async () => {
        calls.push('presets')
      },
      getMemoryEnabled: () => memoryEnabled,
      subscribe: (listener) => {
        calls.push('subscribe')
        listeners.add(listener)
        return () => {
          calls.push('unsubscribe')
          listeners.delete(listener)
        }
      },
    },
    usage: {
      init: async () => {
        calls.push('usage')
      },
    },
    memory: {
      init: async (enabled) => {
        calls.push(`memoryInit:${enabled}`)
      },
      setEnabled: async (enabled) => {
        calls.push(`memorySet:${enabled}`)
      },
    },
    disclaimerAccepted: () => options.disclaimerAccepted ?? false,
    ensureApiKey: () => calls.push('ensureApiKey'),
    setMemoryEnabled: (next) => {
      memoryEnabled = next
    },
    notifyPresetChange: () => {
      for (const listener of listeners) {
        listener()
      }
    },
  }
}

test('runBootstrap：并行启动 initChat / style / usage，预设恢复后按记忆开关初始化记忆', async () => {
  const calls = []
  const services = makeServices(calls)
  const run = bootstrap.runBootstrap(services)
  await tick()
  assert.deepEqual(calls, ['initChat', 'style', 'usage', 'subscribe', 'presets', 'memoryInit:false'])
  run.dispose()
  assert.equal(calls.includes('unsubscribe'), true)
})

test('runBootstrap：记忆开关随预设切换同步，但预设恢复前不触发', async () => {
  const calls = []
  const services = makeServices(calls, { memoryEnabled: false })
  const run = bootstrap.runBootstrap(services)
  await tick()
  services.setMemoryEnabled(true)
  services.notifyPresetChange()
  assert.equal(calls.includes('memorySet:true'), true)
  // 重复通知同一开关不重复调用
  const before = calls.filter((call) => call.startsWith('memorySet:')).length
  services.notifyPresetChange()
  assert.equal(calls.filter((call) => call.startsWith('memorySet:')).length, before)
  run.dispose()
})

test('runBootstrap：确认声明后才要求 API Key', () => {
  const withoutNotice = []
  bootstrap.runBootstrap(makeServices(withoutNotice))
  assert.equal(withoutNotice.includes('ensureApiKey'), false)

  const withNotice = []
  bootstrap.runBootstrap(makeServices(withNotice, { disclaimerAccepted: true }))
  assert.equal(withNotice.includes('ensureApiKey'), true)
})

test('bootstrapApp：start() 失败时返回原因并改用直连初始化（initChat 等照常执行）', async () => {
  const calls = []
  const fallback = makeServices(calls)
  const servicesCalls = []
  const result = await bootstrap.bootstrapApp({
    start: async () => {
      throw new Error('Cordis 服务启动失败：api（缺少依赖：settings）')
    },
    fromServices: () => makeServices(servicesCalls),
    fromFallback: () => fallback,
  })
  await tick()
  assert.match(result.error, /Cordis 服务启动失败/)
  // 直连初始化全部执行，界面不会停在「会话加载中」
  assert.deepEqual(calls, [
    'initChat',
    'style',
    'usage',
    'subscribe',
    'presets',
    'memoryInit:false',
  ])
  assert.deepEqual(servicesCalls, [])
  result.dispose()
})

test('bootstrapApp：start() 成功时使用容器服务，不触发直连初始化', async () => {
  const calls = []
  const fallbackCalls = []
  const result = await bootstrap.bootstrapApp({
    start: async () => {},
    fromServices: () => makeServices(calls),
    fromFallback: () => makeServices(fallbackCalls),
  })
  await tick()
  assert.equal(result.error, null)
  assert.equal(calls.includes('initChat'), true)
  assert.deepEqual(fallbackCalls, [])
  result.dispose()
})

test('describeBootstrapError：保留原始错误文案，空文案给出兜底提示', () => {
  assert.equal(bootstrap.describeBootstrapError(new Error('缺少依赖：settings')), '缺少依赖：settings')
  assert.equal(bootstrap.describeBootstrapError('boom'), 'boom')
  assert.match(bootstrap.describeBootstrapError(new Error('   ')), /Cordis/)
})
