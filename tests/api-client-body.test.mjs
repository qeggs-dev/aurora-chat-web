// Legacy DeepSeek Anthropic-compatible request construction (src/services/api/client.ts):
// parameter omission, thinking forcing rule, compatibility-mode stripping and the
// CanonicalRequest conversion used by the three-protocol provider path.
import assert from 'node:assert/strict'
import { test } from 'node:test'

globalThis.__API_ORIGIN__ = 'https://api.deepseek.com'

const { presetAnthropicBody, stripDeepseekExtensions, buildCanonicalRequest } = await import(
  '../.test-build/services/api/client.js'
)
const { resolvePreset } = await import('../.test-build/services/preset/types.js')

const preset = (overrides = {}) =>
  resolvePreset({ schema: 1, id: 'test-preset', name: 'Test preset', ...overrides })

const PROFILE = {
  id: 'test-preset',
  label: 'Test preset',
  protocol: 'anthropic-messages',
  baseUrl: 'https://api.deepseek.com/anthropic/v1',
  apiKey: 'sk-test',
  model: 'deepseek-flash',
  reminderRole: 'system',
}

const request = (overrides = {}) => ({
  model: 'request-model',
  messages: [{ role: 'user', content: 'hi' }],
  thinking: { type: 'disabled' },
  tools: [],
  safety_check: { level: 'high' },
  ...overrides,
})

/* ============================ presetAnthropicBody ============================ */

test('预设 Anthropic 请求体：只带预设显式参数，stream 强制 true', () => {
  const body = {
    model: 'request-model',
    max_tokens: 100,
    messages: [{ role: 'user', content: 'hi' }],
    thinking: { type: 'disabled' },
  }
  const wire = presetAnthropicBody(body, preset())
  assert.equal(wire.stream, true)
  // 预设没有覆盖 model 时沿用请求里的 model
  assert.equal(wire.model, 'request-model')
  assert.equal(wire.max_tokens, 100)
  for (const key of ['top_p', 'temperature', 'stop_sequences']) {
    assert.equal(key in wire, false, `${key} should not be added when preset omits it`)
  }
  // 返回新对象，不修改传入 body
  assert.equal(body.stream, undefined)
})

test('预设 Anthropic 请求体：显式 model / max_tokens / top_p / temperature / stop 写进 wire', () => {
  const wire = presetAnthropicBody(
    { model: 'request-model', max_tokens: 100, messages: [] },
    preset({
      model: 'preset-model',
      params: { max_tokens: 256, top_p: 0.7, temperature: 0.4, stop: ['A', 'B'] },
    })
  )
  assert.equal(wire.model, 'preset-model')
  assert.equal(wire.max_tokens, 256)
  assert.equal(wire.top_p, 0.7)
  assert.equal(wire.temperature, 0.4)
  assert.deepEqual(wire.stop_sequences, ['A', 'B'])
})

test('预设 Anthropic 请求体：空 stop 数组不发送 stop_sequences', () => {
  const wire = presetAnthropicBody(
    { model: 'm', max_tokens: 10, messages: [] },
    preset({ params: { stop: [] } })
  )
  assert.equal('stop_sequences' in wire, false)
})

test('预设 Anthropic 请求体：客户端工具强制开启 thinking 并省略 temperature', () => {
  const wire = presetAnthropicBody(
    {
      model: 'm',
      max_tokens: 100,
      messages: [],
      thinking: { type: 'disabled' },
      tools: [{ name: 'memory_write', description: 'd', input_schema: { type: 'object' } }],
    },
    preset({ params: { temperature: 0.5 } })
  )
  assert.deepEqual(wire.thinking, { type: 'enabled' })
  assert.equal('temperature' in wire, false)
})

test('预设 Anthropic 请求体：已开启 thinking 时同样不收 temperature；只有服务端工具不强制 thinking', () => {
  const thinkingOn = presetAnthropicBody(
    { model: 'm', max_tokens: 100, messages: [], thinking: { type: 'enabled' } },
    preset({ params: { temperature: 0.5 } })
  )
  assert.deepEqual(thinkingOn.thinking, { type: 'enabled' })
  assert.equal('temperature' in thinkingOn, false)

  const serverToolOnly = presetAnthropicBody(
    {
      model: 'm',
      max_tokens: 100,
      messages: [],
      thinking: { type: 'disabled' },
      tools: [{ type: 'deepseek_web_search', name: 'deepseek_web_search' }],
    },
    preset({ params: { temperature: 0.5 } })
  )
  assert.deepEqual(serverToolOnly.thinking, { type: 'disabled' })
  assert.equal(serverToolOnly.temperature, 0.5)
})

