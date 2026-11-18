// Protocol stream parsers (OpenAI Chat / Anthropic / Responses): normalized Delta
// sequences, block lifecycles, tool-call assembly, usage and interruption semantics.
import assert from 'node:assert/strict'
import { test } from 'node:test'

const { OpenAIChatStreamParser } = await import('../.test-build/services/api/providers/openai.js')
const { AnthropicStreamParser } = await import('../.test-build/services/api/providers/anthropic.js')
const { ResponsesStreamParser } = await import('../.test-build/services/api/providers/responses.js')

const sse = (data, event = 'message') => ({
  event,
  data: typeof data === 'string' ? data : JSON.stringify(data),
  lastEventId: '',
})

const chatChunk = (delta, extra = {}) =>
  sse({ id: 'chat-1', model: 'gpt-demo', choices: [{ index: 0, delta, ...extra }] })

const expectInterrupted = (parser) => {
  assert.throws(
    () => parser.end(),
    (error) => {
      assert.equal(error.name, 'ProviderError')
      assert.equal(error.kind, 'interrupted')
      assert.ok(typeof error.provider.protocol === 'string')
      return true
    }
  )
}

/* ============================ OpenAI Chat ============================ */

test('Chat 解析：start → thinking → text 块生命周期与自动 block_stop', () => {
  const parser = new OpenAIChatStreamParser()
  const first = parser.push(chatChunk({ reasoning_content: 'hmm' }))
  assert.deepEqual(first, [
    { type: 'start', messageId: 'chat-1', model: 'gpt-demo' },
    { type: 'block_start', index: 0, kind: 'thinking' },
    { type: 'thinking', index: 0, text: 'hmm' },
  ])
  const second = parser.push(chatChunk({ content: 'Hello' }))
  assert.deepEqual(second, [
    { type: 'block_stop', index: 0 },
    { type: 'block_start', index: 1, kind: 'text' },
    { type: 'text', index: 1, text: 'Hello' },
  ])
  const finished = parser.push(chatChunk({}, { finish_reason: 'stop' }))
  assert.deepEqual(finished, [
    { type: 'block_stop', index: 1 },
    { type: 'finish', reason: 'end_turn', raw: 'stop' },
  ])
  // 已有 finish_reason 时 [DONE] 不再重复发 finish
  assert.deepEqual(parser.push(sse('[DONE]')), [])
  assert.equal(parser.terminal, true)
})

test('Chat 解析：reasoning 字段兼容 OpenRouter 的 reasoning 命名', () => {
  const parser = new OpenAIChatStreamParser()
  const deltas = parser.push(chatChunk({ reasoning: 'why' }))
  assert.deepEqual(deltas[1], { type: 'block_start', index: 0, kind: 'thinking' })
  assert.deepEqual(deltas[2], { type: 'thinking', index: 0, text: 'why' })
})

test('Chat 解析：usage 来自独立空 choices 块，与 finish 分开也能正常收尾', () => {
  const parser = new OpenAIChatStreamParser()
  parser.push(chatChunk({ content: 'x' }))
  const usage = parser.push(
    sse({
      id: 'chat-1',
      choices: [],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    })
  )
  assert.deepEqual(usage, [
    {
      type: 'usage',
      usage: {
        inputTokens: 10,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 2,
        totalTokens: 12,
      },
      final: true,
    },
  ])
  assert.deepEqual(parser.push(chatChunk({}, { finish_reason: 'length' })), [
    { type: 'block_stop', index: 0 },
    { type: 'finish', reason: 'max_tokens', raw: 'length' },
  ])
})

test('Chat 解析：工具调用分片按 wire index 逐块累积，finish_reason=tool_calls', () => {
  const parser = new OpenAIChatStreamParser()
  const started = parser.push(
    chatChunk({
      tool_calls: [{ index: 0, id: 'call_1', function: { name: 'memory_write', arguments: '{"a"' } }],
    })
  )
  assert.deepEqual(started, [
    { type: 'start', messageId: 'chat-1', model: 'gpt-demo' },
    { type: 'block_start', index: 0, kind: 'tool_use', meta: { id: 'call_1', name: 'memory_write' } },
    { type: 'tool_call_delta', index: 0, json: '{"a"' },
  ])
  assert.deepEqual(
    parser.push(chatChunk({ tool_calls: [{ index: 0, function: { arguments: ':1}' } }] })),
    [{ type: 'tool_call_delta', index: 0, json: ':1}' }]
  )
  assert.deepEqual(parser.push(chatChunk({}, { finish_reason: 'tool_calls' })), [
    { type: 'block_stop', index: 0 },
    { type: 'finish', reason: 'tool_use', raw: 'tool_calls' },
  ])
})

