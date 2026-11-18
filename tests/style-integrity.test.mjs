// Style pack integrity + activation sequencing (src/services/style/integrity.ts,
// src/services/style/activation.ts): corrupted IndexedDB records are detected before activation
// and startup falls back to the builtin pack; concurrent activations settle last-wins.
import assert from 'node:assert/strict'
import { test } from 'node:test'

const integrity = await import('../.test-build/services/style/integrity.js')
const activation = await import('../.test-build/services/style/activation.js')

const blob = (size = 1) => new Blob([new Uint8Array(size)])

test('storedPackLooksIntact：资产为空 / 零字节 / 非 Blob 都算损坏', () => {
  assert.equal(integrity.storedPackLooksIntact({ assets: { a: blob() } }), true)
  assert.equal(integrity.storedPackLooksIntact({}), false)
  assert.equal(integrity.storedPackLooksIntact({ assets: {} }), false)
  assert.equal(integrity.storedPackLooksIntact({ assets: { a: blob(0) } }), false)
  assert.equal(integrity.storedPackLooksIntact({ assets: { a: { size: 3 } } }), false)
  // 任一资产损坏即整包判坏
  assert.equal(integrity.storedPackLooksIntact({ assets: { a: blob(), b: blob(0) } }), false)
})

test('storedPackLooksIntact：图标 / 封面必须缺省或是非空 Blob', () => {
  const assets = { a: blob() }
  assert.equal(
    integrity.storedPackLooksIntact({ assets, icon: { light: blob(), dark: blob() } }),
    true
  )
  assert.equal(integrity.storedPackLooksIntact({ assets, icon: { light: blob(0) } }), false)
  assert.equal(integrity.storedPackLooksIntact({ assets, cover: { dark: blob(0) } }), false)
  assert.equal(integrity.storedPackLooksIntact({ assets, cover: { light: undefined } }), true)
})

test('resolveInitialStylePackId：损坏的 saved 回退内置包，内置也坏才回退默认外观', () => {
  const packs = [
    { id: 'user-pack', broken: false },
    { id: 'aurora', builtin: true, broken: false },
    { id: 'broken-pack', broken: true },
  ]
  // saved 完整 → 用 saved
  assert.equal(integrity.resolveInitialStylePackId('user-pack', packs, 'aurora'), 'user-pack')
  // 没有 saved 记录（首次安装）→ 内置包
  assert.equal(integrity.resolveInitialStylePackId(null, packs, 'aurora'), 'aurora')
  // saved 已删除 / 不在列表 → 内置包
  assert.equal(integrity.resolveInitialStylePackId('gone', packs, 'aurora'), 'aurora')
  // saved 损坏 → 内置包
  assert.equal(integrity.resolveInitialStylePackId('broken-pack', packs, 'aurora'), 'aurora')
  // 内置 id 也拿不到（被用户同 id 包覆盖 / 解析失败）→ 应用默认外观
  assert.equal(integrity.resolveInitialStylePackId('broken-pack', packs, null), null)
  // 内置记录损坏 → 视为不可用
  const brokenBuiltin = [{ id: 'aurora', builtin: true, broken: true }]
  assert.equal(integrity.resolveInitialStylePackId('aurora', brokenBuiltin, 'aurora'), null)
})

test('createActivationGate：并发激活以最后一次为准，激活期间主题重应用跳过', () => {
  const gate = activation.createActivationGate()
  assert.equal(gate.isPending(), false)

  const first = gate.begin()
  assert.equal(gate.isPending(), true)
  assert.equal(gate.isCurrent(first), true)

  // 快速切换：第二次激活开始后，第一次的异步任务不再允许落地
  const second = gate.begin()
  assert.equal(gate.isCurrent(first), false)
  assert.equal(gate.isCurrent(second), true)

  // 主题变化时因为还有激活在跑，reapply 应跳过
  assert.equal(gate.isPending(), true)

  gate.end() // 第一次（被取代）收尾
  assert.equal(gate.isPending(), true)
  gate.end() // 第二次收尾
  assert.equal(gate.isPending(), false)
  assert.equal(gate.isCurrent(second), true)
})

test('createActivationGate：串行激活各自有效，结束后可再次开始', () => {
  const gate = activation.createActivationGate()
  const first = gate.begin()
  assert.equal(gate.isCurrent(first), true)
  gate.end()
  const second = gate.begin()
  assert.equal(gate.isCurrent(first), false)
  assert.equal(gate.isCurrent(second), true)
  gate.end()
  assert.equal(gate.isPending(), false)
})

test('createDeferredReapply：激活期间的主题切换延后到收尾，只应用最后一次', () => {
  let busy = false
  let applied = 0
  const reapply = activation.createDeferredReapply(
    () => busy,
    () => {
      applied += 1
    }
  )
  // 没有激活：立即应用
  reapply.request()
  assert.equal(applied, 1)

  // 激活期间：不立即应用，收尾前 flush 也不应用
  busy = true
  reapply.request()
  reapply.request()
  assert.equal(applied, 1)
  reapply.flush()
  assert.equal(applied, 1)

  // 激活收尾后 flush：补应用一次
  busy = false
  reapply.flush()
  assert.equal(applied, 2)
  // 没有新的请求时 flush 不重复应用
  reapply.flush()
  assert.equal(applied, 2)
})
