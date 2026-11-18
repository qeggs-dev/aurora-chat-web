// Three-protocol request compilation, usage normalization, finish reasons and provider
// error classification (src/services/api/providers/*): pure functions, no network.
import assert from 'node:assert/strict'
import { test } from 'node:test'

const openai = await import('../.test-build/services/api/providers/openai.js')
const anthropic = await import('../.test-build/services/api/providers/anthropic.js')
const responses = await import('../.test-build/services/api/providers/responses.js')
const errors = await import('../.test-build/services/api/providers/errors.js')
const types = await import('../.test-build/services/api/providers/types.js')

const profile = (overrides = {}) => ({
  id: 'p',
  label: 'P',
  protocol: 'openai-chat',
  baseUrl: 'https://api.example.com',
  apiKey: 'sk-test',
  model: 'default-model',
  ...overrides,
})

const user = (content) => ({ role: 'user', content })

const expectConfigError = (fn, messagePart) => {
  assert.throws(fn, (error) => {
    assert.equal(error.name, 'ProviderError')
    assert.equal(error.kind, 'config')
    if (messagePart !== undefined) {
      assert.ok(error.message.includes(messagePart), `unexpected message: ${error.message}`)
    }
    return true
  })
}

/* ============================ OpenAI Chat ============================ */

test('Chat 请求：最小请求体只含 model/messages/stream/stream_options，参数留空不发送', () => {
  const compiled = openai.compileOpenAIChatRequest(
    profile(),
    { model: 'm', messages: [user('hi')] }
  )
  assert.equal(compiled.url, 'https://api.example.com/v1/chat/completions')
  assert.equal(compiled.headers.authorization, 'Bearer sk-test')
  assert.equal(compiled.headers.accept, 'text/event-stream')
  assert.deepEqual(compiled.body, {
    model: 'm',
    messages: [{ role: 'user', content: 'hi' }],
    stream: true,
    stream_options: { include_usage: true },
  })
  for (const key of ['temperature', 'top_p', 'max_completion_tokens', 'stop', 'seed', 'reasoning_effort']) {
    assert.equal(key in compiled.body, false, `${key} should not be sent when omitted`)
  }
  assert.deepEqual(compiled.warnings, [])
})

test('Chat 请求：显式参数映射到 wire 字段（max_completion_tokens/top_p/penalties/seed/reasoning_effort）', () => {
  const compiled = openai.compileOpenAIChatRequest(profile(), {
    model: 'm',
    messages: [user('hi')],
    maxOutputTokens: 512,
    temperature: 0.3,
    topP: 0.8,
    stop: ['END', 'STOP'],
    presencePenalty: -0.5,
    frequencyPenalty: 0.25,
    seed: 7,
    thinking: { enabled: true, effort: 'high' },
  })
  assert.equal(compiled.body.max_completion_tokens, 512)
  assert.equal(compiled.body.temperature, 0.3)
  assert.equal(compiled.body.top_p, 0.8)
  assert.deepEqual(compiled.body.stop, ['END', 'STOP'])
  assert.equal(compiled.body.presence_penalty, -0.5)
  assert.equal(compiled.body.frequency_penalty, 0.25)
  assert.equal(compiled.body.seed, 7)
  assert.equal(compiled.body.reasoning_effort, 'high')
})

test('Chat 请求：topK 忽略并告警，stop 超过 4 个截断并告警，空 stop 不发送', () => {
  const compiled = openai.compileOpenAIChatRequest(profile(), {
    model: 'm',
    messages: [user('hi')],
    topK: 5,
    stop: ['1', '2', '3', '4', '5'],
  })
  assert.equal(compiled.body.top_k, undefined)
  assert.deepEqual(compiled.body.stop, ['1', '2', '3', '4'])
  assert.equal(compiled.warnings.length, 2)
  assert.ok(compiled.warnings.some((warning) => warning.includes('topK')))
  assert.ok(compiled.warnings.some((warning) => warning.includes('stop')))

  const emptyStop = openai.compileOpenAIChatRequest(profile(), {
    model: 'm',
    messages: [user('hi')],
    stop: [],
  })
  assert.equal('stop' in emptyStop.body, false)
})

test('Chat 请求：system / reminder 降级为 system 消息，assistant 思考不回传、工具调用进 tool_calls', () => {
  const compiled = openai.compileOpenAIChatRequest(profile(), {
    model: 'm',
    system: 'top system',
    messages: [
      user('q'),
      { role: 'reminder', content: 'reminder text' },
      {
        role: 'assistant',
        blocks: [
          { type: 'thinking', text: 'hidden' },
          { type: 'text', text: 'answer ' },
          { type: 'text', text: 'text' },
          { type: 'tool_use', id: 'call_1', name: 'memory_write', input: { content: 'x' } },
        ],
      },
    ],
  })
  assert.deepEqual(compiled.body.messages, [
    { role: 'system', content: 'top system' },
    { role: 'user', content: 'q' },
    { role: 'system', content: 'reminder text' },
    {
      role: 'assistant',
      content: 'answer text',
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'memory_write', arguments: '{"content":"x"}' },
        },
      ],
    },
  ])
})

