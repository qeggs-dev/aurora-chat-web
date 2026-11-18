// Tool-loop usage accumulation (src/services/chat/usageTotals.ts): each request in the loop
// contributes its own usage; the reply records one merged total instead of only the last round.
import assert from 'node:assert/strict'
import { test } from 'node:test'

const totals = await import('../.test-build/services/chat/usageTotals.js')

const usage = (overrides = {}) => ({
  input_tokens: 10,
  cache_creation_input_tokens: 2,
  cache_read_input_tokens: 3,
  output_tokens: 5,
  ...overrides,
})

test('mergeUsage：空值原样返回（不会造出不存在的记录）', () => {
  assert.equal(totals.mergeUsage(undefined, undefined), undefined)
  const first = usage()
  assert.equal(totals.mergeUsage(undefined, first), first)
  const total = usage({ input_tokens: 20 })
  assert.equal(totals.mergeUsage(total, undefined), total)
})

test('mergeUsage：累加两次请求的 token，两个可选字段都保留', () => {
  const merged = totals.mergeUsage(
    usage({ reasoning_tokens: 4, server_tool_use: { web_search_requests: 1, tool_search: 0 } }),
    usage({ reasoning_tokens: 6, server_tool_use: { web_search_requests: 2, tool_search: 1 } })
  )
  assert.deepEqual(merged, {
    input_tokens: 20,
    cache_creation_input_tokens: 4,
    cache_read_input_tokens: 6,
    output_tokens: 10,
    reasoning_tokens: 10,
    server_tool_use: { web_search_requests: 3, tool_search: 1 },
  })
})

test('mergeUsage：可选字段只在一侧出现时相加，两侧都没有时结果不带该字段', () => {
  const oneSided = totals.mergeUsage(usage(), usage({ reasoning_tokens: 7 }))
  assert.equal(oneSided.reasoning_tokens, 7)
  assert.equal('server_tool_use' in oneSided, false)

  const plain = totals.mergeUsage(usage(), usage())
  assert.equal('reasoning_tokens' in plain, false)
  assert.equal('server_tool_use' in plain, false)
})