test('Chat 解析：arguments 先于 name 到达时先攒着，name 到齐才开块', () => {
  const parser = new OpenAIChatStreamParser()
  const beforeName = parser.push(
    chatChunk({ tool_calls: [{ index: 0, function: { arguments: '{"x":' } }] })
  )
  // 只有 start；名称未到不开块
  assert.deepEqual(beforeName, [{ type: 'start', messageId: 'chat-1', model: 'gpt-demo' }])
  const withName = parser.push(
    chatChunk({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'n', arguments: '1}' } }] })
  )
  assert.deepEqual(withName, [
    { type: 'block_start', index: 0, kind: 'tool_use', meta: { id: 'c1', name: 'n' } },
    { type: 'tool_call_delta', index: 0, json: '{"x":1}' },
  ])
  // 没有 finish_reason 的 [DONE]：已开工具块 → 按 tool_use 收尾
  assert.deepEqual(parser.push(sse('[DONE]')), [
    { type: 'block_stop', index: 0 },
    { type: 'finish', reason: 'tool_use', raw: '[DONE]' },
  ])
})

test('Chat 解析：多个 tool_call 各自分配稳定块索引', () => {
  const parser = new OpenAIChatStreamParser()
  const deltas = parser.push(
    chatChunk({
      tool_calls: [
        { index: 0, id: 'c0', function: { name: 'n0', arguments: '{}' } },
        { index: 1, id: 'c1', function: { name: 'n1', arguments: '{}' } },
      ],
    })
  )
  assert.deepEqual(
    deltas.filter((delta) => delta.type === 'block_start'),
    [
      { type: 'block_start', index: 0, kind: 'tool_use', meta: { id: 'c0', name: 'n0' } },
      { type: 'block_start', index: 1, kind: 'tool_use', meta: { id: 'c1', name: 'n1' } },
    ]
  )
  const done = parser.push(sse('[DONE]'))
  assert.deepEqual(
    done.filter((delta) => delta.type === 'block_stop'),
    [
      { type: 'block_stop', index: 0 },
      { type: 'block_stop', index: 1 },
    ]
  )
})

test('Chat 解析：非 0 index 的 choice / 非法 JSON / 未知字段被忽略', () => {
  const parser = new OpenAIChatStreamParser()
  assert.deepEqual(parser.push(sse('not json')), [])
  assert.deepEqual(
    parser.push(sse({ id: 'x', choices: [{ index: 1, delta: { content: 'ignored' } }] })),
    [{ type: 'start', messageId: 'x' }]
  )
  // P0 只消费 index 0
  assert.equal(parser.push(sse({ choices: [{ index: 2, delta: { content: 'x' } }] })).length, 0)
})

test('Chat 解析：流内错误帧产出 error delta 并终止；后续事件不再处理', () => {
  const parser = new OpenAIChatStreamParser()
  const deltas = parser.push(sse({ error: { message: 'quota exceeded', type: 'rate_limit_exceeded' } }))
  assert.equal(deltas.length, 1)
  assert.equal(deltas[0].type, 'error')
  assert.equal(deltas[0].error.kind, 'stream')
  assert.equal(deltas[0].error.provider.type, 'rate_limit_exceeded')
  assert.equal(parser.terminal, true)
  assert.deepEqual(parser.push(chatChunk({ content: 'x' })), [])
  assert.deepEqual(parser.end(), [])
})

test('Chat 解析：没有 [DONE] 但已有 finish_reason 视为正常结束；都没有则 interrupted', () => {
  const finished = new OpenAIChatStreamParser()
  finished.push(chatChunk({ content: 'x' }))
  finished.push(chatChunk({}, { finish_reason: 'stop' }))
  assert.deepEqual(finished.end(), [])

  expectInterrupted(new OpenAIChatStreamParser())
  const partial = new OpenAIChatStreamParser()
  partial.push(chatChunk({ content: 'x' }))
  expectInterrupted(partial)
})

/* ============================ Anthropic ============================ */

test('Anthropic 解析：message_start 带输入侧 usage（final:false），正文块与签名 delta', () => {
  const parser = new AnthropicStreamParser()
  const started = parser.push(
    sse({
      type: 'message_start',
      message: {
        id: 'msg_1',
        model: 'claude-demo',
        usage: { input_tokens: 10, cache_read_input_tokens: 2, cache_creation_input_tokens: 1, output_tokens: 0 },
      },
    })
  )
  assert.deepEqual(started, [
    { type: 'start', messageId: 'msg_1', model: 'claude-demo' },
    { type: 'usage', usage: { inputTokens: 10, cacheReadTokens: 2, cacheWriteTokens: 1, outputTokens: 0, totalTokens: 13 }, final: false },
  ])

  const block = parser.push(
    sse({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '', signature: 'sig' },
    })
  )
  assert.equal(block[0].type, 'block_start')
  assert.equal(block[0].kind, 'thinking')
  assert.equal(block[0].index, 0)
  assert.deepEqual(block[0].meta, { type: 'thinking', thinking: '', signature: 'sig' })

  assert.deepEqual(parser.push(sse({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } })), [
    { type: 'thinking', index: 0, text: 'hmm' },
  ])
  assert.deepEqual(parser.push(sse({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 's2' } })), [
    { type: 'signature', index: 0, signature: 's2' },
  ])
  assert.deepEqual(parser.push(sse({ type: 'content_block_stop', index: 0 })), [
    { type: 'block_stop', index: 0 },
  ])
})

