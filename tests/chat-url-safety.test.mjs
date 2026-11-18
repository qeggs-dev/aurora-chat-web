// Source URL protocol whitelist (src/utils/url.ts + src/services/chat/view.ts): only http/https
// URLs may become rendered source links / citation badges; javascript:, data: etc. are dropped.
import assert from 'node:assert/strict'
import { test } from 'node:test'

const url = await import('../.test-build/utils/url.js')
const view = await import('../.test-build/services/chat/view.js')

test('isWebUrl：只放行 http / https', () => {
  assert.equal(url.isWebUrl('https://example.com/a'), true)
  assert.equal(url.isWebUrl('http://example.com'), true)
  assert.equal(url.isWebUrl('HTTPS://EXAMPLE.COM'), true)
  for (const value of [
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd',
    'mailto:a@b.c',
    '/relative/path',
    'not a url',
    '',
  ]) {
    assert.equal(url.isWebUrl(value), false, value)
  }
})

const citation = (value) => ({
  type: 'web_search_result_location',
  url: value,
  title: 'title',
  cited_text: '',
  encrypted_index: '',
})

const assistant = (blocks) => ({
  id: 'a1',
  role: 'assistant',
  createdAt: 0,
  model: null,
  prefix: true,
  status: 'done',
  blocks,
})

test('buildReplyView：非法协议的引用不登记来源，也不插入 citation 角标', () => {
  const result = view.buildReplyView(
    assistant([
      {
        type: 'text',
        text: 'answer',
        citations: [citation('javascript:alert(1)'), citation('https://ok.example/page')],
      },
    ]),
    false
  )
  assert.deepEqual(
    result.sources.map((source) => source.url),
    ['https://ok.example/page']
  )
  assert.equal(result.answer?.markdown, 'answer[citation:1]')
})

test('buildReplyView：搜索结果里的非法协议被过滤，只保留 http(s) 来源', () => {
  const result = view.buildReplyView(
    assistant([
      {
        type: 'server_tool_use',
        id: 'srvtoolu_1',
        name: 'deepseek_web_search',
        input: { action: 'search', queries: ['q'] },
        kind: 'search',
        caller: { type: 'direct' },
      },
      {
        type: 'web_search_tool_result',
        tool_use_id: 'srvtoolu_1',
        kind: 'search',
        content: [
          {
            type: 'web_search_result',
            url: 'data:text/html,evil',
            title: 'evil',
            snippet: '',
            site_icon: null,
            site_name: null,
            encrypted_content: '',
            page_age: null,
          },
          {
            type: 'web_search_result',
            url: 'https://ok.example/page',
            title: 'ok',
            snippet: 'ok',
            site_icon: 'javascript:alert(1)',
            site_name: 'ok',
            encrypted_content: '',
            page_age: null,
          },
        ],
      },
    ]),
    false
  )
  assert.deepEqual(
    result.sources.map((source) => source.url),
    ['https://ok.example/page']
  )
  assert.deepEqual(
    result.searchResults.map((source) => source.url),
    ['https://ok.example/page']
  )
  const searchStep = result.steps.find((step) => step.type === 'search')
  assert.deepEqual(
    searchStep.results.map((source) => source.url),
    ['https://ok.example/page']
  )
})
