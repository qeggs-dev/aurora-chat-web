// Usage log / totals (src/services/usage/store.ts) and export formatting
// (src/services/usage/export.ts): pure aggregation, memory fallback, RFC 4180 CSV.
import assert from 'node:assert/strict'
import { test } from 'node:test'

const store = await import('../.test-build/services/usage/store.js')
const exporter = await import('../.test-build/services/usage/export.js')

const record = (overrides = {}) => ({
  id: `usage-${Math.random().toString(36).slice(2)}`,
  sessionId: 'sess-1',
  messageId: 'msg-1',
  protocol: 'anthropic',
  model: 'deepseek-flash',
  inputTokens: 10,
  outputTokens: 5,
  cacheReadTokens: 2,
  cacheWriteTokens: 1,
  totalTokens: 15,
  createdAt: 1_700_000_000_000,
  ...overrides,
})

/* ============================ 纯聚合函数 ============================ */

test('emptyUsageTotals 全零；isUsageTotalsEmpty 忽略 updatedAt', () => {
  const totals = store.emptyUsageTotals()
  assert.deepEqual(totals, {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    searchCount: 0,
    safetyTokens: 0,
    durationMs: 0,
    totalTokens: 0,
    updatedAt: 0,
  })
  assert.equal(store.isUsageTotalsEmpty(totals), true)
  assert.equal(store.isUsageTotalsEmpty({ ...totals, updatedAt: 123 }), true)
  for (const key of Object.keys(totals)) {
    if (key === 'updatedAt') {
      continue
    }
    assert.equal(store.isUsageTotalsEmpty({ ...totals, [key]: 1 }), false, `${key} should matter`)
  }
})

test('totalsOf 累加全部字段，可选字段缺失按 0，updatedAt 取最晚 createdAt', () => {
  const totals = store.totalsOf([
    record({ createdAt: 100, reasoningTokens: 3, searchCount: 1, safetyTokens: 2, durationMs: 500 }),
    record({ createdAt: 300, outputTokens: 7, totalTokens: 17 }),
  ])
  assert.equal(totals.requests, 2)
  assert.equal(totals.inputTokens, 20)
  assert.equal(totals.outputTokens, 12)
  assert.equal(totals.cacheReadTokens, 4)
  assert.equal(totals.cacheWriteTokens, 2)
  assert.equal(totals.reasoningTokens, 3)
  assert.equal(totals.searchCount, 1)
  assert.equal(totals.safetyTokens, 2)
  assert.equal(totals.durationMs, 500)
  assert.equal(totals.totalTokens, 32)
  assert.equal(totals.updatedAt, 300)
  assert.deepEqual(store.totalsOf([]), store.emptyUsageTotals())
})

/* ============================ recordUsage（无 IndexedDB 时走内存回退） ============================ */

const usageInput = (overrides = {}) => ({
  sessionId: null,
  messageId: `msg-${Math.random().toString(36).slice(2)}`,
  protocol: 'openai',
  model: 'gpt-demo',
  inputTokens: 3,
  outputTokens: 4,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  ...overrides,
})

test('recordUsage：存储不可用时仍返回记录并累加内存统计', async () => {
  const before = store.getUsageState()
  const record = await store.recordUsage(usageInput({ reasoningTokens: 1 }))
  assert.match(record.id, /^usage-/)
  assert.equal(record.totalTokens, 7)
  assert.equal(typeof record.createdAt, 'number')

  const state = store.getUsageState()
  assert.equal(state.records[0], record)
  assert.equal(state.totals.requests, before.totals.requests + 1)
  assert.equal(state.totals.inputTokens, before.totals.inputTokens + 3)
  assert.equal(state.totals.outputTokens, before.totals.outputTokens + 4)
  assert.equal(state.totals.reasoningTokens, before.totals.reasoningTokens + 1)
  assert.equal(state.totals.totalTokens, before.totals.totalTokens + 7)
  assert.ok(state.totals.updatedAt > 0)
})

test('recordUsage：同 messageId + 同 totalTokens 视为重复，不新增记录也不累加', async () => {
  const input = usageInput()
  const first = await store.recordUsage(input)
  const totalsBefore = store.getUsageState().totals
  const second = await store.recordUsage(input)
  assert.equal(second, first)
  assert.deepEqual(store.getUsageState().totals, totalsBefore)
})

test('recordUsage：同 messageId 但 token 总数不同算另一条记录', async () => {
  const input = usageInput()
  const first = await store.recordUsage(input)
  const totalsBefore = store.getUsageState().totals
  const second = await store.recordUsage({ ...input, outputTokens: 40 })
  assert.notEqual(second, first)
  assert.equal(second.totalTokens, 43)
  assert.equal(store.getUsageState().totals.requests, totalsBefore.requests + 1)
})

test('recordUsage：内存里的最近记录上限为 200 条', async () => {
  for (let index = 0; index < 205; index += 1) {
    await store.recordUsage(usageInput())
  }
  assert.equal(store.getUsageState().records.length, 200)
})

