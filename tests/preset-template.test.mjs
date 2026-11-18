// Prompt template rendering (src/services/preset/template.ts):
// all supported variables, literal passthrough, unknown variables kept, single-pass insertion.
import assert from 'node:assert/strict'
import { test } from 'node:test'

globalThis.__API_ORIGIN__ = 'https://api.deepseek.com'

const template = await import('../.test-build/services/preset/template.js')
const types = await import('../.test-build/services/preset/types.js')

const {
  BUILTIN_DEFAULT_PRESET_NAME,
  PRESET_TEMPLATE_VARIABLES,
  presetDump,
  presetTemplateValues,
  renderPromptTemplate,
} = template

const ENV = {
  platform: 'Windows',
  app: 'Aurora Chat',
  version: '9.9.9',
  locale: 'zh-CN',
  theme: 'dark',
}

const resolved = types.resolvePreset({
  schema: 1,
  id: 'preset-x',
  name: 'X preset',
  protocol: 'openai',
  base_url: 'https://api.example.com/v1/',
  model: 'model-x',
  params: { temperature: 0.5, stop: ['END'] },
  compaction: { enabled: false },
  memory: { max_results: 3 },
})

test('没有变量时输出与输入逐字相同（含普通花括号 / 单个花括号）', () => {
  const inputs = [
    '',
    'You are helpful.',
    'Use {single} braces, { not templates }.',
    'JSON: {"a": 1}',
    '{{ not-a-closed-variable',
    'line1\nline2\r\nline3\t',
  ]
  for (const input of inputs) {
    assert.equal(renderPromptTemplate(input, resolved, ENV), input)
  }
})

test('preset.* 变量全部替换成生效预设的实际值', () => {
  const text = [
    'name={{preset.name}}',
    'id={{preset.id}}',
    'protocol={{preset.protocol}}',
    'base={{preset.base_url}}',
    'model={{preset.model}}',
    'params={{preset.params}}',
    'memory={{preset.memory}}',
    'compaction={{preset.compaction}}',
  ].join('|')
  const output = renderPromptTemplate(text, resolved, ENV)
  assert.equal(
    output,
    [
      'name=X preset',
      'id=preset-x',
      'protocol=openai',
      'base=https://api.example.com/v1',
      'model=model-x',
      'params={"temperature":0.5,"stop":["END"]}',
      'memory={"enabled":false,"max_results":3}',
      'compaction={"enabled":false,"trigger_tokens":32000,"keep_recent_messages":8,"prompt":null}',
    ].join('|')
  )
})

test('env.* 变量替换运行时环境；env.version 缺失时保留原样', () => {
  const text = '{{env.platform}}/{{env.app}}/{{env.version}}/{{env.locale}}/{{env.theme}}'
  assert.equal(
    renderPromptTemplate(text, resolved, ENV),
    'Windows/Aurora Chat/9.9.9/zh-CN/dark'
  )
  assert.equal(
    renderPromptTemplate(text, resolved, { ...ENV, version: undefined }),
    'Windows/Aurora Chat/{{env.version}}/zh-CN/dark'
  )
  // 空字符串版本号同样视为「拿不到」
  assert.equal(
    renderPromptTemplate('{{env.version}}', resolved, { ...ENV, version: '' }),
    '{{env.version}}'
  )
})

test('未知变量原样保留，不报错也不替换成空串', () => {
  const text = '{{preset.unknown}} {{env.time}} {{invalid}} {{preset.system_prompt}}'
  assert.equal(renderPromptTemplate(text, resolved, ENV), text)
})

test('变量内部允许空格，同一个变量多次出现逐个替换', () => {
  assert.equal(
    renderPromptTemplate('{{ preset.model }} + {{preset.model}} + {{  preset.model  }}', resolved, ENV),
    'model-x + model-x + model-x'
  )
})

test('未启用预设（null）时用应用自带默认配置的摘要，而不是空串', () => {
  assert.equal(renderPromptTemplate('{{preset.name}}', null, ENV), BUILTIN_DEFAULT_PRESET_NAME)
  assert.equal(renderPromptTemplate('{{preset.id}}', null, ENV), 'default')
  assert.equal(
    renderPromptTemplate('{{preset.base_url}}', null, ENV),
    'https://api.deepseek.com/anthropic/v1'
  )
  assert.equal(renderPromptTemplate('{{preset.model}}', null, ENV), 'deepseek-flash')
  // 无预设时没有显式采样参数
  assert.equal(renderPromptTemplate('{{preset.params}}', null, ENV), '{}')
})

test('插入的值不会被再次渲染（单趟替换，无递归展开）', () => {
  const tricky = types.resolvePreset({
    schema: 1,
    id: 'tricky',
    name: '{{preset.model}}',
    model: 'inner-model',
  })
  assert.equal(renderPromptTemplate('{{preset.name}}', tricky, ENV), '{{preset.model}}')
})

test('插入值里的 $ 特殊序列按字面插入（replace 回调不解释替换模式）', () => {
  const tricky = types.resolvePreset({
    schema: 1,
    id: 'tricky',
    name: 'A$&B$`C$\'D',
    model: 'm',
  })
  assert.equal(renderPromptTemplate('{{preset.name}}', tricky, ENV), 'A$&B$`C$\'D')
})

test('presetDump：null 时给出内置默认名称/id；resolved 时用自身名称/id，且不含 system_prompt', () => {
  const fallback = presetDump(null)
  assert.equal(fallback.name, BUILTIN_DEFAULT_PRESET_NAME)
  assert.equal(fallback.id, 'default')
  assert.equal(fallback.protocol, 'anthropic')
  assert.equal(fallback.model, 'deepseek-flash')
  assert.equal('system_prompt' in fallback, false)

  const dump = presetDump(resolved)
  assert.equal(dump.name, 'X preset')
  assert.equal(dump.id, 'preset-x')
  assert.equal(dump.protocol, 'openai')
  assert.deepEqual(dump.params, { temperature: 0.5, stop: ['END'] })
  assert.deepEqual(dump.memory, { enabled: false, max_results: 3 })
  assert.equal(dump.compaction.enabled, false)
  assert.equal('system_prompt' in dump, false)
  assert.equal('apiKey' in dump, false)
})

test('presetTemplateValues：JSON 变量可解析回同一结构，版本号按需加入', () => {
  const values = presetTemplateValues(resolved, ENV)
  assert.equal(values['env.version'], '9.9.9')
  assert.deepEqual(JSON.parse(values['preset.params']), resolved.params)
  assert.deepEqual(JSON.parse(values['preset.memory']), resolved.memory)
  assert.deepEqual(JSON.parse(values['preset.compaction']), resolved.compaction)
  const dump = JSON.parse(values['preset.dump'])
  assert.equal(dump.name, 'X preset')
  assert.equal(dump.model, 'model-x')

  const withoutVersion = presetTemplateValues(resolved, { ...ENV, version: undefined })
  assert.equal('env.version' in withoutVersion, false)
})

test('支持变量清单稳定且不含递归 / 时间变量', () => {
  assert.deepEqual(PRESET_TEMPLATE_VARIABLES, [
    'preset.name',
    'preset.id',
    'preset.protocol',
    'preset.base_url',
    'preset.model',
    'preset.params',
    'preset.memory',
    'preset.compaction',
    'preset.dump',
    'env.platform',
    'env.app',
    'env.version',
    'env.locale',
    'env.theme',
  ])
  assert.equal(PRESET_TEMPLATE_VARIABLES.includes('preset.system_prompt'), false)
  assert.equal(
    PRESET_TEMPLATE_VARIABLES.some((name) => /time|date/i.test(name)),
    false
  )
})