/* ============================ stripDeepseekExtensions ============================ */

test('兼容模式：移除 safety_check / title / 私有服务端工具 / latest_reminder / thinking.effort', () => {
  const body = {
    model: 'm',
    system: 'sys',
    stream: true,
    messages: [
      { role: 'latest_reminder', content: 'rem' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'a' },
    ],
    thinking: { type: 'enabled', effort: 'high' },
    safety_check: { level: 'high' },
    title: { enabled: true },
    tools: [
      { type: 'deepseek_web_search', name: 'deepseek_web_search' },
      { type: 'deepseek_read_url', name: 'deepseek_read_url' },
      { name: 'memory_write', description: 'd', input_schema: { type: 'object' } },
    ],
  }
  const stripped = stripDeepseekExtensions(body)
  assert.equal('safety_check' in stripped, false)
  assert.equal('title' in stripped, false)
  assert.deepEqual(stripped.thinking, { type: 'enabled' })
  assert.deepEqual(stripped.messages, [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'a' },
  ])
  // 只保留客户端工具
  assert.deepEqual(stripped.tools, [
    { name: 'memory_write', description: 'd', input_schema: { type: 'object' } },
  ])
  // 其它标准字段原样保留
  assert.equal(stripped.model, 'm')
  assert.equal(stripped.system, 'sys')
  assert.equal(stripped.stream, true)
  // 不修改输入
  assert.equal(body.safety_check.level, 'high')
  assert.equal(body.tools.length, 3)
})

test('兼容模式：工具全是私有服务端工具时整个 tools 字段删除；没有可删字段时原样返回副本', () => {
  const stripped = stripDeepseekExtensions({
    model: 'm',
    tools: [{ type: 'deepseek_web_search', name: 'deepseek_web_search' }],
    messages: [{ role: 'user', content: 'x' }],
  })
  assert.equal('tools' in stripped, false)

  const plain = { model: 'm', messages: [{ role: 'user', content: 'x' }] }
  const copy = stripDeepseekExtensions(plain)
  assert.deepEqual(copy, plain)
  assert.notEqual(copy, plain)
})

test('兼容模式：非数组 tools / messages 与非对象 thinking 不做处理', () => {
  const stripped = stripDeepseekExtensions({ tools: 'nope', messages: null, thinking: 'enabled' })
  assert.equal(stripped.tools, 'nope')
  assert.equal(stripped.messages, null)
  assert.equal(stripped.thinking, 'enabled')
})

/* ============================ buildCanonicalRequest ============================ */

test('CanonicalRequest：model 用预设模型，未填参数一律省略', () => {
  const canonical = buildCanonicalRequest(request(), preset(), PROFILE, false)
  assert.equal(canonical.model, 'deepseek-flash')
  assert.equal(canonical.stream, true)
  assert.equal('system' in canonical, false)
  assert.deepEqual(canonical.messages, [{ role: 'user', content: 'hi' }])
  assert.equal('tools' in canonical, false)
  assert.equal('maxOutputTokens' in canonical, false)
  assert.equal('temperature' in canonical, false)
  assert.equal('topP' in canonical, false)
  assert.equal('stop' in canonical, false)
  assert.deepEqual(canonical.thinking, { enabled: false })
})

test('CanonicalRequest：显式采样参数逐项映射，空 stop 条目不发送', () => {
  const canonical = buildCanonicalRequest(
    request(),
    preset({
      params: {
        max_tokens: 128,
        temperature: 0.3,
        top_p: 0.9,
        stop: ['END', '  ', 'STOP'],
        seed: 5,
        presence_penalty: -0.1,
        frequency_penalty: 0.2,
      },
    }),
    PROFILE,
    false
  )
  assert.equal(canonical.maxOutputTokens, 128)
  assert.equal(canonical.temperature, 0.3)
  assert.equal(canonical.topP, 0.9)
  assert.deepEqual(canonical.stop, ['END', 'STOP'])
  assert.equal(canonical.seed, 5)
  assert.equal(canonical.presencePenalty, -0.1)
  assert.equal(canonical.frequencyPenalty, 0.2)
})

test('CanonicalRequest：system 空白省略，非空保留原文', () => {
  const omitted = buildCanonicalRequest(request({ system: '   ' }), preset(), PROFILE, false)
  assert.equal('system' in omitted, false)
  const kept = buildCanonicalRequest(request({ system: '  hello  ' }), preset(), PROFILE, false)
  assert.equal(kept.system, '  hello  ')
})

