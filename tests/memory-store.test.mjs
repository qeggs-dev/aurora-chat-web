// Memory tool argument validation (src/services/memory/store.ts): model-facing tools
// validate parameters and return structured JSON errors instead of throwing.
// The sql.js wasm asset is stubbed by tests/wasm-stub.mjs; no database is opened here.
import assert from 'node:assert/strict'
import { test } from 'node:test'

globalThis.__API_ORIGIN__ = 'https://api.deepseek.com'

const store = await import('../.test-build/services/memory/store.js')

const parseToolResult = (text) => {
  const parsed = JSON.parse(text)
  assert.equal(typeof parsed.ok, 'boolean')
  return parsed
}

test('MEMORY_TOOLS：记忆工具 schema 稳定，content/query 必填', () => {
  assert.deepEqual(
    store.MEMORY_TOOLS.map((tool) => tool.name),
    ['memory_write', 'memory_search']
  )
  const write = store.MEMORY_TOOLS[0]
  assert.deepEqual(write.parameters.required, ['content'])
  assert.deepEqual(Object.keys(write.parameters.properties).sort(), ['content', 'section', 'tags'])
  const search = store.MEMORY_TOOLS[1]
  assert.deepEqual(search.parameters.required, ['query'])
  assert.deepEqual(Object.keys(search.parameters.properties).sort(), ['limit', 'query', 'section', 'tags'])
})

test('MEMORY_SECTIONS：五个章节锚点', () => {
  assert.deepEqual(store.MEMORY_SECTIONS, {
    core: 'SEC:00',
    preference: 'SEC:01',
    project: 'SEC:02',
    decision: 'SEC:03',
    todo: 'SEC:04',
  })
})

test('runMemoryTool：未知工具返回 unknown_tool', async () => {
  const result = parseToolResult(await store.runMemoryTool('memory_delete', {}))
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'unknown_tool')
})

test('runMemoryTool：参数结构 / 必填字段 / 长度上限返回 invalid_args', async () => {
  const cases = [
    [await store.runMemoryTool('memory_write', null), 'arguments'],
    [await store.runMemoryTool('memory_write', { content: 42 }), 'content'],
    [await store.runMemoryTool('memory_write', { content: '   ' }), 'content'],
    [await store.runMemoryTool('memory_write', { content: 'x'.repeat(2049) }), 'content'],
    [await store.runMemoryTool('memory_write', { content: 'ok', tags: 'tag' }), 'tags'],
    [await store.runMemoryTool('memory_write', { content: 'ok', tags: [1] }), 'tags'],
    [await store.runMemoryTool('memory_write', { content: 'ok', tags: [''] }), 'tags'],
    [await store.runMemoryTool('memory_write', { content: 'ok', tags: ['x'.repeat(33)] }), 'tags'],
    [
      await store.runMemoryTool('memory_write', { content: 'ok', tags: ['a', 'b', 'c', 'd', 'e'] }),
      'tags',
    ],
    [await store.runMemoryTool('memory_write', { content: 'ok', section: 'SEC:99' }), 'section'],
    [await store.runMemoryTool('memory_write', { content: 'ok', section: 5 }), 'section'],
    [await store.runMemoryTool('memory_search', {}), 'query'],
    [await store.runMemoryTool('memory_search', { query: 'q'.repeat(201) }), 'query'],
    [await store.runMemoryTool('memory_search', { query: 'q', limit: 0 }), 'limit'],
    [await store.runMemoryTool('memory_search', { query: 'q', limit: 21 }), 'limit'],
    [await store.runMemoryTool('memory_search', { query: 'q', limit: 1.5 }), 'limit'],
  ]
  for (const [text, field] of cases) {
    const result = parseToolResult(text)
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'invalid_args')
    assert.equal(result.error.field, field)
  }
})

test('runMemoryTool：参数合法但记忆未启用时返回 memory_disabled（不发 SQL）', async () => {
  assert.equal(store.getMemoryState().enabled, false)
  const write = parseToolResult(await store.runMemoryTool('memory_write', { content: 'remember me' }))
  assert.equal(write.ok, false)
  assert.equal(write.error.code, 'memory_disabled')

  const search = parseToolResult(await store.runMemoryTool('memory_search', { query: 'q' }))
  assert.equal(search.ok, false)
  assert.equal(search.error.code, 'memory_disabled')
})

test('runMemoryTool：未知分区在禁用状态下也先校验参数（不会静默忽略）', async () => {
  const result = parseToolResult(
    await store.runMemoryTool('memory_write', { content: 'ok', section: 'SEC:00x' })
  )
  assert.equal(result.error.code, 'invalid_args')
  assert.equal(result.error.field, 'section')
})

test('setMemoryState / subscribeMemory：状态更新与取消订阅', () => {
  let count = 0
  const unsubscribe = store.subscribeMemory(() => {
    count += 1
  })
  store.setMemoryState({ enabled: true })
  assert.equal(store.getMemoryState().enabled, true)
  assert.equal(count, 1)
  store.setMemoryState({ enabled: false })
  assert.equal(count, 2)
  unsubscribe()
  store.setMemoryState({ enabled: false })
  assert.equal(count, 2)
})