test('Anthropic 解析：text 块引用 / tool_use 参数分片 / provider_block 原样透传', () => {
  const parser = new AnthropicStreamParser()
  parser.push(sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
  assert.deepEqual(
    parser.push(
      sse({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'citations_delta', citation: { url: 'https://a.example', title: 'A' } },
      })
    ),
    [{ type: 'citation', index: 0, citation: { url: 'https://a.example', title: 'A' } }]
  )

  parser.push(
    sse({
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'memory_search', input: {} },
    })
  )
  assert.deepEqual(
    parser.push(
      sse({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"q"' } })
    ),
    [{ type: 'tool_call_delta', index: 1, json: '{"q"' }]
  )

  const provider = parser.push(
    sse({
      type: 'content_block_start',
      index: 2,
      content_block: { type: 'web_search_tool_result', tool_use_id: 'srv_1', kind: 'search', content: [] },
    })
  )
  assert.equal(provider[0].kind, 'provider_block')
  assert.equal(provider[0].meta.type, 'web_search_tool_result')
})

test('Anthropic 解析：未知块类型不占位，其 delta 被忽略', () => {
  const parser = new AnthropicStreamParser()
  assert.deepEqual(
    parser.push(sse({ type: 'content_block_start', index: 0, content_block: { type: 'mystery' } })),
    [{ type: 'start' }]
  )
  assert.deepEqual(
    parser.push(sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } })),
    []
  )
})