test('subscribeUsage：更新时通知监听器，取消订阅后不再通知', async () => {
  let count = 0
  const unsubscribe = store.subscribeUsage(() => {
    count += 1
  })
  await store.recordUsage(usageInput())
  assert.equal(count, 1)
  unsubscribe()
  await store.recordUsage(usageInput())
  assert.equal(count, 1)
})

/* ============================ 导出格式 ============================ */

test('escapeCsvField：含逗号 / 双引号 / 换行时按 RFC 4180 加引号并把引号翻倍', () => {
  assert.equal(exporter.escapeCsvField('plain'), 'plain')
  assert.equal(exporter.escapeCsvField('a,b'), '"a,b"')
  assert.equal(exporter.escapeCsvField('a"b'), '"a""b"')
  assert.equal(exporter.escapeCsvField('a"b,c'), '"a""b,c"')
  assert.equal(exporter.escapeCsvField('line1\nline2'), '"line1\nline2"')
  assert.equal(exporter.escapeCsvField('line1\r\nline2'), '"line1\r\nline2"')
  assert.equal(exporter.escapeCsvField(''), '')
})

test('toIsoWithOffset：本地时区 ISO 8601，可被 Date.parse 还原到秒', () => {
  const timestamp = 1_700_000_000_000
  const text = exporter.toIsoWithOffset(timestamp)
  assert.match(text, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/)
  assert.equal(Date.parse(text), timestamp)
  // 毫秒部分不进入字符串
  assert.equal(Date.parse(exporter.toIsoWithOffset(timestamp + 999)), timestamp)
})

test('usageExportStamp / usageExportFilename：本地时间戳与固定前缀', () => {
  const timestamp = 1_700_000_000_000
  assert.match(exporter.usageExportStamp(timestamp), /^\d{8}-\d{4}$/)
  assert.equal(exporter.usageExportFilename('json', timestamp), `aurora-usage-${exporter.usageExportStamp(timestamp)}.json`)
  assert.equal(exporter.usageExportFilename('csv', timestamp), `aurora-usage-${exporter.usageExportStamp(timestamp)}.csv`)
  assert.match(exporter.usageExportFilename('csv'), /^aurora-usage-\d{8}-\d{4}\.csv$/)
})

test('buildUsageJson：schema=1、exportedAt 本地 ISO、events 按 createdAt 升序', () => {
  const timestamp = 1_700_000_000_000
  const events = [
    record({ id: 'b', createdAt: 300 }),
    record({ id: 'a', createdAt: 100 }),
    record({ id: 'c', createdAt: 200 }),
  ]
  const totals = store.totalsOf(events)
  const parsed = JSON.parse(exporter.buildUsageJson(events, totals, timestamp))
  assert.equal(parsed.schema, 1)
  assert.equal(parsed.exportedAt, exporter.toIsoWithOffset(timestamp))
  assert.deepEqual(parsed.stats, totals)
  assert.deepEqual(
    parsed.events.map((event) => event.id),
    ['a', 'c', 'b']
  )
  // 不修改输入数组
  assert.deepEqual(
    events.map((event) => event.id),
    ['b', 'a', 'c']
  )
})

test('buildUsageCsv：表头 + 每行字段顺序 + CRLF 行尾 + RFC 4180 引号', () => {
  const createdAt = 1_700_000_000_000
  const csv = exporter.buildUsageCsv([
    record({
      sessionId: 'sess,1',
      messageId: 'msg"2',
      protocol: 'openai',
      model: 'line\nmodel',
      inputTokens: 1,
      cacheReadTokens: 2,
      cacheWriteTokens: 3,
      outputTokens: 4,
      reasoningTokens: 5,
      searchCount: 6,
      safetyTokens: 7,
      durationMs: 8,
      totalTokens: 5,
      createdAt,
    }),
  ])
  const iso = exporter.toIsoWithOffset(createdAt)
  assert.equal(
    csv,
    [
      exporter.USAGE_CSV_HEADER.join(','),
      `${iso},"sess,1","msg""2",openai,"line\nmodel",1,2,3,4,5,6,7,8,5`,
    ].join('\r\n')
  )
  // 可选字段缺失时输出空列
  const sparse = exporter.buildUsageCsv([record({ sessionId: null, createdAt, totalTokens: 15 })])
  const lastRow = sparse.split('\r\n')[1]
  assert.equal(
    lastRow,
    `${iso},,msg-1,anthropic,deepseek-flash,10,2,1,5,,,,,15`
  )
})

test('buildUsageCsv：多行按 createdAt 升序', () => {
  const csv = exporter.buildUsageCsv([
    record({ id: 'b', messageId: 'late', createdAt: 200 }),
    record({ id: 'a', messageId: 'early', createdAt: 100 }),
  ])
  const rows = csv.split('\r\n')
  assert.equal(rows.length, 3)
  assert.ok(rows[1].includes(',early,'))
  assert.ok(rows[2].includes(',late,'))
})

test('isNativePlatform：Capacitor 原生壳返回 true，Web 环境返回 false', () => {
  assert.equal(exporter.isNativePlatform(), false)
  globalThis.Capacitor = { isNativePlatform: () => true }
  try {
    assert.equal(exporter.isNativePlatform(), true)
  } finally {
    delete globalThis.Capacitor
  }
})
