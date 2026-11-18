// Preset manifest JSON parsing and zip import (src/services/preset/zip.ts):
// strict save/import rules, default preset partial config, explicit-only params,
// default paths, missing files, and zip safety limits (paths / entries / size).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { strToU8, zipSync } from 'fflate'

globalThis.__API_ORIGIN__ = 'https://api.deepseek.com'

const {
  normalizeEntryPath,
  parsePresetConfig,
  parsePresetConfigForImport,
  parsePresetConfigForSave,
  parsePresetZip,
} = await import('../.test-build/services/preset/zip.js')
const { DEFAULT_PRESET_COMPACTION, DEFAULT_PRESET_MEMORY, PresetError } = await import(
  '../.test-build/services/preset/types.js'
)

const FULL_CONFIG = {
  schema: 1,
  id: 'demo',
  name: 'Demo',
  description: 'A demo',
  author: 'Author',
  version: '1.0.0',
  copyright: '© 2026 Author',
  protocol: 'openai',
  base_url: 'https://api.example.com',
  model: 'demo-model',
}

const expectCode = (fn, code) => {
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

const makeZip = (config, extra = {}) =>
  new File([zipSync({ 'api_configs.json': strToU8(JSON.stringify(config)), ...extra })], 'preset.zip', {
    type: 'application/zip',
  })

test('parsePresetConfig：合法清单规范化（trim、去结尾斜杠、元信息只做 trim）', () => {
  const config = parsePresetConfig(
    JSON.stringify({
      ...FULL_CONFIG,
      description: '  A demo  ',
      author: ' Author ',
      version: ' 1.0.0 ',
      copyright: ' © 2026 Author ',
      base_url: '  https://api.example.com/// ',
      model: '  demo-model  ',
    })
  )
  assert.equal(config.description, 'A demo')
  assert.equal(config.author, 'Author')
  assert.equal(config.version, '1.0.0')
  assert.equal(config.copyright, '© 2026 Author')
  assert.equal(config.base_url, 'https://api.example.com')
  assert.equal(config.model, 'demo-model')
})

test('parsePresetConfig：params 只保留显式字段，compaction / memory 补齐默认', () => {
  const config = parsePresetConfig(
    JSON.stringify({ ...FULL_CONFIG, params: { temperature: 0.7, stop: ['END'] } })
  )
  assert.deepEqual(config.params, { temperature: 0.7, stop: ['END'] })
  assert.equal('max_tokens' in config.params, false)
  assert.deepEqual(config.compaction, DEFAULT_PRESET_COMPACTION)
  assert.deepEqual(config.memory, DEFAULT_PRESET_MEMORY)
  assert.equal(config.system_prompt, undefined)
  assert.equal(config.icon, undefined)
  assert.equal(config.license, undefined)
})

test('parsePresetConfig：partial compaction / memory 只覆盖写出的子字段', () => {
  const config = parsePresetConfig(
    JSON.stringify({ ...FULL_CONFIG, compaction: { enabled: false }, memory: { max_results: 2 } })
  )
  assert.deepEqual(config.compaction, { ...DEFAULT_PRESET_COMPACTION, enabled: false })
  assert.deepEqual(config.memory, { ...DEFAULT_PRESET_MEMORY, max_results: 2 })
})

test('parsePresetConfig：普通预设缺版权声明被拒；导入入口允许（由 LICENSE 兜底）', () => {
  const text = JSON.stringify({ ...FULL_CONFIG, copyright: '' })
  expectCode(() => parsePresetConfig(text), 'missingCopyright')
  const imported = parsePresetConfigForImport(text)
  assert.equal(imported.id, 'demo')
  assert.equal(imported.copyright, undefined)
})

test('parsePresetConfigForSave：id=default 允许只写最基本字段（其余回落系统默认）', () => {
  const config = parsePresetConfigForSave(
    JSON.stringify({ schema: 1, id: 'default', name: ' Default preset ' })
  )
  assert.equal(config.id, 'default')
  assert.equal(config.name, 'Default preset')
  assert.equal(config.builtin, true)
  assert.equal('protocol' in config, false)
  assert.equal('base_url' in config, false)
  assert.equal('model' in config, false)
  assert.equal('compaction' in config, false)
  assert.equal('memory' in config, false)
})

test('parsePresetConfigForSave：id=default 的显式字段照常校验，params 只存显式字段', () => {
  const config = parsePresetConfigForSave(
    JSON.stringify({
      schema: 1,
      id: 'default',
      name: 'Default',
      protocol: 'responses',
      base_url: 'https://api.example.com/v1/',
      model: 'm',
      params: { top_p: 0.9 },
      compaction: { trigger_tokens: 1000 },
      memory: { enabled: true },
    })
  )
  assert.equal(config.protocol, 'responses')
  assert.equal(config.base_url, 'https://api.example.com/v1')
  assert.equal(config.model, 'm')
  assert.deepEqual(config.params, { top_p: 0.9 })
  assert.deepEqual(config.compaction, { trigger_tokens: 1000 })
  assert.deepEqual(config.memory, { enabled: true })
  expectCode(
    () => parsePresetConfigForSave(JSON.stringify({ schema: 1, id: 'default', name: 'D', model: ' ' })),
    'badConfig'
  )
})

test('parsePresetConfigForSave：非 default 的 id 仍走严格校验', () => {
  expectCode(
    () => parsePresetConfigForSave(JSON.stringify({ schema: 1, id: 'other', name: 'Other' })),
    'badConfig'
  )
})

test('清单基本字段校验：非法 JSON / 结构 / schema / id / name / protocol / base_url / model', () => {
  expectCode(() => parsePresetConfig('not json'), 'badConfig')
  expectCode(() => parsePresetConfig('null'), 'badConfig')
  expectCode(() => parsePresetConfig('[]'), 'badConfig')
  expectCode(() => parsePresetConfig(JSON.stringify({ ...FULL_CONFIG, schema: 2 })), 'badConfig')
  expectCode(() => parsePresetConfig(JSON.stringify({ ...FULL_CONFIG, id: 'Bad Id' })), 'badConfig')
  expectCode(() => parsePresetConfig(JSON.stringify({ ...FULL_CONFIG, id: '' })), 'badConfig')
  expectCode(() => parsePresetConfig(JSON.stringify({ ...FULL_CONFIG, name: '   ' })), 'badConfig')
  expectCode(
    () => parsePresetConfig(JSON.stringify({ ...FULL_CONFIG, name: 'x'.repeat(81) })),
    'badConfig'
  )
  expectCode(
    () => parsePresetConfig(JSON.stringify({ ...FULL_CONFIG, protocol: 'gemini' })),
    'badConfig'
  )
  expectCode(
    () => parsePresetConfig(JSON.stringify({ ...FULL_CONFIG, base_url: 'ftp://example.com' })),
    'badConfig'
  )
  expectCode(
    () => parsePresetConfig(JSON.stringify({ ...FULL_CONFIG, base_url: 'https://a b.com' })),
    'badConfig'
  )
  expectCode(() => parsePresetConfig(JSON.stringify({ ...FULL_CONFIG, model: '  ' })), 'badConfig')
  expectCode(() => parsePresetConfig(JSON.stringify({ ...FULL_CONFIG, description: 'x'.repeat(401) })), 'badConfig')
})

test('版权声明校验：拒绝尖括号 / 控制字符、超过 500 字', () => {
  expectCode(
    () => parsePresetConfig(JSON.stringify({ ...FULL_CONFIG, copyright: 'a <b> c' })),
    'badConfig'
  )
  expectCode(
    () => parsePresetConfig(JSON.stringify({ ...FULL_CONFIG, copyright: 'a\u0000b' })),
    'badConfig'
  )
  expectCode(
    () => parsePresetConfig(JSON.stringify({ ...FULL_CONFIG, copyright: 'x'.repeat(501) })),
    'badConfig'
  )
  // 换行 / 制表是允许的多行版权声明
  const multi = parsePresetConfig(
    JSON.stringify({ ...FULL_CONFIG, copyright: 'line1\nline2\ttab' })
  )
  assert.equal(multi.copyright, 'line1\nline2\ttab')
})

test('采样参数边界：越界 / 类型错误拒绝，合法值保留', () => {
  const invalidParams = [
    { temperature: 2.5 },
    { temperature: -1 },
    { top_p: 1.5 },
    { max_tokens: 0 },
    { max_tokens: 1.5 },
    { stop: 'END' },
    { stop: [1] },
    { presence_penalty: -3 },
    { frequency_penalty: 3 },
    { seed: 1.5 },
    { reasoning_effort: 3 },
  ]
  for (const params of invalidParams) {
    expectCode(
      () => parsePresetConfig(JSON.stringify({ ...FULL_CONFIG, params })),
      'badConfig'
    )
  }
  const valid = parsePresetConfig(
    JSON.stringify({
      ...FULL_CONFIG,
      params: { temperature: 2, top_p: 0, max_tokens: 1, presence_penalty: -2, frequency_penalty: 2, seed: 0 },
    })
  )
  assert.equal(valid.params.temperature, 2)
  assert.equal(valid.params.top_p, 0)
  assert.equal(valid.params.max_tokens, 1)
  assert.equal(valid.params.presence_penalty, -2)
  assert.equal(valid.params.frequency_penalty, 2)
  assert.equal(valid.params.seed, 0)
})

test('compaction / memory 边界校验', () => {
  const invalid = [
    { compaction: { enabled: 'yes' } },
    { compaction: { trigger_tokens: 0 } },
    { compaction: { keep_recent_messages: -1 } },
    { compaction: { keep_recent_messages: 101 } },
    { compaction: { prompt: 3 } },
    { memory: { enabled: 'no' } },
    { memory: { max_results: 0 } },
    { memory: { max_results: 51 } },
  ]
  for (const overrides of invalid) {
    expectCode(
      () => parsePresetConfig(JSON.stringify({ ...FULL_CONFIG, ...overrides })),
      'badConfig'
    )
  }
})

test('normalizeEntryPath：接受包内相对路径，拒绝绝对 / 穿越 / 空段', () => {
  assert.equal(normalizeEntryPath('a/b.png'), 'a/b.png')
  assert.equal(normalizeEntryPath('a\\b.png'), 'a/b.png')
  assert.equal(normalizeEntryPath('icon.png'), 'icon.png')
  assert.equal(normalizeEntryPath('/etc/passwd'), null)
  assert.equal(normalizeEntryPath('\\windows\\x'), null)
  assert.equal(normalizeEntryPath('C:/x'), null)
  assert.equal(normalizeEntryPath('c:\\x'), null)
  assert.equal(normalizeEntryPath('../evil'), null)
  assert.equal(normalizeEntryPath('a/../b'), null)
  assert.equal(normalizeEntryPath('./a'), null)
  assert.equal(normalizeEntryPath('a//b'), null)
  assert.equal(normalizeEntryPath('a/'), null)
  assert.equal(normalizeEntryPath(''), null)
})

test('zip 导入：显式目录条目被忽略（只统计文件），清单大小写不敏感', async () => {
  const parsed = await parsePresetZip(
    new File(
      [
        zipSync({
          'api_configs.json': strToU8(JSON.stringify(FULL_CONFIG)),
          'assets/': new Uint8Array(0),
          'system_prompt.md': strToU8('hi'),
        }),
      ],
      'preset.zip'
    )
  )
  assert.equal(parsed.config.id, 'demo')
  assert.equal(parsed.promptText, 'hi')
})

test('zip 导入：路径穿越条目整包拒绝（badPath）', async () => {
  for (const badName of ['../evil.txt', '/etc/passwd', 'C:/evil.txt', 'a/../b.txt']) {
    await assert.rejects(
      parsePresetZip(
        new File(
          [
            zipSync({
              'api_configs.json': strToU8(JSON.stringify(FULL_CONFIG)),
              [badName]: strToU8('x'),
            }),
          ],
          'preset.zip'
        )
      ),
      (error) => error instanceof PresetError && error.code === 'badPath',
      `expected badPath for ${badName}`
    )
  }
})

test('zip 导入：条目数超过 100 拒绝（tooManyFiles）', async () => {
  const entries = { 'api_configs.json': strToU8(JSON.stringify(FULL_CONFIG)) }
  for (let index = 0; index < 100; index += 1) {
    entries[`f${index}.txt`] = strToU8('x')
  }
  await assert.rejects(
    parsePresetZip(new File([zipSync(entries)], 'preset.zip')),
    (error) => error instanceof PresetError && error.code === 'tooManyFiles'
  )
})

test('zip 导入：解压后总大小超过 10MB 拒绝（tooLarge）', async () => {
  const big = new Uint8Array(11 * 1024 * 1024) // 全零，压缩后很小
  await assert.rejects(
    parsePresetZip(
      new File(
        [
          zipSync({
            'api_configs.json': strToU8(JSON.stringify(FULL_CONFIG)),
            'big.bin': big,
          }),
        ],
        'preset.zip'
      )
    ),
    (error) => error instanceof PresetError && error.code === 'tooLarge'
  )
})

test('zip 导入：非 zip / 空包 / 缺清单 / 清单在子目录都拒绝', async () => {
  const notZip = new File([strToU8('not a zip')], 'preset.zip')
  await assert.rejects(
    parsePresetZip(notZip),
    (error) => error instanceof PresetError && error.code === 'notZip'
  )
  await assert.rejects(
    parsePresetZip(new File([zipSync({})], 'preset.zip')),
    (error) => error instanceof PresetError && error.code === 'noConfig'
  )
  await assert.rejects(
    parsePresetZip(
      new File([zipSync({ 'readme.txt': strToU8('x') })], 'preset.zip')
    ),
    (error) => error instanceof PresetError && error.code === 'noConfig'
  )
  await assert.rejects(
    parsePresetZip(
      new File(
        [zipSync({ 'sub/api_configs.json': strToU8(JSON.stringify(FULL_CONFIG)) })],
        'preset.zip'
      )
    ),
    (error) => error instanceof PresetError && error.code === 'noConfig'
  )
})

test('zip 导入：显式 system_prompt_file 严格（缺失 / 类型 / 超限）', async () => {
  await assert.rejects(
    parsePresetZip(
      makeZip({ ...FULL_CONFIG, system_prompt_file: 'prompts/sys.md' })
    ),
    (error) => error instanceof PresetError && error.code === 'missingFile'
  )
  await assert.rejects(
    parsePresetZip(
      makeZip(
        { ...FULL_CONFIG, system_prompt_file: 'sys.js' },
        { 'sys.js': strToU8('alert(1)') }
      )
    ),
    (error) => error instanceof PresetError && error.code === 'badFileType'
  )
  await assert.rejects(
    parsePresetZip(
      makeZip(
        { ...FULL_CONFIG, system_prompt_file: 'sys.md' },
        { 'sys.md': new Uint8Array(64 * 1024 + 1) }
      )
    ),
    (error) => error instanceof PresetError && error.code === 'tooLarge'
  )
  const parsed = await parsePresetZip(
    makeZip(
      { ...FULL_CONFIG, system_prompt_file: 'prompts\\sys.md' },
      { 'prompts/sys.md': strToU8('file prompt') }
    )
  )
  assert.equal(parsed.promptText, 'file prompt')
  assert.equal(parsed.config.system_prompt_file, 'prompts/sys.md')
})

test('zip 导入：system_prompt 文件优先于内联提示词；没有内联时才用默认 prompt.md', async () => {
  const withFile = await parsePresetZip(
    makeZip(
      { ...FULL_CONFIG, system_prompt: 'inline', system_prompt_file: 'custom.md' },
      { 'custom.md': strToU8('from file') }
    )
  )
  assert.equal(withFile.promptText, 'from file')
  assert.equal(withFile.config.system_prompt, 'inline')

  const withInline = await parsePresetZip(
    makeZip({ ...FULL_CONFIG, system_prompt: 'inline' }, { 'system_prompt.md': strToU8('default file') })
  )
  assert.equal(withInline.promptText, undefined)

  const defaultFile = await parsePresetZip(
    makeZip(FULL_CONFIG, { 'prompt.md': strToU8('default prompt') })
  )
  assert.equal(defaultFile.promptText, 'default prompt')
  assert.equal(defaultFile.config.system_prompt_file, 'prompt.md')
})

test('zip 导入：icon 显式路径严格，默认 icon.<ext> 自动补齐', async () => {
  await assert.rejects(
    parsePresetZip(makeZip({ ...FULL_CONFIG, icon: { file: 'missing.png' } })),
    (error) => error instanceof PresetError && error.code === 'missingFile'
  )
  await assert.rejects(
    parsePresetZip(
      makeZip({ ...FULL_CONFIG, icon: { file: 'icon.txt' } }, { 'icon.txt': strToU8('x') })
    ),
    (error) => error instanceof PresetError && error.code === 'badFileType'
  )
  const explicit = await parsePresetZip(
    makeZip(
      { ...FULL_CONFIG, icon: { file: 'img/logo\\icon.png' } },
      { 'img/logo/icon.png': new Uint8Array([1, 2, 3]) }
    )
  )
  assert.equal(explicit.config.icon.file, 'img/logo/icon.png')
  assert.ok(explicit.icon instanceof Blob)
  assert.equal(explicit.icon.type, 'image/png')

  const fromDefault = await parsePresetZip(
    makeZip(FULL_CONFIG, { 'ICON.WEBP': new Uint8Array([9]) })
  )
  assert.equal(fromDefault.config.icon.file, 'ICON.WEBP')
  assert.equal(fromDefault.icon.type, 'image/webp')
})

test('zip 导入：license 显式严格，默认位置 LICENSE* 自动发现', async () => {
  await assert.rejects(
    parsePresetZip(makeZip({ ...FULL_CONFIG, license: { file: 'LICENSE' } })),
    (error) => error instanceof PresetError && error.code === 'missingFile'
  )
  const explicit = await parsePresetZip(
    makeZip({ ...FULL_CONFIG, license: { file: 'legal/LICENSE.txt' } }, {
      'legal/LICENSE.txt': strToU8('MIT'),
    })
  )
  assert.equal(explicit.license, 'MIT')
  assert.equal(explicit.config.license.file, 'legal/LICENSE.txt')

  const defaultLicense = await parsePresetZip(
    makeZip({ ...FULL_CONFIG, copyright: '' }, { 'LICENSE.md': strToU8('MIT text') })
  )
  assert.equal(defaultLicense.license, 'MIT text')
  assert.equal(defaultLicense.config.license.file, 'LICENSE.md')
})

test('zip 导入：manifest 本身非法时拒绝（badConfig）', async () => {
  await assert.rejects(
    parsePresetZip(
      new File(
        [zipSync({ 'api_configs.json': strToU8('{invalid') })],
        'preset.zip'
      )
    ),
    (error) => error instanceof PresetError && error.code === 'badConfig'
  )
})
