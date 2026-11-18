// Stream event validation (src/services/api/parseEvent.ts): only events whose consumed
// fields are safe are returned; unknown / malformed events are dropped silently.
import assert from 'node:assert/strict'
import { test } from 'node:test'

const { readMessageEvent } = await import('../.test-build/services/api/parseEvent.js')

const VALID_USAGE = {
  input_tokens: 10,
  cache_creation_input_tokens: 2,
  cache_read_input_tokens: 3,
  output_tokens: 4,
}

test('非对象 / 数组 / null 一律丢弃', () => {
  for (const value of [null, undefined, 1, 'text', [], true]) {
    assert.equal(readMessageEvent(value), null)
  }
})

test('message_start：保留 message，usage 必须四项都是数字才保留', () => {
  const valid = readMessageEvent({
    type: 'message_start',
    message: { id: 'msg_1', model: 'm', usage: VALID_USAGE },
  })
  assert.equal(valid.type, 'message_start')
  assert.deepEqual(valid.message.usage, VALID_USAGE)
  assert.equal(valid.message.id, 'msg_1')

  const missingUsage = readMessageEvent({ type: 'message_start', message: { id: 'm' } })
  assert.equal(missingUsage.message.usage, undefined)

  const partialUsage = readMessageEvent({
    type: 'message_start',
    message: { id: 'm', usage: { input_tokens: 1, output_tokens: 2 } },
  })
  assert.equal(partialUsage.message.usage, undefined)

  assert.equal(readMessageEvent({ type: 'message_start', message: 'nope' }), null)
})

test('content_block_start：text 块过滤非法引用，缺 text 丢弃', () => {
  const citation = { type: 'web_search_result_location', url: 'https://a.example', title: 'A' }
  const event = readMessageEvent({
    type: 'content_block_start',
    index: 0,
    content_block: {
      type: 'text',
      text: 'hello',
      citations: [citation, { type: 'web_search_result_location' }, 'junk'],
    },
  })
  assert.equal(event.type, 'content_block_start')
  assert.equal(event.index, 0)
  assert.equal(event.content_block.type, 'text')
  assert.equal(event.content_block.text, 'hello')
  assert.deepEqual(event.content_block.citations, [citation])

  assert.equal(
    readMessageEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
    null
  )
  // index 必须是非负安全整数
  assert.equal(
    readMessageEvent({ type: 'content_block_start', index: -1, content_block: { type: 'text', text: 'x' } }),
    null
  )
  assert.equal(
    readMessageEvent({ type: 'content_block_start', content_block: { type: 'text', text: 'x' } }),
    null
  )
})

test('content_block_start：thinking 块需要 thinking 文本，signature 非字符串时置 undefined', () => {
  const valid = readMessageEvent({
    type: 'content_block_start',
    index: 1,
    content_block: { type: 'thinking', thinking: 'hmm', signature: 'sig' },
  })
  assert.equal(valid.content_block.type, 'thinking')
  assert.equal(valid.content_block.thinking, 'hmm')
  assert.equal(valid.content_block.signature, 'sig')

  const badSignature = readMessageEvent({
    type: 'content_block_start',
    index: 1,
    content_block: { type: 'thinking', thinking: 'hmm', signature: 42 },
  })
  assert.equal(badSignature.content_block.signature, undefined)

  assert.equal(
    readMessageEvent({ type: 'content_block_start', index: 1, content_block: { type: 'thinking' } }),
    null
  )
})

test('content_block_start：tool_use 需要 id/name，input 不是对象时回落空对象', () => {
  const valid = readMessageEvent({
    type: 'content_block_start',
    index: 2,
    content_block: { type: 'tool_use', id: 'toolu_1', name: 'memory_write', input: { content: 'x' } },
  })
  assert.deepEqual(valid.content_block.input, { content: 'x' })

  const emptyInput = readMessageEvent({
    type: 'content_block_start',
    index: 2,
    content_block: { type: 'tool_use', id: 'toolu_1', name: 'n', input: null },
  })
  assert.deepEqual(emptyInput.content_block.input, {})

  assert.equal(
    readMessageEvent({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'x' } }),
    null
  )
})

test('content_block_start：server_tool_use 校验动作与参数形状', () => {
  const search = {
    type: 'content_block_start',
    index: 0,
    content_block: {
      type: 'server_tool_use',
      id: 'srv_1',
      name: 'deepseek_web_search',
      kind: 'search',
      input: { action: 'search', queries: ['a', 'b'] },
    },
  }
  assert.ok(readMessageEvent(search))

  const readLink = {
    ...search,
    content_block: {
      type: 'server_tool_use',
      id: 'srv_2',
      name: 'deepseek_read_url',
      kind: 'read_link',
      input: { action: 'open_page', url: 'https://a.example' },
    },
  }
  assert.ok(readMessageEvent(readLink))

  const bad = [
    { ...search, content_block: { ...search.content_block, input: { action: 'search', queries: [1] } } },
    { ...search, content_block: { ...search.content_block, input: { action: 'open_page' } } },
    { ...search, content_block: { ...search.content_block, input: { action: 'find_in_page', url: 'u' } } },
    { ...search, content_block: { ...search.content_block, input: { action: 'unknown' } } },
    { ...search, content_block: { ...search.content_block, kind: 'bogus' } },
    { ...search, content_block: { ...search.content_block, name: 'other_tool' } },
  ]
  for (const event of bad) {
    assert.equal(readMessageEvent(event), null)
  }
})

