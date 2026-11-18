// Locale pack format (src/services/locale/pack.ts + src/i18n/messages.ts):
// schema 1 validation, reserved ids, messages counting, export/round-trip and
// the custom → built-in current → built-in English lookup order.
import assert from 'node:assert/strict'
import { test } from 'node:test'

const {
  buildLocalePackExport,
  LOCALE_ID_PATTERN,
  LocalePackError,
  MAX_LOCALE_LICENSE_BYTES,
  parseLocalePackText,
} = await import('../.test-build/services/locale/pack.js')
const { BUILTIN_LOCALE_METADATA } = await import('../.test-build/i18n/builtinPacks.js')
const { MIT_LICENSE_TEXT } = await import('../.test-build/i18n/license.js')
const { lookupMessage, translationKeys } = await import('../.test-build/i18n/messages.js')
const { zh } = await import('../.test-build/i18n/zh.js')
const { en } = await import('../.test-build/i18n/en.js')

const BASE = {
  schema: 1,
  id: 'my-lang',
  name: '我的语言',
  description: '测试语言包',
  author: 'Tester',
  version: '1.0.0',
  license: 'MIT License\n\nPermission is hereby granted.',
  locale: 'zh-CN',
  messages: { settings: '设置啊', newChat: '新对话啊' },
}

const packOf = (overrides = {}) => ({ ...BASE, ...overrides })

const expectCode = (text, code) => {
  assert.throws(
    () => parseLocalePackText(text),
    (error) => {
      assert.ok(error instanceof LocalePackError, `expected LocalePackError, got ${error?.name}`)
      assert.equal(error.code, code)
      return true
    },
    `expected LocalePackError code ${code}`
  )
}

test('合法语言包：字段 trim、messages 采纳 / 跳过 / 缺失统计', () => {
  const parsed = parseLocalePackText(
    JSON.stringify(
      packOf({
        name: '  我的语言  ',
        messages: { settings: '设置啊', 'unknown.key': 'ignored', newChat: '新对话啊' },
      })
    )
  )
  assert.equal(parsed.pack.schema, 1)
  assert.equal(parsed.pack.name, '我的语言')
  assert.equal(parsed.pack.id, 'my-lang')
  assert.equal(parsed.importedKeys, 2)
  assert.equal(parsed.skippedKeys, 1)
  assert.equal(parsed.missingKeys, translationKeys.length - 2)
  assert.equal(parsed.pack.messages['unknown.key'], undefined)
  assert.equal(parsed.pack.messages.settings, '设置啊')
})

test('字段校验：JSON / schema / id / 保留 id / 必填 / messages 结构 / 大小', () => {
  expectCode('not json', 'badJson')
  expectCode('null', 'badSchema')
  expectCode(JSON.stringify(packOf({ schema: 2 })), 'badSchema')
  expectCode(JSON.stringify(packOf({ id: 'Bad Id' })), 'badId')
  expectCode(JSON.stringify(packOf({ id: '' })), 'badId')
  expectCode(JSON.stringify(packOf({ id: 'zh' })), 'reservedId')
  expectCode(JSON.stringify(packOf({ id: 'en' })), 'reservedId')
  // 大写不在 id 允许字符集内，先按非法 id 拒绝
  expectCode(JSON.stringify(packOf({ id: 'ZH' })), 'badId')
  assert.ok(LOCALE_ID_PATTERN.test('a.b_c-d'))
  for (const field of ['name', 'description', 'author', 'version', 'license', 'locale']) {
    expectCode(JSON.stringify(packOf({ [field]: '   ' })), 'missingField')
    expectCode(JSON.stringify(packOf({ [field]: 42 })), 'missingField')
  }
  expectCode(JSON.stringify(packOf({ messages: [] })), 'badMessages')
  expectCode(JSON.stringify(packOf({ messages: { settings: 42 } })), 'badMessages')
  expectCode(
    JSON.stringify(packOf({ license: 'x'.repeat(MAX_LOCALE_LICENSE_BYTES + 1) })),
    'tooLarge'
  )
})

