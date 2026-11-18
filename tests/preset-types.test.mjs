// Preset runtime resolution and metadata guards (src/services/preset/types.ts):
// defaults, explicit-only sampling params, metadata validation order and read-only guards.
//
// Modules under .test-build are compiled by tests/run.mjs before this file runs.
// `__API_ORIGIN__` is injected by rspack's DefinePlugin in the app; define it here first.
import assert from 'node:assert/strict'
import { test } from 'node:test'

globalThis.__API_ORIGIN__ = 'https://api.deepseek.com'

const {
  DEFAULT_PRESET_BASE_URL,
  DEFAULT_PRESET_COMPACTION,
  DEFAULT_PRESET_ID,
  DEFAULT_PRESET_MEMORY,
  DEFAULT_PRESET_MODEL,
  DEFAULT_PRESET_PARAMS,
  PRESET_METADATA_ERROR_CODES,
  PRESET_METADATA_FIELDS,
  PresetError,
  assertPresetEditable,
  assertPresetMetadata,
  isBuiltinPreset,
  isDefaultPresetId,
  isSystemDefaultPreset,
  missingPresetMetadata,
  resolvePreset,
} = await import('../.test-build/services/preset/types.js')

const baseConfig = (overrides = {}) => ({ schema: 1, id: 'demo', name: 'Demo', ...overrides })

const expectPresetCode = (fn, code) => {
  assert.throws(
    fn,
    (error) => {
      assert.ok(error instanceof PresetError, `expected PresetError, got ${error?.name}`)
      assert.equal(error.code, code)
      return true
    },
    `expected PresetError code ${code}`
  )
}

test('默认常量与协议默认值符合文档', () => {
  assert.equal(DEFAULT_PRESET_ID, 'default')
  assert.equal(DEFAULT_PRESET_MODEL, 'deepseek-flash')
  assert.equal(DEFAULT_PRESET_BASE_URL, 'https://api.deepseek.com/anthropic/v1')
  assert.deepEqual(DEFAULT_PRESET_PARAMS, {
    temperature: 1,
    top_p: 1,
    max_tokens: 4096,
    stop: [],
    presence_penalty: 0,
    frequency_penalty: 0,
    seed: null,
    reasoning_effort: null,
  })
  assert.deepEqual(DEFAULT_PRESET_COMPACTION, {
    enabled: true,
    trigger_tokens: 32000,
    keep_recent_messages: 8,
    prompt: null,
  })
  assert.deepEqual(DEFAULT_PRESET_MEMORY, { enabled: false, max_results: 8 })
  assert.deepEqual(PRESET_METADATA_FIELDS, ['description', 'author', 'version', 'copyright'])
  assert.deepEqual(PRESET_METADATA_ERROR_CODES, {
    description: 'missingDescription',
    author: 'missingAuthor',
    version: 'missingVersion',
    copyright: 'missingCopyright',
  })
})

test('resolvePreset(null) 回落到系统默认（等价于未启用预设）', () => {
  const resolved = resolvePreset(null)
  assert.equal(resolved.id, '')
  assert.equal(resolved.name, '')
  assert.equal(resolved.protocol, 'anthropic')
  assert.equal(resolved.base_url, DEFAULT_PRESET_BASE_URL)
  assert.equal(resolved.model, DEFAULT_PRESET_MODEL)
  assert.deepEqual(resolved.params, {})
  assert.equal(resolved.system_prompt, '')
  assert.deepEqual(resolved.compaction, DEFAULT_PRESET_COMPACTION)
  assert.deepEqual(resolved.memory, DEFAULT_PRESET_MEMORY)
  assert.equal(resolved.builtin, false)
  assert.deepEqual(resolved.overrides.params.size, 0)
  assert.equal(resolved.overrides.protocol, false)
  assert.equal(resolved.overrides.base_url, false)
  assert.equal(resolved.overrides.model, false)
  assert.equal(resolved.overrides.system_prompt, false)
  assert.equal(resolved.overrides.compaction.size, 0)
  assert.equal(resolved.overrides.memory.size, 0)
})

test('只写 schema/id/name 的配置不产生任何覆盖，字段全部回落系统默认', () => {
  const resolved = resolvePreset(baseConfig())
  assert.equal(resolved.base_url, DEFAULT_PRESET_BASE_URL)
  assert.equal(resolved.model, DEFAULT_PRESET_MODEL)
  assert.deepEqual(resolved.params, {})
  assert.equal(resolved.overrides.base_url, false)
  assert.equal(resolved.overrides.model, false)
})