test('Chat 请求：assistant 纯工具调用 content 为 null；只有思考块时整条消息丢弃', () => {
  const toolOnly = openai.compileOpenAIChatRequest(profile(), {
    model: 'm',
    messages: [
      {
        role: 'assistant',
        blocks: [{ type: 'tool_use', id: 'c1', name: 'n', input: {} }],
      },
    ],
  })
  assert.equal(toolOnly.body.messages[0].content, null)
  assert.equal(toolOnly.body.messages[0].tool_calls.length, 1)

  const thinkingOnly = openai.compileOpenAIChatRequest(profile(), {
    model: 'm',
    messages: [{ role: 'assistant', blocks: [{ type: 'thinking', text: 'hmm' }] }],
  })
  assert.deepEqual(thinkingOnly.body.messages, [])
})

test('Chat 请求：user 工具结果是独立 tool 消息，正文存在时才补 user 消息；附件告警', () => {
  const compiled = openai.compileOpenAIChatRequest(profile(), {
    model: 'm',
    messages: [
      {
        role: 'user',
        content: 'follow up',
        files: [{ type: 'image', mimeType: 'image/png', fileId: 'f1' }],
        toolResults: [{ toolUseId: 'call_1', content: '{"ok":true}' }],
      },
      { role: 'user', content: '', toolResults: [{ toolUseId: 'call_2', content: 'r' }] },
    ],
  })
  assert.deepEqual(compiled.body.messages, [
    { role: 'user', content: 'follow up' },
    { role: 'tool', tool_call_id: 'call_1', content: '{"ok":true}' },
    { role: 'tool', tool_call_id: 'call_2', content: 'r' },
  ])
  assert.ok(compiled.warnings.some((warning) => warning.includes('附件')))
})

test('Chat 请求：tools / tool_choice 映射，extraBody / extraHeaders 浅合并', () => {
  const compiled = openai.compileOpenAIChatRequest(
    profile({ extraBody: { thinking: { type: 'enabled' } }, extraHeaders: { 'x-extra': '1' } }),
    {
      model: 'm',
      messages: [user('hi')],
      tools: [
        {
          name: 'memory_search',
          description: 'search',
          parameters: { type: 'object', properties: {} },
        },
      ],
      toolChoice: 'auto',
    }
  )
  assert.deepEqual(compiled.body.tools, [
    {
      type: 'function',
      function: { name: 'memory_search', description: 'search', parameters: { type: 'object', properties: {} } },
    },
  ])
  assert.equal(compiled.body.tool_choice, 'auto')
  assert.deepEqual(compiled.body.thinking, { type: 'enabled' })
  assert.equal(compiled.headers['x-extra'], '1')
})

test('Chat 请求：参数校验失败时抛 config 错误（model / maxOutputTokens / temperature / topP）', () => {
  expectConfigError(() => openai.compileOpenAIChatRequest(profile({ model: '' }), { model: '', messages: [] }), 'model')
  expectConfigError(
    () => openai.compileOpenAIChatRequest(profile(), { model: 'm', messages: [], maxOutputTokens: 0 }),
    'maxOutputTokens'
  )
  expectConfigError(
    () => openai.compileOpenAIChatRequest(profile(), { model: 'm', messages: [], temperature: 3 }),
    'temperature'
  )
  expectConfigError(
    () => openai.compileOpenAIChatRequest(profile(), { model: 'm', messages: [], topP: 2 }),
    'topP'
  )
  expectConfigError(
    () => openai.compileOpenAIChatRequest(profile(), { model: 'm', messages: [], seed: 1.5 }),
    'seed'
  )
})

test('Chat 请求：capabilities 覆写后不支持的能力降级并告警', () => {
  const limited = profile({
    capabilities: { sampling: { temperatureMax: 1, seed: false, penalties: false } },
  })
  const compiled = openai.compileOpenAIChatRequest(limited, {
    model: 'm',
    messages: [user('hi')],
    temperature: 1,
    seed: 3,
    presencePenalty: 1,
  })
  assert.equal(compiled.body.temperature, 1)
  assert.equal('seed' in compiled.body, false)
  assert.equal('presence_penalty' in compiled.body, false)
  // capabilities 不支持的能力都要记降级告警（seed / penalties 各一条）
  assert.equal(compiled.warnings.length, 2)
  assert.ok(compiled.warnings.some((warning) => warning.includes('seed')))
  assert.ok(compiled.warnings.some((warning) => warning.includes('penalties')))
  expectConfigError(
    () => openai.compileOpenAIChatRequest(limited, { model: 'm', messages: [], temperature: 1.5 }),
    'temperature'
  )
})

