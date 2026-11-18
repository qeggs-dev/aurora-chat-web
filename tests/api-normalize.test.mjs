// Base URL normalization and endpoint building (src/services/api/providers/normalize.ts):
// version path filling, pasted-endpoint stripping, templates, query and validation errors.
import assert from 'node:assert/strict'
import { test } from 'node:test'

const {
  MODELS_PATH,
  PROTOCOL_PATHS,
  buildEndpointUrl,
  buildModelsUrl,
  normalizeBaseUrl,
  resolveBaseUrl,
} = await import('../.test-build/services/api/providers/normalize.js')

const profile = (overrides = {}) => ({
  id: 'p',
  label: 'P',
  protocol: 'openai-chat',
  baseUrl: 'https://api.example.com',
  apiKey: 'sk-test',
  model: 'm',
  ...overrides,
})

const expectConfigError = (fn) => {
  assert.throws(fn, (error) => {
    assert.equal(error.kind, 'config')
    return true
  })
}

test('协议路径表与 models 路径常量', () => {
  assert.deepEqual(PROTOCOL_PATHS, {
    'openai-chat': '/chat/completions',
    'anthropic-messages': '/messages',
    'openai-responses': '/responses',
  })
  assert.equal(MODELS_PATH, '/models')
})

test('缺版本段时补 /v1，已有版本段原样保留', () => {
  assert.equal(normalizeBaseUrl('https://api.deepseek.com'), 'https://api.deepseek.com/v1')
  assert.equal(normalizeBaseUrl('https://api.deepseek.com/'), 'https://api.deepseek.com/v1')
  assert.equal(normalizeBaseUrl('https://api.example.com/v1'), 'https://api.example.com/v1')
  assert.equal(normalizeBaseUrl('https://api.example.com/v1/'), 'https://api.example.com/v1')
  assert.equal(normalizeBaseUrl('https://api.example.com/v1beta'), 'https://api.example.com/v1beta')
  assert.equal(normalizeBaseUrl('https://api.example.com/v2'), 'https://api.example.com/v2')
  assert.equal(normalizeBaseUrl('  https://api.example.com  '), 'https://api.example.com/v1')
})

test('/anthropic 这类非版本前缀原样保留并补 /v1', () => {
  assert.equal(
    normalizeBaseUrl('https://api.deepseek.com/anthropic'),
    'https://api.deepseek.com/anthropic/v1'
  )
})

test('粘贴完整端点时剥掉端点后缀，避免出现重复路径', () => {
  assert.equal(
    normalizeBaseUrl('https://api.example.com/v1/chat/completions'),
    'https://api.example.com/v1'
  )
  assert.equal(normalizeBaseUrl('https://api.example.com/v1/messages'), 'https://api.example.com/v1')
  assert.equal(normalizeBaseUrl('https://api.example.com/v1/responses'), 'https://api.example.com/v1')
  assert.equal(normalizeBaseUrl('https://api.example.com/v1/models'), 'https://api.example.com/v1')
  assert.equal(normalizeBaseUrl('https://api.example.com/chat/completions'), 'https://api.example.com/v1')
  assert.equal(
    normalizeBaseUrl('https://api.example.com/v1/chat/completions/'),
    'https://api.example.com/v1'
  )
})

test('endpointTemplate 接管版本段：不自动补 /v1', () => {
  assert.equal(
    normalizeBaseUrl('https://x.openai.azure.com', { endpointTemplate: '{base}{path}' }),
    'https://x.openai.azure.com'
  )
  // 端点后缀仍会被剥掉
  assert.equal(
    normalizeBaseUrl('https://x.openai.azure.com/openai/deployments/m/chat/completions', {
      endpointTemplate: '{base}{path}',
    }),
    'https://x.openai.azure.com/openai/deployments/m'
  )
})

test('versionPath=never 不补版本段；auto 行为；always 对非版本段同样补 /v1', () => {
  assert.equal(
    normalizeBaseUrl('https://api.example.com', { versionPath: 'never' }),
    'https://api.example.com'
  )
  assert.equal(
    normalizeBaseUrl('https://api.example.com/foo', { versionPath: 'never' }),
    'https://api.example.com/foo'
  )
  assert.equal(normalizeBaseUrl('https://api.example.com/foo', { versionPath: 'auto' }), 'https://api.example.com/foo/v1')
  assert.equal(normalizeBaseUrl('https://api.example.com/foo', { versionPath: 'always' }), 'https://api.example.com/foo/v1')
})