test('部分覆盖只记录真正写出的字段，其余仍回落默认', () => {
  const resolved = resolvePreset(
    baseConfig({
      id: 'openai-demo',
      name: 'OpenAI demo',
      protocol: 'openai',
      base_url: '  https://api.example.com/v1///  ',
      model: '  gpt-demo  ',
      params: { temperature: 0.7 },
      compaction: { enabled: false },
      memory: { max_results: 4 },
    })
  )
  assert.equal(resolved.protocol, 'openai')
  // base_url 去首尾空白与结尾斜杠；model 去首尾空白
  assert.equal(resolved.base_url, 'https://api.example.com/v1')
  assert.equal(resolved.model, 'gpt-demo')
  assert.deepEqual(resolved.params, { temperature: 0.7 })
  assert.equal(resolved.compaction.enabled, false)
  // 未写的 compaction 子字段仍回落默认
  assert.equal(resolved.compaction.trigger_tokens, DEFAULT_PRESET_COMPACTION.trigger_tokens)
  assert.equal(resolved.memory.max_results, 4)
  assert.equal(resolved.memory.enabled, DEFAULT_PRESET_MEMORY.enabled)
  assert.equal(resolved.overrides.protocol, true)
  assert.equal(resolved.overrides.base_url, true)
  assert.equal(resolved.overrides.model, true)
  assert.deepEqual([...resolved.overrides.params], ['temperature'])
  assert.deepEqual([...resolved.overrides.compaction], ['enabled'])
  assert.deepEqual([...resolved.overrides.memory], ['max_results'])
  assert.equal(resolved.overrides.system_prompt, false)
})

test('采样参数只包含显式写出的字段：留空 =不发（不是发 0 / 默认值）', () => {
  const resolved = resolvePreset(
    baseConfig({
      params: { temperature: 0, top_p: 0.5, max_tokens: 128, presence_penalty: -1 },
    })
  )
  assert.deepEqual(resolved.params, {
    temperature: 0,
    top_p: 0.5,
    max_tokens: 128,
    presence_penalty: -1,
  })
  assert.deepEqual([...resolved.overrides.params].sort(), [
    'max_tokens',
    'presence_penalty',
    'temperature',
    'top_p',
  ])
})

test('stop 的空数组 / 全空白条目视为未设置，非空条目保留原样（含内部空白）', () => {
  const blank = resolvePreset(baseConfig({ params: { stop: ['', '   '] } }))
  assert.equal(blank.params.stop, undefined)
  const filled = resolvePreset(baseConfig({ params: { stop: ['END', '  ', '##'] } }))
  assert.deepEqual(filled.params.stop, ['END', '##'])
  const spaced = resolvePreset(baseConfig({ params: { stop: [' keep '] } }))
  assert.deepEqual(spaced.params.stop, [' keep '])
})

test('seed / reasoning_effort 的 null 视为未设置，0 与空串以外的值保留', () => {
  const nulls = resolvePreset(baseConfig({ params: { seed: null, reasoning_effort: null } }))
  assert.equal('seed' in nulls.params, false)
  assert.equal('reasoning_effort' in nulls.params, false)
  const explicit = resolvePreset(baseConfig({ params: { seed: 0, reasoning_effort: 'high' } }))
  assert.equal(explicit.params.seed, 0)
  assert.equal(explicit.params.reasoning_effort, 'high')
})

test('空白 system_prompt / base_url / model 不生效，回落系统默认', () => {
  const resolved = resolvePreset(
    baseConfig({ base_url: '   ', model: '  ', system_prompt: ' \n\t ' })
  )
  assert.equal(resolved.base_url, DEFAULT_PRESET_BASE_URL)
  assert.equal(resolved.model, DEFAULT_PRESET_MODEL)
  assert.equal(resolved.system_prompt, '')
  assert.equal(resolved.overrides.base_url, false)
  assert.equal(resolved.overrides.model, false)
  assert.equal(resolved.overrides.system_prompt, false)
})

test('system_prompt 保留原文排版，只按 trim 判断是否为空', () => {
  const text = '  You are helpful.\n'
  const resolved = resolvePreset(baseConfig({ system_prompt: text }))
  assert.equal(resolved.system_prompt, text)
  assert.equal(resolved.overrides.system_prompt, true)
})

test('元信息字段只有定义了才出现在解析结果里', () => {
  const bare = resolvePreset(baseConfig())
  assert.equal('description' in bare, false)
  assert.equal('author' in bare, false)
  assert.equal('version' in bare, false)
  assert.equal('copyright' in bare, false)
  const full = resolvePreset(
    baseConfig({ description: 'd', author: 'a', version: '1.2.3', copyright: 'c' })
  )
  assert.equal(full.description, 'd')
  assert.equal(full.author, 'a')
  assert.equal(full.version, '1.2.3')
  assert.equal(full.copyright, 'c')
})