test('Chat usage：prompt_tokens 含缓存命中，inputTokens 要减去 cached_tokens（兼容 DeepSeek 字段）', () => {
  assert.deepEqual(
    openai.normalizeChatUsage({
      prompt_tokens: 100,
      prompt_tokens_details: { cached_tokens: 30 },
      completion_tokens: 20,
      completion_tokens_details: { reasoning_tokens: 5 },
      total_tokens: 140,
    }),
    {
      inputTokens: 70,
      cacheReadTokens: 30,
      cacheWriteTokens: 0,
      outputTokens: 20,
      reasoningTokens: 5,
      totalTokens: 140,
    }
  )
  assert.deepEqual(openai.normalizeChatUsage({ prompt_cache_hit_tokens: 10, prompt_tokens: 5 }), {
    inputTokens: 0,
    cacheReadTokens: 10,
    cacheWriteTokens: 0,
    outputTokens: 0,
  })
  assert.deepEqual(openai.normalizeChatUsage({}), {
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
  })
})

test('Chat finish_reason 映射；未知原因按 error 收尾', () => {
  assert.equal(openai.mapChatFinishReason('stop'), 'end_turn')
  assert.equal(openai.mapChatFinishReason('length'), 'max_tokens')
  assert.equal(openai.mapChatFinishReason('tool_calls'), 'tool_use')
  assert.equal(openai.mapChatFinishReason('function_call'), 'tool_use')
  assert.equal(openai.mapChatFinishReason('content_filter'), 'refusal')
  assert.equal(openai.mapChatFinishReason('insufficient_system_resource'), 'error')
})

/* ============================ Anthropic ============================ */

test('Anthropic 请求：max_tokens 必填兜底，未写参数不发送', () => {
  const compiled = anthropic.compileAnthropicRequest(profile({ protocol: 'anthropic-messages' }), {
    model: 'm',
    messages: [user('hi')],
  })
  assert.equal(compiled.url, 'https://api.example.com/v1/messages')
  assert.deepEqual(compiled.body, {
    model: 'm',
    max_tokens: 4096,
    messages: [{ role: 'user', content: 'hi' }],
    stream: true,
  })
  assert.deepEqual(compiled.headers, {
    'content-type': 'application/json',
    accept: 'text/event-stream',
    'x-api-key': 'sk-test',
    'anthropic-version': '2023-06-01',
  })
})

test('Anthropic 请求：maxOutputTokens / profile 默认 / topK / stop_sequences', () => {
  const compiled = anthropic.compileAnthropicRequest(
    profile({ protocol: 'anthropic-messages', defaultMaxOutputTokens: 2048 }),
    { model: 'm', messages: [user('hi')], maxOutputTokens: 100, topK: 40, stop: ['END'] }
  )
  assert.equal(compiled.body.max_tokens, 100)
  assert.equal(compiled.body.top_k, 40)
  assert.deepEqual(compiled.body.stop_sequences, ['END'])

  const fromProfile = anthropic.compileAnthropicRequest(
    profile({ protocol: 'anthropic-messages', defaultMaxOutputTokens: 2048 }),
    { model: 'm', messages: [] }
  )
  assert.equal(fromProfile.body.max_tokens, 2048)
})

test('Anthropic 请求：system 独立顶层字段并按 \\n\\n 合并，reminder 默认保留 latest_reminder 角色', () => {
  const compiled = anthropic.compileAnthropicRequest(profile({ protocol: 'anthropic-messages' }), {
    model: 'm',
    system: 'top',
    messages: [
      { role: 'system', content: 'second' },
      { role: 'system', content: '   ' },
      { role: 'reminder', content: 'rem' },
      user('q'),
    ],
  })
  assert.equal(compiled.body.system, 'top\n\nsecond')
  assert.deepEqual(compiled.body.messages, [
    { role: 'latest_reminder', content: 'rem' },
    { role: 'user', content: 'q' },
  ])
})

test('Anthropic 请求：reminderRole=system 时 reminder 并入 system 字段', () => {
  const compiled = anthropic.compileAnthropicRequest(
    profile({ protocol: 'anthropic-messages', reminderRole: 'system' }),
    { model: 'm', messages: [{ role: 'reminder', content: 'rem' }, user('q')] }
  )
  assert.equal(compiled.body.system, 'rem')
  assert.deepEqual(compiled.body.messages, [{ role: 'user', content: 'q' }])
})

test('Anthropic 请求：user 工具结果转成同一条 user 消息里的 tool_result 块', () => {
  const compiled = anthropic.compileAnthropicRequest(profile({ protocol: 'anthropic-messages' }), {
    model: 'm',
    messages: [
      { role: 'user', content: 'text', toolResults: [{ toolUseId: 't1', content: 'r', isError: true }] },
      { role: 'user', content: '', toolResults: [{ toolUseId: 't2', content: 'r2' }] },
    ],
  })
  assert.deepEqual(compiled.body.messages, [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'text' },
        { type: 'tool_result', tool_use_id: 't1', content: 'r', is_error: true },
      ],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't2', content: 'r2' }],
    },
  ])
})