test('导出内置中文：文件名为 <id>-locale.json、元信息用内置、全部 key 完整、license 为 MIT', () => {
  const exported = buildLocalePackExport('zh-CN', () => undefined)
  assert.equal(exported.filename, `${BUILTIN_LOCALE_METADATA['zh-CN'].id}-locale.json`)
  const pack = JSON.parse(exported.json)
  assert.equal(pack.schema, 1)
  assert.equal(pack.id, BUILTIN_LOCALE_METADATA['zh-CN'].id)
  assert.equal(pack.name, BUILTIN_LOCALE_METADATA['zh-CN'].name)
  assert.equal(pack.author, BUILTIN_LOCALE_METADATA['zh-CN'].author)
  assert.equal(pack.version, BUILTIN_LOCALE_METADATA['zh-CN'].version)
  assert.equal(pack.license, MIT_LICENSE_TEXT)
  assert.equal(pack.locale, 'zh-CN')
  assert.deepEqual(Object.keys(pack.messages).sort(), Object.keys(zh).sort())
  // 内置导出可直接再导入（id 不是 zh/en 保留 id）
  const parsed = parseLocalePackText(exported.json)
  assert.equal(parsed.skippedKeys, 0)
  assert.equal(parsed.missingKeys, 0)
  assert.equal(parsed.pack.name, pack.name)
})

test('导出内置英文与导出前改名：导入导出可往返', () => {
  const enExport = JSON.parse(buildLocalePackExport('en-US', () => undefined).json)
  assert.equal(enExport.id, BUILTIN_LOCALE_METADATA['en-US'].id)
  assert.equal(enExport.messages.settings, en.settings)

  // 模拟「导出 → 改文案 / 改 name → 再导入」
  const edited = { ...enExport, name: 'My English', messages: { ...enExport.messages, settings: 'Prefs!' } }
  const parsed = parseLocalePackText(JSON.stringify(edited))
  assert.equal(parsed.pack.id, 'aurora-en')
  assert.equal(parsed.pack.name, 'My English')
  assert.equal(parsed.pack.messages.settings, 'Prefs!')
  assert.equal(parsed.skippedKeys, 0)
})

test('导出自定义语言：用语言包自身元信息，缺失 key 回退内置当前语言与英文', () => {
  const custom = {
    id: 'my-lang',
    name: '我的语言',
    description: 'desc',
    author: 'Tester',
    version: '2.0.0',
    license: 'Custom License',
    locale: 'zh-CN',
    messages: { settings: '我的设置' },
  }
  const findPack = (id) => (id === custom.id ? custom : undefined)
  const exported = buildLocalePackExport(`custom:${custom.id}`, findPack)
  assert.equal(exported.filename, 'my-lang-locale.json')
  const pack = JSON.parse(exported.json)
  assert.equal(pack.id, custom.id)
  assert.equal(pack.name, custom.name)
  assert.equal(pack.author, custom.author)
  assert.equal(pack.version, custom.version)
  assert.equal(pack.license, custom.license)
  assert.equal(pack.messages.settings, '我的设置')
  // 未提供的 key 回退 zh（base locale），而不是空串
  assert.equal(pack.messages.newChat, zh.newChat)
  assert.equal(Object.keys(pack.messages).length, translationKeys.length)
})

test('查表顺序：自定义 messages → 内置当前语言 → 内置英文兜底', () => {
  const pack = { locale: 'zh-CN', messages: { settings: '自定义设置' } }
  const resolve = (id) => (id === 'pack-1' ? pack : undefined)
  // 自定义命中
  assert.equal(lookupMessage('settings', 'custom:pack-1', resolve), '自定义设置')
  // 自定义缺失 → 内置中文
  assert.equal(lookupMessage('newChat', 'custom:pack-1', resolve), zh.newChat)
  // 自定义语言（base en-US）缺失 → 内置英文
  const enPack = { locale: 'en-US', messages: {} }
  const resolveEn = () => enPack
  assert.equal(lookupMessage('settings', 'custom:en-pack', resolveEn), en.settings)
  // 内置语言自身缺失 → 英文兜底（这里用一个人为构造的 key 不会命中，返回 key 本身）
  assert.equal(lookupMessage('does.not.exist', 'zh-CN'), 'does.not.exist')
})