test('Anthropic 解析：message_delta 关闭活动块、补齐 usage 并发出 finish（含 stop_sequence）', () => {
  const parser = new AnthropicStreamParser()
  parser.push(
    sse({
      type: 'message_start',
      message: { id: 'm', model: 'c', usage: { input_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 } },
    })
  )
  parser.push(sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
  const deltas = parser.push(
    sse({
      type: 'message_delta',
      delta: { stop_reason: 'stop_sequence', stop_sequence: 'END' },
      usage: { output_tokens: 7 },
    })
  )
  assert.deepEqual(deltas, [
    { type: 'block_stop', index: 0 },
    {
      type: 'usage',
      usage: { inputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 7, totalTokens: 12 },
      final: true,
    },
    { type: 'finish', reason: 'stop_sequence', stopSequence: 'END', raw: 'stop_sequence' },
  ])
})

test('Anthropic 解析：message_stop 关闭剩余块并在缺少 stop_reason 时按 end_turn 收尾', () => {
  const parser = new AnthropicStreamParser()
  parser.push(sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
  assert.deepEqual(parser.push(sse({ type: 'message_stop' })), [
    { type: 'block_stop', index: 0 },
    { type: 'finish', reason: 'end_turn', raw: 'message_stop' },
  ])
  assert.equal(parser.terminal, true)
  assert.deepEqual(parser.push(sse({ type: 'message_stop' })), [])
})

test('Anthropic 解析：非 JSON 的 error 事件按流内错误处理；ping 忽略', () => {
  const ping = new AnthropicStreamParser()
  assert.deepEqual(ping.push(sse({ type: 'ping' }, 'ping')), [])
  assert.deepEqual(ping.push(sse('not json')), [])

  const failed = new AnthropicStreamParser()
  const deltas = failed.push(sse('backend exploded', 'error'))
  assert.equal(deltas.length, 1)
  assert.equal(deltas[0].type, 'error')
  assert.equal(deltas[0].error.kind, 'stream')
  assert.equal(deltas[0].error.message, 'backend exploded')
  assert.equal(failed.terminal, true)
})

test('Anthropic 解析：没有 message_stop 就结束 → interrupted（即使已收到 stop_reason）', () => {
  expectInterrupted(new AnthropicStreamParser())
  const parser = new AnthropicStreamParser()
  parser.push(sse({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null } }))
  // finish 已发出，但协议终止事件缺失：end() 仍按断流抛错，由上层决定是否按完成处理
  expectInterrupted(parser)
})

/* ============================ Responses ============================ */

test('Responses 解析：created → 文本块 → 引用区间 → output_item.done', () => {
  const parser = new ResponsesStreamParser()
  assert.deepEqual(parser.push(sse({ type: 'response.created', response: { id: 'resp_1', model: 'gpt-demo' } })), [
    { type: 'start', messageId: 'resp_1', model: 'gpt-demo' },
  ])
  const block = parser.push(
    sse({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_1' } })
  )
  assert.equal(block[0].type, 'block_start')
  assert.equal(block[0].kind, 'text')
  assert.equal(block[0].index, 0)

  assert.deepEqual(parser.push(sse({ type: 'response.output_text.delta', output_index: 0, delta: 'Hi' })), [
    { type: 'text', index: 0, text: 'Hi' },
  ])
  assert.deepEqual(
    parser.push(
      sse({
        type: 'response.output_text.annotation.added',
        output_index: 0,
        annotation: { type: 'url_citation', url: 'https://a.example', start_index: 0, end_index: 2 },
      })
    ),
    [{ type: 'citation', index: 0, citation: { url: 'https://a.example', title: null, startOffset: 0, endOffset: 2 } }]
  )
  assert.deepEqual(parser.push(sse({ type: 'response.output_item.done', output_index: 0 })), [
    { type: 'block_stop', index: 0 },
  ])
})

test('Responses 解析：reasoning item → thinking 块（摘要 delta）', () => {
  const parser = new ResponsesStreamParser()
  const block = parser.push(
    sse({ type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning' } })
  )
  assert.equal(block[0].kind, 'thinking')
  assert.deepEqual(
    parser.push(sse({ type: 'response.reasoning_summary_text.delta', output_index: 0, delta: 'why' })),
    [{ type: 'thinking', index: 0, text: 'why' }]
  )
})

test('Responses 解析：function_call 参数分片 + completed 收尾（tool_use / usage / terminal）', () => {
  const parser = new ResponsesStreamParser()
  const block = parser.push(
    sse({
      type: 'response.output_item.added',
      output_index: 2,
      item: { type: 'function_call', call_id: 'call_1', name: 'memory_write' },
    })
  )
  assert.deepEqual(block[0], {
    type: 'block_start',
    index: 2,
    kind: 'tool_use',
    meta: { id: 'call_1', name: 'memory_write' },
  })
  // object 形式的 meta 由上层按字段读取
  assert.equal(block[0].meta.name, 'memory_write')

  assert.deepEqual(
    parser.push(sse({ type: 'response.function_call_arguments.delta', output_index: 2, delta: '{"a":1}' })),
    [{ type: 'tool_call_delta', index: 2, json: '{"a":1}' }]
  )

  const completed = parser.push(
    sse({
      type: 'response.completed',
      response: {
        output: [{ type: 'function_call' }],
        usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
      },
    })
  )
  assert.deepEqual(completed, [
    { type: 'block_stop', index: 2 },
    {
      type: 'usage',
      usage: { inputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 2, totalTokens: 12 },
      final: true,
    },
    { type: 'finish', reason: 'tool_use' },
  ])
  assert.equal(parser.terminal, true)
  assert.deepEqual(parser.push(sse({ type: 'response.output_text.delta', output_index: 0, delta: 'x' })), [])
})

test('Responses 解析：completed 的结束原因来自 output（refusal）与默认 end_turn', () => {
  const refusal = new ResponsesStreamParser()
  assert.deepEqual(
    refusal.push(
      sse({
        type: 'response.completed',
        response: { output: [{ type: 'message', content: [{ type: 'refusal' }] }] },
      })
    ).at(-1),
    { type: 'finish', reason: 'refusal' }
  )

  const plain = new ResponsesStreamParser()
  assert.deepEqual(plain.push(sse({ type: 'response.completed', response: { output: [] } })).at(-1), {
    type: 'finish',
    reason: 'end_turn',
  })
})

test('Responses 解析：incomplete 映射 max_tokens 并带原始原因', () => {
  const parser = new ResponsesStreamParser()
  const deltas = parser.push(
    sse({
      type: 'response.incomplete',
      response: { incomplete_details: { reason: 'max_output_tokens' }, output: [] },
    })
  )
  assert.deepEqual(deltas.at(-1), { type: 'finish', reason: 'max_tokens', raw: 'max_output_tokens' })
})

test('Responses 解析：response.failed / error 事件按流内错误终止', () => {
  const failed = new ResponsesStreamParser()
  const deltas = failed.push(
    sse({ type: 'response.failed', response: { error: { code: 'server_error', message: 'boom' } } })
  )
  assert.equal(deltas[0].type, 'error')
  assert.equal(deltas[0].error.provider.code, 'server_error')
  assert.equal(failed.terminal, true)

  const flat = new ResponsesStreamParser()
  const flatDeltas = flat.push(sse({ type: 'error', code: 'invalid_prompt', message: 'bad' }))
  assert.equal(flatDeltas[0].error.provider.code, 'invalid_prompt')
})

test('Responses 解析：没有 completed / incomplete 就结束 → interrupted', () => {
  expectInterrupted(new ResponsesStreamParser())
})