test('Anthropic 请求：assistant 块回传规则（无签名思考丢弃、provider_block 同协议透传、tool_result 忽略）', () => {
  const compiled = anthropic.compileAnthropicRequest(profile({ protocol: 'anthropic-messages' }), {
    model: 'm',
    messages: [
      {
        role: 'assistant',
        blocks: [
          { type: 'text', text: 'answer' },
          { type: 'text', text: '' },
          { type: 'thinking', text: 'no signature' },
          { type: 'thinking', text: 'signed', signature: 'sig' },
          { type: 'tool_use', id: 't1', name: 'n', input: { a: 1 } },
          { type: 'tool_result', toolUseId: 'x', content: 'y' },
          { type: 'provider_block', protocol: 'anthropic-messages', payload: { type: 'web_search_tool_result' } },
          { type: 'provider_block', protocol: 'openai-chat', payload: { nope: true } },
        ],
      },
    ],
  })
  assert.deepEqual(compiled.body.messages, [
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'answer' },
        { type: 'thinking', thinking: 'signed', signature: 'sig' },
        { type: 'tool_use', id: 't1', name: 'n', input: { a: 1 } },
        { type: 'web_search_tool_result' },
      ],
    },
  ])
  assert.equal(compiled.warnings.length, 2)
})

test('Anthropic 请求：thinking 启用时给 budget，省略 temperature，top_k 按能力降级', () => {
  const compiled = anthropic.compileAnthropicRequest(profile({ protocol: 'anthropic-messages' }), {
    model: 'm',
    messages: [user('hi')],
    maxOutputTokens: 8000,
    temperature: 0.5,
    thinking: { enabled: true },
  })
  assert.deepEqual(compiled.body.thinking, { type: 'enabled', budget_tokens: 2048 })
  assert.equal('temperature' in compiled.body, false)
  assert.ok(compiled.warnings.some((warning) => warning.includes('temperature')))

  const disabled = anthropic.compileAnthropicRequest(profile({ protocol: 'anthropic-messages' }), {
    model: 'm',
    messages: [],
    temperature: 0.2,
    thinking: { enabled: false },
  })
  assert.deepEqual(disabled.body.thinking, { type: 'disabled' })
  assert.equal(disabled.body.temperature, 0.2)
})

test('Anthropic 请求：thinking budget 边界（显式合法值 / 小于 1024 / 不小于 max_tokens）', () => {
  const explicit = anthropic.compileAnthropicRequest(profile({ protocol: 'anthropic-messages' }), {
    model: 'm',
    messages: [],
    maxOutputTokens: 5000,
    thinking: { enabled: true, budgetTokens: 2000 },
  })
  assert.deepEqual(explicit.body.thinking, { type: 'enabled', budget_tokens: 2000 })

  expectConfigError(
    () =>
      anthropic.compileAnthropicRequest(profile({ protocol: 'anthropic-messages' }), {
        model: 'm',
        messages: [],
        thinking: { enabled: true, budgetTokens: 1023 },
      }),
    'budgetTokens'
  )
  assert.throws(
    () =>
      anthropic.compileAnthropicRequest(profile({ protocol: 'anthropic-messages' }), {
        model: 'm',
        messages: [],
        maxOutputTokens: 2000,
        thinking: { enabled: true, budgetTokens: 2000 },
      }),
    (error) => error.kind === 'config' && error.message.includes('maxOutputTokens')
  )
})

test('Anthropic 请求：不支持的能力（seed / penalties / topK）只告警不发送', () => {
  const compiled = anthropic.compileAnthropicRequest(profile({ protocol: 'anthropic-messages' }), {
    model: 'm',
    messages: [],
    seed: 1,
    presencePenalty: 0.1,
    frequencyPenalty: 0.2,
    topK: 5,
  })
  assert.equal('seed' in compiled.body, false)
  assert.equal('presence_penalty' in compiled.body, false)
  assert.equal('frequency_penalty' in compiled.body, false)
  assert.equal(compiled.body.top_k, 5)
  assert.equal(compiled.warnings.length, 2)

  const noTopK = anthropic.compileAnthropicRequest(
    profile({ protocol: 'anthropic-messages', capabilities: { sampling: { topK: false } } }),
    { model: 'm', messages: [], topK: 5 }
  )
  assert.equal('top_k' in noTopK.body, false)
})

test('Anthropic 请求：tools / tool_choice 映射', () => {
  const compiled = anthropic.compileAnthropicRequest(profile({ protocol: 'anthropic-messages' }), {
    model: 'm',
    messages: [],
    tools: [{ name: 'n', description: 'd', parameters: { type: 'object' } }],
    toolChoice: 'none',
  })
  assert.deepEqual(compiled.body.tools, [
    { name: 'n', description: 'd', input_schema: { type: 'object' } },
  ])
  assert.deepEqual(compiled.body.tool_choice, { type: 'none' })
})

test('Anthropic usage：输入侧不含缓存，total 含三项缓存；message_delta 缺失字段沿用 message_start', () => {
  assert.deepEqual(
    anthropic.normalizeAnthropicUsage({
      input_tokens: 10,
      cache_read_input_tokens: 4,
      cache_creation_input_tokens: 2,
      output_tokens: 6,
      server_tool_use: { web_search_requests: 1, ignored: 'x' },
    }),
    {
      inputTokens: 10,
      cacheReadTokens: 4,
      cacheWriteTokens: 2,
      outputTokens: 6,
      serverToolUse: { web_search_requests: 1 },
      totalTokens: 22,
    }
  )
  const previous = {
    inputTokens: 10,
    cacheReadTokens: 4,
    cacheWriteTokens: 2,
    outputTokens: 0,
    serverToolUse: { web_search_requests: 1 },
  }
  assert.deepEqual(anthropic.normalizeAnthropicUsage({ output_tokens: 3 }, previous), {
    inputTokens: 10,
    cacheReadTokens: 4,
    cacheWriteTokens: 2,
    outputTokens: 3,
    serverToolUse: { web_search_requests: 1 },
    totalTokens: 19,
  })
})