test('builtin 标记：id=default 或 builtin=true 都算内置，null 不算', () => {
  assert.equal(isBuiltinPreset(null), false)
  assert.equal(isBuiltinPreset(undefined), false)
  assert.equal(isBuiltinPreset(baseConfig()), false)
  assert.equal(isBuiltinPreset(baseConfig({ id: DEFAULT_PRESET_ID })), true)
  assert.equal(isBuiltinPreset(baseConfig({ builtin: true })), true)
  assert.equal(resolvePreset(baseConfig({ id: DEFAULT_PRESET_ID })).builtin, true)
})

test('isDefaultPresetId 只认 default', () => {
  assert.equal(isDefaultPresetId('default'), true)
  assert.equal(isDefaultPresetId('default2'), false)
  assert.equal(isDefaultPresetId(''), false)
})

test('isSystemDefaultPreset：null 与「默认预设且无覆盖」等价于未启用预设', () => {
  assert.equal(isSystemDefaultPreset(null), true)
  assert.equal(isSystemDefaultPreset(baseConfig({ id: DEFAULT_PRESET_ID })), true)
  // 写了空的 params / compaction / memory 对象但没有任何字段，仍算无覆盖
  assert.equal(
    isSystemDefaultPreset(baseConfig({ id: DEFAULT_PRESET_ID, params: {}, compaction: {} })),
    true
  )
  // id=default 但有一个覆盖字段 → 不是系统默认
  assert.equal(isSystemDefaultPreset(baseConfig({ id: DEFAULT_PRESET_ID, params: { temperature: 1 } })), false)
  assert.equal(isSystemDefaultPreset(baseConfig({ id: DEFAULT_PRESET_ID, builtin: false })), true)
  // 非 default 的 id 永远不是系统默认
  assert.equal(isSystemDefaultPreset(baseConfig({ id: 'other' })), false)
})

test('missingPresetMetadata：null 返回全部字段，缺失字段按固定顺序返回', () => {
  assert.deepEqual(missingPresetMetadata(null), ['description', 'author', 'version', 'copyright'])
  assert.deepEqual(missingPresetMetadata(undefined), [
    'description',
    'author',
    'version',
    'copyright',
  ])
  assert.deepEqual(
    missingPresetMetadata({
      description: 'd',
      author: 'a',
      version: '1',
      copyright: 'c',
    }),
    []
  )
  assert.deepEqual(missingPresetMetadata({ description: 'd' }), [
    'author',
    'version',
    'copyright',
  ])
  // 只有空白也算缺失
  assert.deepEqual(
    missingPresetMetadata({ description: '  ', author: 'a', version: '1', copyright: 'c' }),
    ['description']
  )
  // LICENSE 文件可承担版权声明
  assert.deepEqual(
    missingPresetMetadata({ description: 'd', author: 'a', version: '1' }, { allowMissingCopyright: true }),
    []
  )
  // allowMissingCopyright 只豁免 copyright
  assert.deepEqual(
    missingPresetMetadata({ author: 'a', version: '1', copyright: 'c' }, { allowMissingCopyright: true }),
    ['description']
  )
})

test('assertPresetMetadata：抛第一个缺失字段对应的稳定错误码', () => {
  const full = { description: 'd', author: 'a', version: '1', copyright: 'c' }
  assert.doesNotThrow(() => assertPresetMetadata(full))
  expectPresetCode(() => assertPresetMetadata({ ...full, description: ' ' }), 'missingDescription')
  expectPresetCode(() => assertPresetMetadata({ ...full, author: '' }), 'missingAuthor')
  expectPresetCode(() => assertPresetMetadata({ ...full, version: '' }), 'missingVersion')
  expectPresetCode(() => assertPresetMetadata({ ...full, copyright: '' }), 'missingCopyright')
  // 多个缺失时只报第一个（描述 → 作者 → 版本 → 版权）
  expectPresetCode(
    () => assertPresetMetadata({ description: '', author: '', version: '', copyright: '' }),
    'missingDescription'
  )
  assert.doesNotThrow(() =>
    assertPresetMetadata(
      { description: 'd', author: 'a', version: '1', copyright: '' },
      { allowMissingCopyright: true }
    )
  )
})

test('assertPresetEditable：只有 imported 来源被拒绝，detail 带预设 id', () => {
  assert.doesNotThrow(() => assertPresetEditable(null))
  assert.doesNotThrow(() => assertPresetEditable(undefined))
  assert.doesNotThrow(() => assertPresetEditable({ id: 'created-one', source: 'created' }))
  // 旧记录没有 source 字段：按 created 处理
  assert.doesNotThrow(() => assertPresetEditable({ id: 'legacy' }))
  assert.doesNotThrow(() => assertPresetEditable({ id: DEFAULT_PRESET_ID }))
  assert.throws(
    () => assertPresetEditable({ id: 'zip-one', source: 'imported' }),
    (error) => {
      assert.equal(error.name, 'PresetError')
      assert.equal(error.code, 'importedReadOnly')
      assert.equal(error.detail, 'zip-one')
      return true
    }
  )
})