test('非法 baseUrl：空串 / 非 URL / 非 http(s) / query / hash / 连续斜杠', () => {
  expectConfigError(() => normalizeBaseUrl(''))
  expectConfigError(() => normalizeBaseUrl('   '))
  expectConfigError(() => normalizeBaseUrl('not a url'))
  expectConfigError(() => normalizeBaseUrl('ftp://example.com'))
  expectConfigError(() => normalizeBaseUrl('https://example.com?key=1'))
  expectConfigError(() => normalizeBaseUrl('https://example.com#frag'))
  expectConfigError(() => normalizeBaseUrl('https://example.com//v1'))
})

test('resolveBaseUrl 透传 profile 的版本段策略与模板', () => {
  assert.equal(resolveBaseUrl(profile({ baseUrl: 'https://a.example.com/v1' })), 'https://a.example.com/v1')
  assert.equal(resolveBaseUrl(profile({ baseUrl: 'https://a.example.com/x' })), 'https://a.example.com/x/v1')
  assert.equal(
    resolveBaseUrl(profile({ baseUrl: 'https://a.example.com/x', versionPath: 'never' })),
    'https://a.example.com/x'
  )
  assert.equal(
    resolveBaseUrl(profile({ baseUrl: 'https://a.example.com/x', endpointTemplate: '{base}' })),
    'https://a.example.com/x'
  )
})

test('buildEndpointUrl 按协议默认拼接三种端点', () => {
  assert.equal(
    buildEndpointUrl(profile(), 'openai-chat'),
    'https://api.example.com/v1/chat/completions'
  )
  assert.equal(
    buildEndpointUrl(profile(), 'anthropic-messages'),
    'https://api.example.com/v1/messages'
  )
  assert.equal(
    buildEndpointUrl(profile(), 'openai-responses'),
    'https://api.example.com/v1/responses'
  )
  // 省略 protocol 时用 profile.protocol
  assert.equal(buildEndpointUrl(profile()), 'https://api.example.com/v1/chat/completions')
  assert.equal(
    buildEndpointUrl(profile({ protocol: 'anthropic-messages' })),
    'https://api.example.com/v1/messages'
  )
})

test('buildEndpointUrl：模板替换 {base}/{model}/{protocol}/{path}，query 显式追加', () => {
  const templated = profile({
    baseUrl: 'https://x.openai.azure.com',
    model: 'deploy-1',
    endpointTemplate: 'https://x.openai.azure.com/openai/deployments/{model}{path}',
    query: { 'api-version': '2024-01-01' },
  })
  assert.equal(
    buildEndpointUrl(templated, 'openai-chat'),
    'https://x.openai.azure.com/openai/deployments/deploy-1/chat/completions?api-version=2024-01-01'
  )
  const withProtocol = profile({
    baseUrl: 'https://x.example.com/v1',
    endpointTemplate: '{base}/{protocol}/{model}',
  })
  assert.equal(
    buildEndpointUrl(withProtocol, 'openai-responses'),
    'https://x.example.com/v1/openai-responses/m'
  )
})

test('query 追加时跳过空值，保留已有查询串分隔符', () => {
  const base = profile({ baseUrl: 'https://api.example.com/v1' })
  assert.equal(
    buildEndpointUrl({ ...base, query: { a: '1', empty: '', b: '2 3' } }),
    'https://api.example.com/v1/chat/completions?a=1&b=2+3'
  )
  const templated = profile({
    baseUrl: 'https://x.example.com',
    endpointTemplate: 'https://x.example.com/p?x=1',
    query: { y: '2' },
  })
  assert.equal(buildEndpointUrl(templated), 'https://x.example.com/p?x=1&y=2')
})

test('buildModelsUrl 用归一化 base + /models 并带 query', () => {
  assert.equal(buildModelsUrl(profile()), 'https://api.example.com/v1/models')
  assert.equal(
    buildModelsUrl(profile({ baseUrl: 'https://api.example.com/v1/models' })),
    'https://api.example.com/v1/models'
  )
  assert.equal(
    buildModelsUrl(profile({ query: { 'api-version': '9' } })),
    'https://api.example.com/v1/models?api-version=9'
  )
})