test('Anthropic stop_reason 映射与引用归一化', () => {
  assert.equal(anthropic.mapAnthropicStopReason('max_tokens'), 'max_tokens')
  assert.equal(anthropic.mapAnthropicStopReason('model_context_window_exceeded'), 'max_tokens')
  assert.equal(anthropic.mapAnthropicStopReason('tool_use'), 'tool_use')
  assert.equal(anthropic.mapAnthropicStopReason('refusal'), 'refusal')
  assert.equal(anthropic.mapAnthropicStopReason('stop_sequence'), 'stop_sequence')
  assert.equal(anthropic.mapAnthropicStopReason('end_turn'), 'end_turn')
  assert.equal(anthropic.mapAnthropicStopReason('pause_turn'), 'end_turn')
  assert.equal(anthropic.mapAnthropicStopReason('unknown'), 'end_turn')

  assert.deepEqual(
    anthropic.toAnthropicCitation({
      url: 'https://a.example',
      title: 'A',
      cited_text: 'quote',
    }),
    { url: 'https://a.example', title: 'A', citedText: 'quote' }
  )
  assert.deepEqual(anthropic.toAnthropicCitation({ url: 'https://a.example' }), {
    url: 'https://a.example',
    title: null,
  })
  assert.equal(anthropic.toAnthropicCitation({ title: 'no url' }), null)
  assert.equal(anthropic.toAnthropicCitation(null), null)
})

/* ============================ OpenAI Responses ============================ */

test('Responses 请求：最小请求体含 store:false，无 instructions / 采样字段', () => {
  const compiled = responses.compileResponsesRequest(
    profile({ protocol: 'openai-responses' }),
    { model: 'm', messages: [user('hi')] }
  )
  assert.equal(compiled.url, 'https://api.example.com/v1/responses')
  assert.deepEqual(compiled.body, {
    model: 'm',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
    stream: true,
    store: false,
  })
  assert.deepEqual(compiled.warnings, [])
})

test('Responses 请求：参数映射与不支持能力的告警', () => {
  const compiled = responses.compileResponsesRequest(
    profile({ protocol: 'openai-responses' }),
    {
      model: 'm',
      messages: [],
      maxOutputTokens: 64,
      temperature: 0.4,
      topP: 0.9,
      topK: 2,
      stop: ['END'],
      seed: 1,
      presencePenalty: 0.1,
      frequencyPenalty: 0.2,
    }
  )
  assert.equal(compiled.body.max_output_tokens, 64)
  assert.equal(compiled.body.temperature, 0.4)
  assert.equal(compiled.body.top_p, 0.9)
  for (const key of ['top_k', 'stop', 'seed', 'presence_penalty', 'frequency_penalty']) {
    assert.equal(key in compiled.body, false)
  }
  assert.equal(compiled.warnings.length, 4)
})

test('Responses 请求：thinking 启用时 reasoning.effort 缺省 medium，关闭时不发送', () => {
  const enabled = responses.compileResponsesRequest(
    profile({ protocol: 'openai-responses' }),
    { model: 'm', messages: [], thinking: { enabled: true } }
  )
  assert.deepEqual(enabled.body.reasoning, { effort: 'medium' })
  const effort = responses.compileResponsesRequest(
    profile({ protocol: 'openai-responses' }),
    { model: 'm', messages: [], thinking: { enabled: true, effort: 'low' } }
  )
  assert.deepEqual(effort.body.reasoning, { effort: 'low' })
  const disabled = responses.compileResponsesRequest(
    profile({ protocol: 'openai-responses' }),
    { model: 'm', messages: [], thinking: { enabled: false } }
  )
  assert.equal('reasoning' in disabled.body, false)
})

test('Responses 请求：system 合并进 instructions，reminder 降级为 developer 消息', () => {
  const compiled = responses.compileResponsesRequest(
    profile({ protocol: 'openai-responses' }),
    {
      model: 'm',
      system: 'top',
      messages: [
        { role: 'system', content: 'second' },
        { role: 'reminder', content: 'rem' },
        user('q'),
      ],
    }
  )
  assert.equal(compiled.body.instructions, 'top\n\nsecond')
  assert.deepEqual(compiled.body.input, [
    { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'rem' }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'q' }] },
  ])
})