test('CanonicalRequest：客户端工具映射，服务端工具丢弃', () => {
  const canonical = buildCanonicalRequest(
    request({
      tools: [
        { type: 'deepseek_web_search', name: 'deepseek_web_search' },
        { name: 'memory_search', description: 'd', input_schema: { type: 'object' } },
      ],
    }),
    preset(),
    PROFILE,
    false
  )
  assert.deepEqual(canonical.tools, [
    { name: 'memory_search', description: 'd', parameters: { type: 'object' } },
  ])
  assert.equal(canonical.toolChoice, 'auto')
})

test('CanonicalRequest：latest_reminder 在普通模式下保留为 reminder，兼容模式下过滤', () => {
  const messages = [
    { role: 'latest_reminder', content: 'rem' },
    { role: 'user', content: 'q' },
  ]
  const normal = buildCanonicalRequest(request({ messages }), preset(), PROFILE, false)
  assert.deepEqual(normal.messages, [
    { role: 'reminder', content: 'rem' },
    { role: 'user', content: 'q' },
  ])
  const compatible = buildCanonicalRequest(request({ messages }), preset(), PROFILE, true)
  assert.deepEqual(compatible.messages, [{ role: 'user', content: 'q' }])
})

test('CanonicalRequest：thinking 开启时普通模式带 reasoning_effort，兼容模式不带', () => {
  const presetWithEffort = preset({ params: { reasoning_effort: 'high' } })
  const normal = buildCanonicalRequest(
    request({ thinking: { type: 'enabled' } }),
    presetWithEffort,
    PROFILE,
    false
  )
  assert.deepEqual(normal.thinking, { enabled: true, effort: 'high' })

  const compatible = buildCanonicalRequest(
    request({ thinking: { type: 'enabled' } }),
    presetWithEffort,
    PROFILE,
    true
  )
  assert.deepEqual(compatible.thinking, { enabled: true })

  // thinking 关闭时不带 effort
  const disabled = buildCanonicalRequest(request(), presetWithEffort, PROFILE, false)
  assert.deepEqual(disabled.thinking, { enabled: false })
})

test('CanonicalRequest：user 内容块转成正文 + 附件 + 工具结果', () => {
  const canonical = buildCanonicalRequest(
    request({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'line 1' },
            { type: 'text', text: 'line 2' },
            { type: 'image', source: { type: 'file', file_id: 'file_img' } },
            { type: 'document', source: { type: 'file', file_id: 'file_doc' } },
            {
              type: 'tool_result',
              tool_use_id: 'toolu_1',
              content: '{"ok":true}',
              is_error: true,
            },
          ],
        },
      ],
    }),
    preset(),
    PROFILE,
    false
  )
  assert.deepEqual(canonical.messages, [
    {
      role: 'user',
      content: 'line 1\n\nline 2',
      files: [
        { type: 'image', mimeType: 'application/octet-stream', fileId: 'file_img' },
        {
          type: 'document',
          mimeType: 'application/octet-stream',
          filename: 'file_doc',
          fileId: 'file_doc',
        },
      ],
      toolResults: [{ toolUseId: 'toolu_1', content: '{"ok":true}', isError: true }],
    },
  ])
})

test('CanonicalRequest：assistant 块转成统一块，服务端工具块转 provider_block', () => {
  const canonical = buildCanonicalRequest(
    request({
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'answer' },
            { type: 'thinking', thinking: 'why', signature: 'sig' },
            { type: 'tool_use', id: 'toolu_1', name: 'memory_write', input: { content: 'x' } },
            {
              type: 'server_tool_use',
              id: 'srv_1',
              name: 'deepseek_web_search',
              kind: 'search',
              input: { action: 'search', queries: ['q'] },
            },
          ],
        },
      ],
    }),
    preset(),
    PROFILE,
    false
  )
  assert.deepEqual(canonical.messages[0].blocks, [
    { type: 'text', text: 'answer' },
    { type: 'thinking', text: 'why', signature: 'sig' },
    { type: 'tool_use', id: 'toolu_1', name: 'memory_write', input: { content: 'x' } },
    {
      type: 'provider_block',
      protocol: 'anthropic-messages',
      payload: {
        type: 'server_tool_use',
        id: 'srv_1',
        name: 'deepseek_web_search',
        kind: 'search',
        input: { action: 'search', queries: ['q'] },
      },
    },
  ])
})
