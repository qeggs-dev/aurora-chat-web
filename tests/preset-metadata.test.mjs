// Preset zip parsing: mandatory metadata (description / author / version / copyright)
// must block the whole import, and only explicitly written sampling params are kept.
//
// The compiled modules under .test-build are produced by tests/run.mjs before this file
// runs. `__API_ORIGIN__` is normally injected by rspack's DefinePlugin, so define it on
// globalThis before importing the compiled module.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { zipSync, strToU8 } from 'fflate'

globalThis.__API_ORIGIN__ = 'https://api.deepseek.com'

const { parsePresetZip } = await import('../.test-build/services/preset/zip.js')

const COMPLETE_CONFIG = {
  schema: 1,
  id: 'demo-preset',
  name: 'Demo preset',
  description: 'A demo preset',
  author: 'Demo Author',
  version: '1.0.0',
  copyright: '© 2026 Demo Author. All rights reserved.',
  protocol: 'openai',
  base_url: 'https://api.example.com',
  model: 'demo-model',
}

const withMetadata = (overrides) => ({ ...COMPLETE_CONFIG, ...overrides })

/** 构造只含 api_configs.json（+ 可选额外文件）的预设 zip */
const makeZip = (config, extra = {}) =>
  new File(
    [
      zipSync({
        'api_configs.json': strToU8(JSON.stringify(config)),
        ...extra,
      }),
    ],
    'preset.zip',
    { type: 'application/zip' }
  )

const expectCode = async (promise, code) => {
  await assert.rejects(
    promise,
    (error) => {
      assert.equal(error.name, 'PresetError')
      assert.equal(error.code, code)
      return true
    },
    `expected PresetError code ${code}`
  )
}

test('完整元信息的 zip 能导入，并保留提示词文件', async () => {
  const parsed = await parsePresetZip(
    makeZip(COMPLETE_CONFIG, { 'system_prompt.md': strToU8('You are a demo assistant.') })
  )
  assert.equal(parsed.config.id, 'demo-preset')
  assert.equal(parsed.config.description, 'A demo preset')
  assert.equal(parsed.config.author, 'Demo Author')
  assert.equal(parsed.config.version, '1.0.0')
  assert.equal(parsed.config.copyright, '© 2026 Demo Author. All rights reserved.')
  assert.equal(parsed.promptText, 'You are a demo assistant.')
})

test('缺少 copyright 的 zip 导入被拒（missingCopyright）', async () => {
  await expectCode(parsePresetZip(makeZip(withMetadata({ copyright: '' }))), 'missingCopyright')
})

test('copyright 只有空白同样被拒（missingCopyright）', async () => {
  await expectCode(parsePresetZip(makeZip(withMetadata({ copyright: '   ' }))), 'missingCopyright')
})

test('description 为空时导入被拒（missingDescription）', async () => {
  await expectCode(parsePresetZip(makeZip(withMetadata({ description: '' }))), 'missingDescription')
})

test('author 为空时导入被拒（missingAuthor）', async () => {
  await expectCode(parsePresetZip(makeZip(withMetadata({ author: '  ' }))), 'missingAuthor')
})

test('version 为空时导入被拒（missingVersion）', async () => {
  await expectCode(parsePresetZip(makeZip(withMetadata({ version: '' }))), 'missingVersion')
})

test('元信息首尾空白会被去掉', async () => {
  const parsed = await parsePresetZip(
    makeZip(
      withMetadata({
        description: '  description  ',
        author: ' author ',
        version: ' 2.0.0 ',
        copyright: ' copyright ',
      })
    )
  )
  assert.equal(parsed.config.description, 'description')
  assert.equal(parsed.config.author, 'author')
  assert.equal(parsed.config.version, '2.0.0')
  assert.equal(parsed.config.copyright, 'copyright')
})

test('未写 params 的预设不补默认采样参数（留空 = 不发送）', async () => {
  const parsed = await parsePresetZip(makeZip(COMPLETE_CONFIG))
  assert.equal(parsed.config.params, undefined)
  assert.equal(parsed.config.system_prompt, undefined)
})

test('显式写出的采样参数原样保留，其它字段仍缺省', async () => {
  const parsed = await parsePresetZip(
    makeZip(withMetadata({ params: { temperature: 0.7, stop: ['END'] } }))
  )
  assert.deepEqual(parsed.config.params, { temperature: 0.7, stop: ['END'] })
})
test('缺少 copyright 但包内带完整 LICENSE 文件时允许导入，并保留许可证全文', async () => {
  const licenseText = 'MIT License\n\nCopyright (c) 2026 Demo Author\n\nPermission is hereby granted...'
  const parsed = await parsePresetZip(
    makeZip(withMetadata({ copyright: '' }), { LICENSE: strToU8(licenseText) })
  )
  assert.equal(parsed.config.id, 'demo-preset')
  assert.equal((parsed.config.copyright ?? '').trim(), '')
  assert.equal(parsed.license, licenseText)
})

test('缺少 copyright 且没有 LICENSE 文件时导入被拒（missingCopyright）', async () => {
  await expectCode(parsePresetZip(makeZip(withMetadata({ copyright: '' }))), 'missingCopyright')
})