test('Responses 请求：assistant 历史编译成 message / function_call / function_call_output 顺序不变', () => {
  const compiled = responses.compileResponsesRequest(
    profile({ protocol: 'openai-responses' }),
    {
      model: 'm',
      messages: [
        {
          role: 'assistant',
          blocks: [
            { type: 'text', text: 'part 1' },
            { type: 'text', text: ' + part 2' },
            { type: 'tool_use', id: 'call_1', name: 'n', input: { a: 1 } },
            { type: 'text', text: 'after tool' },
            { type: 'thinking', text: 'dropped' },
            { type: 'tool_result', toolUseId: 'call_1', content: { ok: true } },
          ],
        },
      ],
    }
  )
  assert.deepEqual(compiled.body.input, [
    {
      type: 'message',
      role: 'assistant',
      content: [
        { type: 'output_text', text: 'part 1' },
        { type: 'output_text', text: ' + part 2' },
      ],
    },
    { type: 'function_call', call_id: 'call_1', name: 'n', arguments: '{"a":1}' },
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'after tool' }],
    },
    { type: 'function_call_output', call_id: 'call_1', output: '{"ok":true}' },
  ])
})

test('Responses 请求：user 工具结果 + 正文；provider_block 同协议透传、跨协议忽略', () => {
  const compiled = responses.compileResponsesRequest(
    profile({ protocol: 'openai-responses' }),
    {
      model: 'm',
      messages: [
        {
          role: 'user',
          content: 'follow up',
          files: [{ type: 'document', mimeType: 'text/plain', filename: 'a.txt', fileId: 'f' }],
          toolResults: [{ toolUseId: 'c1', content: 'r' }],
        },
        {
          role: 'assistant',
          blocks: [
            { type: 'provider_block', protocol: 'openai-responses', payload: { type: 'web_search_call' } },
            { type: 'provider_block', protocol: 'anthropic-messages', payload: { nope: true } },
          ],
        },
      ],
    }
  )
  assert.deepEqual(compiled.body.input, [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'follow up' }] },
    { type: 'function_call_output', call_id: 'c1', output: 'r' },
    { type: 'web_search_call' },
  ])
  assert.ok(compiled.warnings.some((warning) => warning.includes('附件')))
  assert.ok(compiled.warnings.some((warning) => warning.includes('provider_block')))
})

test('Responses 请求：tools 映射与 extraBody', () => {
  const compiled = responses.compileResponsesRequest(
    profile({ protocol: 'openai-responses', extraBody: { safety_check: true } }),
    {
      model: 'm',
      messages: [],
      tools: [{ name: 'n', description: 'd', parameters: { type: 'object' } }],
      toolChoice: 'auto',
    }
  )
  assert.deepEqual(compiled.body.tools, [
    { type: 'function', name: 'n', description: 'd', parameters: { type: 'object' } },
  ])
  assert.equal(compiled.body.tool_choice, 'auto')
  assert.equal(compiled.body.safety_check, true)
})

test('Responses usage / 引用 / finish 原因', () => {
  assert.deepEqual(
    responses.normalizeResponsesUsage({
      input_tokens: 100,
      input_tokens_details: { cached_tokens: 40 },
      output_tokens: 10,
      output_tokens_details: { reasoning_tokens: 4 },
      total_tokens: 150,
    }),
    {
      inputTokens: 60,
      cacheReadTokens: 40,
      cacheWriteTokens: 0,
      outputTokens: 10,
      reasoningTokens: 4,
      totalTokens: 150,
    }
  )
  assert.deepEqual(responses.toResponsesCitation({
    type: 'url_citation',
    url: 'https://a.example',
    title: 'A',
    start_index: 3,
    end_index: 9,
  }), {
    url: 'https://a.example',
    title: 'A',
    startOffset: 3,
    endOffset: 9,
  })
  assert.equal(responses.toResponsesCitation({ type: 'other', url: 'https://a.example' }), null)
  assert.equal(responses.toResponsesCitation({ type: 'url_citation' }), null)
})

/* ============================ 错误分类与参数校验 ============================ */

test('readNestedErrorPayload：三种 wire 形态与 2000 字截断', () => {
  assert.deepEqual(
    errors.readNestedErrorPayload({ error: { message: 'boom', type: 't', code: 'c' } }),
    { type: 't', code: 'c', message: 'boom' }
  )
  assert.deepEqual(errors.readNestedErrorPayload({ error: { message: 'm' }, message: 'outer' }), {
    type: undefined,
    code: undefined,
    message: 'm',
  })
  // 空字符串不会被外层 message 兜底（只认 undefined）
  assert.deepEqual(errors.readNestedErrorPayload({ error: { message: '' }, message: 'outer' }), {
    type: undefined,
    code: undefined,
    message: '',
  })
  assert.deepEqual(errors.readNestedErrorPayload({ error: {}, message: 'outer' }), {
    type: undefined,
    code: undefined,
    message: 'outer',
  })
  const long = errors.readNestedErrorPayload({ error: { message: 'x'.repeat(2500) } })
  assert.equal(long.message.length, 2001)
  assert.ok(long.message.endsWith('…'))
  assert.equal(errors.readNestedErrorPayload('nope'), null)
  assert.equal(errors.readNestedErrorPayload({ error: 'nope' }), null)
})