test('content_block_start：web_search_tool_result 过滤非法条目；web_fetch_tool_result 保留签名', () => {
  const searchResult = readMessageEvent({
    type: 'content_block_start',
    index: 0,
    content_block: {
      type: 'web_search_tool_result',
      tool_use_id: 'srv_1',
      kind: 'search',
      content: [
        {
          type: 'web_search_result',
          url: 'https://a.example',
          title: 'A',
          snippet: null,
          site_name: null,
          site_icon: null,
          page_age: null,
        },
        { type: 'web_search_tool_result_error', error_code: 'unavailable' },
        { type: 'web_search_result' },
        'junk',
      ],
    },
  })
  assert.equal(searchResult.content_block.content.length, 2)

  const fetchResult = readMessageEvent({
    type: 'content_block_start',
    index: 1,
    content_block: {
      type: 'web_fetch_tool_result',
      tool_use_id: 'srv_2',
      kind: 'read_link',
      signature: 'sig',
      content: {
        type: 'web_fetch_result',
        url: 'https://a.example/p',
        title: null,
        published_at: null,
        content: {},
      },
    },
  })
  assert.ok(fetchResult)
  assert.equal(fetchResult.content_block.signature, 'sig')

  assert.equal(
    readMessageEvent({
      type: 'content_block_start',
      index: 1,
      content_block: {
        type: 'web_fetch_tool_result',
        tool_use_id: 'srv_2',
        kind: 'read_link',
        content: { type: 'web_fetch_result', url: 'https://a.example/p' },
      },
    }),
    null
  )
})

test('content_block_delta：各类 delta 校验必需字段', () => {
  const text = readMessageEvent({
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: 'hi' },
  })
  assert.equal(text.delta.type, 'text_delta')
  assert.equal(text.delta.text, 'hi')

  assert.ok(
    readMessageEvent({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'hmm' },
    })
  )
  assert.ok(
    readMessageEvent({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'signature_delta', signature: 'sig' },
    })
  )
  assert.ok(
    readMessageEvent({
      type: 'content_block_delta',
      index: 0,
      delta: {
        type: 'citations_delta',
        citation: { type: 'web_search_result_location', url: 'https://a.example', title: 'A' },
      },
    })
  )
  assert.ok(
    readMessageEvent({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"a":' },
    })
  )

  // 未知 delta / 字段类型错误 / index 缺失
  assert.equal(
    readMessageEvent({ type: 'content_block_delta', index: 0, delta: { type: 'unknown' } }),
    null
  )
  assert.equal(
    readMessageEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 1 } }),
    null
  )
  assert.equal(
    readMessageEvent({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'citations_delta', citation: { url: 'https://a.example' } },
    }),
    null
  )
  assert.equal(
    readMessageEvent({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'x' } }),
    null
  )
})

test('content_block_stop / message_stop：index 合法才放行', () => {
  assert.deepEqual(readMessageEvent({ type: 'content_block_stop', index: 3 }), {
    type: 'content_block_stop',
    index: 3,
  })
  assert.equal(readMessageEvent({ type: 'content_block_stop', index: -1 }), null)
  assert.equal(readMessageEvent({ type: 'content_block_stop' }), null)
  assert.deepEqual(readMessageEvent({ type: 'message_stop' }), { type: 'message_stop' })
})

test('message_delta：stop_reason 必须是已知值，title / usage 按需保留', () => {
  const valid = readMessageEvent({
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null, title: 'Hello' },
    usage: VALID_USAGE,
  })
  assert.equal(valid.delta.stop_reason, 'end_turn')
  assert.equal(valid.delta.title, 'Hello')
  assert.deepEqual(valid.usage, VALID_USAGE)

  const noUsage = readMessageEvent({
    type: 'message_delta',
    delta: { stop_reason: 'max_tokens', stop_sequence: null },
  })
  assert.equal(noUsage.usage, undefined)
  assert.equal(noUsage.delta.title, undefined)

  const badTitle = readMessageEvent({
    type: 'message_delta',
    delta: { stop_reason: 'refusal', stop_sequence: null, title: 5 },
  })
  assert.equal(badTitle.delta.title, undefined)

  for (const reason of ['unknown_reason', '', null, 1]) {
    assert.equal(
      readMessageEvent({
        type: 'message_delta',
        delta: { stop_reason: reason, stop_sequence: null },
      }),
      null
    )
  }
  assert.equal(readMessageEvent({ type: 'message_delta', delta: 'nope' }), null)
  assert.equal(readMessageEvent({ type: 'message_delta' }), null)
})

test('ping 与未知事件类型被丢弃', () => {
  for (const type of ['ping', 'error', 'content_block_unknown', '']) {
    assert.equal(readMessageEvent({ type }), null)
  }
})