test('readResponsesStreamError：扁平 error 与 response.failed', () => {
  assert.deepEqual(errors.readResponsesStreamError({ type: 'error', code: 'c', message: 'm' }), {
    code: 'c',
    message: 'm',
  })
  assert.deepEqual(
    errors.readResponsesStreamError({
      type: 'response.failed',
      response: { error: { code: 'x', message: 'failed' } },
    }),
    { code: 'x', message: 'failed' }
  )
  assert.equal(errors.readResponsesStreamError({ type: 'response.failed', response: {} }), null)
  assert.equal(errors.readResponsesStreamError(null), null)
})

test('parseRetryAfter：秒数 / HTTP-date / 非法值', () => {
  assert.equal(errors.parseRetryAfter('120'), 120000)
  assert.equal(errors.parseRetryAfter('0'), 0)
  assert.equal(errors.parseRetryAfter(''), undefined)
  assert.equal(errors.parseRetryAfter(null), undefined)
  assert.equal(errors.parseRetryAfter('not a date'), undefined)
  const future = new Date(Date.now() + 30_000).toUTCString()
  const ms = errors.parseRetryAfter(future)
  assert.ok(ms !== undefined && ms > 25_000 && ms <= 31_000, `got ${ms}`)
  // 过去的日期夹到 0
  assert.equal(errors.parseRetryAfter(new Date(0).toUTCString()), 0)
})

test('createHttpError：优先响应体错误消息，回退状态文本，带状态与 Retry-After', () => {
  const fromJson = errors.createHttpError({
    status: 429,
    statusText: 'Too Many Requests',
    body: JSON.stringify({ error: { message: 'slow down', type: 'rate_limit', code: 'rl' } }),
    retryAfter: '5',
    protocol: 'openai-chat',
  })
  assert.equal(fromJson.name, 'ProviderHttpError')
  assert.equal(fromJson.kind, 'http')
  assert.equal(fromJson.status, 429)
  assert.equal(fromJson.message, 'slow down')
  assert.deepEqual(fromJson.provider, {
    protocol: 'openai-chat',
    type: 'rate_limit',
    code: 'rl',
    message: 'slow down',
  })
  assert.equal(fromJson.retryAfterMs, 5000)

  const fromText = errors.createHttpError({
    status: 500,
    statusText: '',
    body: '  upstream exploded  ',
    protocol: 'anthropic-messages',
  })
  assert.equal(fromText.message, 'upstream exploded')
  assert.equal(fromText.status, 500)
  assert.equal(fromText.retryAfterMs, undefined)

  const empty = errors.createHttpError({
    status: 503,
    statusText: 'Service Unavailable',
    body: '',
    protocol: 'openai-responses',
  })
  assert.equal(empty.message, 'Service Unavailable')
})

test('各类 ProviderError 的 kind / provider 字段', () => {
  const network = errors.createNetworkError(new Error('offline'), 'openai-chat')
  assert.equal(network.kind, 'network')
  assert.equal(network.message, 'offline')
  assert.equal(network.provider.protocol, 'openai-chat')

  const interrupted = errors.createInterruptedError('anthropic-messages')
  assert.equal(interrupted.kind, 'interrupted')
  assert.equal(interrupted.provider.message, 'stream interrupted before terminal event')

  const protocol = errors.createProtocolError('bad content type', 'openai-responses')
  assert.equal(protocol.kind, 'protocol')
  assert.equal(protocol.message, 'bad content type')

  const stream = errors.createStreamError('anthropic-messages', { type: 'overloaded_error', message: '' })
  assert.equal(stream.kind, 'stream')
  assert.equal(stream.message, 'stream error')
  assert.equal(stream.provider.type, 'overloaded_error')

  assert.equal(errors.providerConfigError('bad config').kind, 'config')
  assert.equal(errors.isProviderError(network), true)
  assert.equal(errors.isProviderErrorLike(stream), true)
  assert.equal(errors.isProviderErrorLike({ kind: 'bogus', message: 'm' }), false)
})

test('classifyProviderError：配额 / 上下文 / 鉴权 / 限流 / 服务繁忙与 HTTP 状态兜底', () => {
  const classify = errors.classifyProviderError
  const httpError = (status, type, code, message) => ({
    kind: 'http',
    message: message ?? '',
    status,
    provider: { protocol: 'openai-chat', type, code, message: message ?? '' },
  })

  // 429 + insufficient_quota：余额不足，且不可重试（不能对配额耗尽做退避）
  assert.deepEqual(classify(httpError(429, undefined, 'insufficient_quota'), 'openai-chat'), {
    condition: 'insufficientBalance',
    retryable: false,
  })
  // Anthropic 400 的 credit balance 文案同样归为余额不足
  assert.equal(
    classify(httpError(400, 'invalid_request_error', undefined, 'credit balance is too low'), 'anthropic-messages')
      .condition,
    'insufficientBalance'
  )
  // 上下文超限 → tooLarge，不可重试
  assert.deepEqual(
    classify(httpError(400, 'invalid_request_error', 'context_length_exceeded'), 'openai-chat'),
    { condition: 'tooLarge', retryable: false }
  )
  // 鉴权
  assert.equal(classify(httpError(401), 'openai-chat').condition, 'unauthorized')
  assert.equal(classify(httpError(403, 'authentication_error'), 'anthropic-messages').condition, 'unauthorized')
  // 限流 / 服务繁忙可重试
  assert.deepEqual(classify(httpError(429), 'openai-chat'), { condition: 'rateLimited', retryable: true })
  assert.deepEqual(classify(httpError(503), 'openai-chat'), { condition: 'serverBusy', retryable: true })
  assert.deepEqual(classify(httpError(529, 'overloaded_error'), 'anthropic-messages'), {
    condition: 'serverBusy',
    retryable: true,
  })
  // 413 太大
  assert.equal(classify(httpError(413), 'openai-chat').condition, 'tooLarge')
  // 其他 4xx 不重试
  assert.deepEqual(classify(httpError(400), 'openai-chat'), { condition: 'other', retryable: false })

  // 网络类可重试
  assert.deepEqual(classify(errors.createNetworkError('offline', 'openai-chat'), 'openai-chat'), {
    condition: 'network',
    retryable: true,
  })
  // 流内错误没有状态码：按协议已知 code 分类
  assert.deepEqual(
    classify(errors.createStreamError('anthropic-messages', { type: 'overloaded_error', message: '' }), 'anthropic-messages'),
    { condition: 'serverBusy', retryable: true }
  )
  assert.deepEqual(
    classify(errors.createStreamError('openai-chat', { code: 'server_error', message: '' }), 'openai-chat'),
    { condition: 'serverBusy', retryable: true }
  )
  assert.deepEqual(
    classify(errors.createStreamError('openai-chat', { message: 'Too many requests' }), 'openai-chat'),
    { condition: 'rateLimited', retryable: true }
  )
  // 非结构化错误：只按 status 兜底
  assert.equal(classify({ status: 429 }, 'openai-chat').condition, 'rateLimited')
  assert.equal(classify({}, 'openai-chat').condition, 'other')
  assert.equal(classify('boom', 'openai-chat').condition, 'other')
  // retryAfterMs 透传
  const limited = errors.classifyProviderError(
    { ...httpError(429), retryAfterMs: 3000 },
    'openai-chat'
  )
  assert.equal(limited.retryAfterMs, 3000)
  assert.equal(errors.isRetryableProviderError(httpError(500), 'openai-chat'), true)
  assert.equal(errors.isRetryableProviderError(httpError(400), 'openai-chat'), false)
})

test('请求参数校验辅助：数值区间 / 整数下限 / stop 序列', () => {
  assert.doesNotThrow(() => errors.assertNumberInRange('t', undefined, 0, 2))
  assert.doesNotThrow(() => errors.assertNumberInRange('t', 0, 0, 2))
  expectConfigError(() => errors.assertNumberInRange('t', 3, 0, 2), 't')
  expectConfigError(() => errors.assertNumberInRange('t', Number.NaN, 0, 2), 't')

  assert.equal(errors.assertIntegerAtLeast('n', undefined, 1), undefined)
  assert.equal(errors.assertIntegerAtLeast('n', 3, 1), 3)
  expectConfigError(() => errors.assertIntegerAtLeast('n', 0, 1), 'n')
  expectConfigError(() => errors.assertIntegerAtLeast('n', 1.5, 1), 'n')

  const warnings = []
  assert.equal(errors.readStopSequences('stop', undefined, 4, warnings), undefined)
  assert.equal(errors.readStopSequences('stop', [], 4, warnings), undefined)
  assert.deepEqual(errors.readStopSequences('stop', ['a', 'b'], 4, warnings), ['a', 'b'])
  assert.deepEqual(errors.readStopSequences('stop', ['1', '2', '3', '4', '5'], 4, warnings), [
    '1',
    '2',
    '3',
    '4',
  ])
  assert.equal(warnings.length, 1)
  expectConfigError(() => errors.readStopSequences('stop', [''], 4, []), 'stop')
  expectConfigError(() => errors.readStopSequences('stop', [1], 4, []), 'stop')
})

test('resolveCapabilities：sampling 逐字段合并，其余能力整体覆盖', () => {
  assert.deepEqual(types.resolveCapabilities(profile()).sampling, {
    temperatureMax: 2,
    topK: false,
    seed: true,
    penalties: true,
  })
  const resolved = types.resolveCapabilities(
    profile({ capabilities: { thinking: 'none', sampling: { seed: false } } })
  )
  assert.equal(resolved.thinking, 'none')
  assert.equal(resolved.sampling.seed, false)
  assert.equal(resolved.sampling.temperatureMax, 2)
})

test('toolArgumentsJson / toolResultText：字符串原样，其它值稳定序列化，循环引用回退', () => {
  assert.equal(types.toolArgumentsJson('{"raw":1}'), '{"raw":1}')
  assert.equal(types.toolArgumentsJson({ a: 1 }), '{"a":1}')
  assert.equal(types.toolArgumentsJson(undefined), '{}')
  const circular = {}
  circular.self = circular
  assert.equal(types.toolArgumentsJson(circular), '{}')

  assert.equal(types.toolResultText('raw'), 'raw')
  assert.equal(types.toolResultText({ ok: true }), '{"ok":true}')
  assert.equal(types.toolResultText(undefined), '""')
  assert.equal(types.toolResultText(circular), '')
})
