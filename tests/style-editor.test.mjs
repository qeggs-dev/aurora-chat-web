// Style pack editor logic (src/services/style/editor.ts, export.ts): id generation,
// field-level validation, draft → StoredStylePack assembly and zip export round-trip
// through the existing parseStylePackZip importer.
import assert from 'node:assert/strict'
import { test } from 'node:test'

const editor = await import('../.test-build/services/style/editor.js')
const exporter = await import('../.test-build/services/style/export.js')
const { parseStylePackZip } = await import('../.test-build/services/style/zip.js')
const types = await import('../.test-build/services/style/types.js')

const { STYLE_PREFIX, STYLE_SLOTS, PALETTE_KEYS } = types
const P = STYLE_PREFIX

/** 造一个指定大小 / 扩展名的假文件（内容不要求是合法图片，解析器只看扩展名与大小） */
const fakeFile = (name, size = 32) =>
  new File([new Uint8Array(size)], name, { type: 'application/octet-stream' })

const pngFile = (name = 'img.png', size = 32) => fakeFile(name, size)

/** 最小可保存草稿：一张背景图 + 必填文本 */
const makeDraft = (overrides = {}) => {
  const draft = editor.createStyleEditorDraft({ id: 'custom-demo', theme: 'light' })
  draft.name = 'Demo'
  draft.author = 'Tester'
  draft.copyright = '© 2026 Tester'
  draft.backgrounds.light[STYLE_SLOTS.bgMain] = {
    ...editor.createDraftFile(pngFile('main.png'), 'main.png'),
    fit: 'contain',
    align: 'custom',
    position: '50% 20%',
    render: 'pixelated',
    effects: { window: { x1: 0.1, y1: 0.1, x2: 0.9, y2: 0.9 }, zoom: 1.2 },
  }
  return Object.assign(draft, overrides)
}

const codesOf = (issues) => issues.map((issue) => `${issue.path}:${issue.code}`)

test('createStylePackId：custom-<timestamp36>、合法且冲突时加后缀', () => {
  const id = editor.createStylePackId(1_700_000_000_000)
  assert.match(id, /^custom-[0-9a-z]+$/)
  assert.match(editor.styleDraftAssetPath.font('light', 'woff2'), /^assets\//)
  // 时间戳 36 进制；与已有 id 冲突时补 -2、-3
  const next = editor.createStylePackId(1_700_000_000_000, [id])
  assert.equal(next, `${id}-2`)
  assert.equal(editor.createStylePackId(1_700_000_000_000, [id, `${id}-2`]), `${id}-3`)
})

test('createStyleEditorDraft：默认版本 1.0.0、空资源、按主题分组', () => {
  const draft = editor.createStyleEditorDraft({ id: 'custom-x', theme: 'dark' })
  assert.equal(draft.version, '1.0.0')
  assert.equal(draft.theme, 'dark')
  assert.deepEqual(draft.backgrounds, { light: {}, dark: {} })
  assert.deepEqual(draft.icons, { light: {}, dark: {} })
  assert.deepEqual(draft.palette, { light: {}, dark: {} })
  assert.equal(draft.name, '')
})

test('validateStyleDraft：合法草稿无错误；缺资源 / 缺必填文本被拒', () => {
  assert.deepEqual(editor.validateStyleDraft(makeDraft()), [])

  const empty = editor.createStyleEditorDraft({ id: 'custom-demo' })
  const codes = codesOf(editor.validateStyleDraft(empty))
  assert.ok(codes.includes('name:required'))
  assert.ok(codes.includes('author:required'))
  assert.ok(codes.includes('version:required') === false, '版本有默认值 1.0.0')
  assert.ok(codes.includes('copyright:required'))
  assert.ok(codes.includes('assets:noAssets'))
})

test('validateStyleDraft：id 格式 / 内置包 id / 超长 / 不安全文本', () => {
  const badId = makeDraft({ id: 'Bad Pack!' })
  assert.ok(codesOf(editor.validateStyleDraft(badId)).includes('id:badId'))

  const reserved = makeDraft({ id: 'aurora' })
  assert.ok(codesOf(editor.validateStyleDraft(reserved)).includes('id:reservedId'))

  const longName = makeDraft({ name: 'x'.repeat(81) })
  assert.ok(codesOf(editor.validateStyleDraft(longName)).includes('name:tooLong'))

  const unsafe = makeDraft({ author: '<script>' })
  assert.ok(codesOf(editor.validateStyleDraft(unsafe)).includes('author:unsafeText'))
})

test('validateStyleDraft：非法颜色 / 文件类型 / 大小 / 空文件 / position', () => {
  const badColor = makeDraft()
  badColor.palette.light.accent = 'url(evil)'
  assert.ok(
    codesOf(editor.validateStyleDraft(badColor)).includes(`palette.light.accent:badColor`)
  )

  const badType = makeDraft()
  badType.backgrounds.light[STYLE_SLOTS.bgChat] = {
    ...editor.createDraftFile(fakeFile('x.txt'), 'x.txt'),
  }
  assert.ok(
    codesOf(editor.validateStyleDraft(badType)).includes(
      `backgrounds.light.${STYLE_SLOTS.bgChat}:badFileType`
    )
  )

  const tooLargeBg = makeDraft()
  tooLargeBg.backgrounds.light[STYLE_SLOTS.bgChat] = {
    ...editor.createDraftFile(fakeFile('big.png', editor.MAX_BACKGROUND_FILE_BYTES + 1), 'big.png'),
  }
  assert.ok(
    codesOf(editor.validateStyleDraft(tooLargeBg)).includes(
      `backgrounds.light.${STYLE_SLOTS.bgChat}:tooLarge`
    )
  )

  const tooLargeIcon = makeDraft()
  tooLargeIcon.icons.light[STYLE_SLOTS.iconSend] = {
    ...editor.createDraftFile(fakeFile('big.svg', editor.MAX_ICON_FILE_BYTES + 1), 'big.svg'),
  }
  assert.ok(
    codesOf(editor.validateStyleDraft(tooLargeIcon)).includes(
      `icons.light.${STYLE_SLOTS.iconSend}:tooLarge`
    )
  )

  const zero = makeDraft()
  zero.icons.light[STYLE_SLOTS.iconSend] = {
    ...editor.createDraftFile(fakeFile('empty.png', 0), 'empty.png'),
  }
  assert.ok(
    codesOf(editor.validateStyleDraft(zero)).includes(
      `icons.light.${STYLE_SLOTS.iconSend}:emptyFile`
    )
  )

  const badPosition = makeDraft()
  badPosition.backgrounds.light[STYLE_SLOTS.bgMain].position = 'url(x)'
  assert.ok(
    codesOf(editor.validateStyleDraft(badPosition)).includes(
      `backgrounds.light.${STYLE_SLOTS.bgMain}.position:badPosition`
    )
  )

  const coverGif = makeDraft()
  coverGif.covers.light = editor.createDraftFile(fakeFile('cover.gif'), 'cover.gif')
  assert.ok(codesOf(editor.validateStyleDraft(coverGif)).includes('covers.light:badFileType'))
})

test('validateStyleDraft：effects 范围与 tilt 允许矩阵', () => {
  const badZoom = makeDraft()
  badZoom.backgrounds.light[STYLE_SLOTS.bgMain].effects = { zoom: 5 }
  assert.ok(
    codesOf(editor.validateStyleDraft(badZoom)).includes(
      `backgrounds.light.${STYLE_SLOTS.bgMain}:badEffect`
    )
  )

  const backgroundTilt = makeDraft()
  backgroundTilt.backgrounds.light[STYLE_SLOTS.bgMain].effects = {
    tilt: { maxAngle: 10 },
  }
  assert.ok(
    codesOf(editor.validateStyleDraft(backgroundTilt)).includes(
      `backgrounds.light.${STYLE_SLOTS.bgMain}:badEffect`
    )
  )

  const iconEffects = makeDraft()
  iconEffects.icons.light[STYLE_SLOTS.iconSend] = {
    ...editor.createDraftFile(pngFile('send.png'), 'send.png'),
    render: 'pixelated',
    effects: {
      opacity: 0.9,
      shadow: { x: 0, y: 4, blur: 12, color: '#00000066' },
      outerGlow: { radius: 10, color: '#7fd4ff', intensity: 0.8 },
      window: { x1: 0, y1: 0, x2: 1, y2: 1 },
      zoom: 1.25,
      tilt: { maxAngle: 12, perspective: 700, scale: 1.02 },
    },
  }
  assert.deepEqual(editor.validateStyleDraft(iconEffects), [])

  const badEffectColor = makeDraft()
  badEffectColor.icons.light[STYLE_SLOTS.iconSend] = {
    ...editor.createDraftFile(pngFile('send.png'), 'send.png'),
    effects: { stroke: { width: 2, color: 'not-a-color' } },
  }
  assert.ok(
    codesOf(editor.validateStyleDraft(badEffectColor)).includes(
      `icons.light.${STYLE_SLOTS.iconSend}:badColor`
    )
  )
})

test('draftToStoredStylePack：清单 / 资源 / LICENSE / builtin / importedAt', () => {
  const draft = makeDraft()
  draft.description = 'A demo pack'
  draft.sidebarTitle = 'Aurora'
  draft.icons.light[STYLE_SLOTS.iconSend] = {
    ...editor.createDraftFile(pngFile('send.png'), 'send.png'),
    render: 'pixelated',
  }
  draft.fonts.dark = editor.createDraftFile(fakeFile('font.woff2'), 'font.woff2')
  draft.packIcons.light = editor.createDraftFile(pngFile('icon.png'), 'icon.png')
  draft.covers.dark = editor.createDraftFile(pngFile('cover.png'), 'cover.png')
  draft.palette.light = { background: '#112233', accent: '#445566' }
  draft.licenseText = 'MIT License text'

  const stored = editor.draftToStoredStylePack(draft, { importedAt: 123 })
  assert.equal(stored.id, 'custom-demo')
  assert.equal(stored.builtin, false)
  assert.equal(stored.importedAt, 123)
  assert.equal(stored.manifest.schema, 1)
  assert.equal(stored.manifest.name, 'Demo')
  assert.equal(stored.manifest.author, 'Tester')
  assert.equal(stored.manifest.version, '1.0.0')
  assert.equal(stored.manifest.description, 'A demo pack')
  assert.equal(stored.manifest.sidebarTitle, 'Aurora')
  assert.equal(stored.license, '© 2026 Tester\n\nMIT License text')
  assert.equal(stored.editor.copyright, '© 2026 Tester')
  assert.equal(stored.editor.licenseText, 'MIT License text')

  const bgId = `${STYLE_SLOTS.bgMain}.light`
  assert.ok(stored.assets[bgId] instanceof Blob)
  assert.equal(stored.manifest.assets[bgId].file, 'assets/light/main.png')
  assert.equal(stored.manifest.assets[bgId].fit, 'contain')
  assert.equal(stored.manifest.assets[bgId].align, 'custom')
  assert.equal(stored.manifest.assets[bgId].position, '50% 20%')
  assert.equal(stored.manifest.assets[bgId].render, 'pixelated')
  assert.deepEqual(stored.manifest.assets[bgId].effects, {
    window: { x1: 0.1, y1: 0.1, x2: 0.9, y2: 0.9 },
    zoom: 1.2,
  })

  const iconId = `${STYLE_SLOTS.iconSend}.light`
  assert.equal(stored.manifest.assets[iconId].render, 'pixelated')
  assert.ok(stored.icon.light instanceof Blob)
  assert.ok(stored.cover.dark instanceof Blob)
  assert.ok(stored.assets[`${STYLE_SLOTS.font}.dark`] instanceof Blob)
  assert.deepEqual(stored.manifest.color_palette, {
    light: { background: '#112233', accent: '#445566' },
  })
  assert.deepEqual(stored.manifest.license, { file: 'LICENSE' })

  const withoutTime = editor.draftToStoredStylePack(draft)
  assert.ok(withoutTime.importedAt > 0)

  // storedPackToDraft 往返：文本 / 资源 / 效果 / 配色都能还原
  const restored = editor.storedPackToDraft(stored, { theme: 'dark' })
  assert.equal(restored.name, 'Demo')
  assert.equal(restored.author, 'Tester')
  assert.equal(restored.sidebarTitle, 'Aurora')
  assert.equal(restored.theme, 'dark')
  assert.equal(restored.copyright, '© 2026 Tester')
  assert.equal(restored.licenseText, 'MIT License text')
  assert.equal(restored.palette.light.accent, '#445566')
  assert.equal(restored.backgrounds.light[STYLE_SLOTS.bgMain].fit, 'contain')
  assert.deepEqual(restored.backgrounds.light[STYLE_SLOTS.bgMain].effects, {
    window: { x1: 0.1, y1: 0.1, x2: 0.9, y2: 0.9 },
    zoom: 1.2,
  })
  assert.equal(restored.icons.light[STYLE_SLOTS.iconSend].render, 'pixelated')
  // 字体 / 图标 / 封面的展示文件名来自包内路径（保存时按主题命名）
  assert.equal(restored.fonts.dark.fileName, 'dark.woff2')
  assert.equal(restored.packIcons.light.fileName, 'icon.png')
  assert.equal(restored.covers.dark.fileName, 'cover.png')
  assert.deepEqual(editor.validateStyleDraft(restored), [])
})

test('compileStyleDraft：资源 ID 唯一、LICENSE 与 index 文件都在导出文件列表里', () => {
  const draft = makeDraft()
  draft.icons.light[STYLE_SLOTS.iconSend] = {
    ...editor.createDraftFile(pngFile('send.png'), 'send.png'),
    effects: { tilt: { maxAngle: 12 } },
  }
  const compiled = editor.compileStyleDraft(draft)
  const paths = compiled.files.map((file) => file.path)
  assert.equal(new Set(paths).size, paths.length, '导出文件路径不应重复')
  const assetIds = Object.keys(compiled.manifest.assets)
  assert.equal(new Set(assetIds).size, assetIds.length, '资源 ID 不应重复')
  assert.ok(paths.includes('LICENSE'))
  assert.ok(paths.includes('assets/light/main.png'))
  assert.ok(paths.includes('assets/icons/light/send.png'))
  // 图标允许 tilt
  assert.deepEqual(compiled.manifest.assets[`${STYLE_SLOTS.iconSend}.light`].effects, {
    tilt: { maxAngle: 12 },
  })
})

test('export：导出 zip 可被 parseStylePackZip 重新解析（round-trip）', async () => {
  const draft = makeDraft()
  draft.description = 'round trip'
  draft.sidebarTitle = 'Round Trip'
  draft.licenseText = 'MIT License\n\nPermission is hereby granted.'
  draft.backgrounds.dark[STYLE_SLOTS.bgChat] = {
    ...editor.createDraftFile(pngFile('chat.png', 48), 'chat.png'),
    fit: 'cover',
  }
  draft.icons.light[STYLE_SLOTS.iconSend] = {
    ...editor.createDraftFile(pngFile('send.png'), 'send.png'),
    render: 'pixelated',
    effects: {
      opacity: 0.95,
      shadow: { x: 0, y: 4, blur: 12, color: '#00000066' },
      tilt: { maxAngle: 12, perspective: 700, scale: 1.02 },
    },
  }
  draft.fonts.light = editor.createDraftFile(fakeFile('font.woff2', 64), 'font.woff2')
  draft.packIcons.light = editor.createDraftFile(pngFile('icon.png'), 'icon.png')
  draft.covers.dark = editor.createDraftFile(pngFile('cover.png'), 'cover.png')
  draft.palette.dark = { background: '#0b1020', text: 'rgba(232,237,255,0.9)' }

  const exported = await exporter.buildStylePackZip(draft)
  assert.equal(exported.name, 'custom-demo.zip')
  assert.ok(exported.size > 0)

  const parsed = await parseStylePackZip(
    new File([await exported.blob.arrayBuffer()], exported.name, { type: 'application/zip' })
  )
  assert.equal(parsed.manifest.id, 'custom-demo')
  assert.equal(parsed.manifest.name, 'Demo')
  assert.equal(parsed.manifest.sidebarTitle, 'Round Trip')
  assert.equal(parsed.manifest.description, 'round trip')
  assert.equal(parsed.license, '© 2026 Tester\n\nMIT License\n\nPermission is hereby granted.')

  const bgId = `${STYLE_SLOTS.bgMain}.light`
  assert.ok(parsed.assets[bgId]?.blob.size > 0)
  assert.equal(parsed.manifest.assets[bgId].fit, 'contain')
  assert.equal(parsed.manifest.assets[bgId].position, '50% 20%')
  assert.deepEqual(parsed.manifest.assets[bgId].effects, {
    window: { x1: 0.1, y1: 0.1, x2: 0.9, y2: 0.9 },
    zoom: 1.2,
  })
  assert.ok(parsed.assets[`${STYLE_SLOTS.bgChat}.dark`]?.blob.size > 0)

  const iconId = `${STYLE_SLOTS.iconSend}.light`
  assert.equal(parsed.manifest.assets[iconId].render, 'pixelated')
  assert.deepEqual(parsed.manifest.assets[iconId].effects, {
    opacity: 0.95,
    shadow: { x: 0, y: 4, blur: 12, color: '#00000066' },
    tilt: { maxAngle: 12, perspective: 700, scale: 1.02 },
  })

  assert.ok(parsed.assets[`${STYLE_SLOTS.font}.light`]?.blob.size > 0)
  assert.ok(parsed.icon.light instanceof Blob)
  assert.ok(parsed.cover.dark instanceof Blob)
  assert.deepEqual(parsed.manifest.color_palette, {
    dark: { background: '#0b1020', text: 'rgba(232,237,255,0.9)' },
  })
  assert.equal(parsed.ignored.length, 0)
})

test('LICENSE 文本拼接 / 拆分往返；导出清单包含全部 PALETTE_KEYS 时颜色保持', async () => {
  const draft = makeDraft()
  draft.copyright = '© 2026 A'
  draft.licenseText = 'Body line 1\nBody line 2'
  assert.equal(editor.composeLicenseText(draft), '© 2026 A\n\nBody line 1\nBody line 2')
  assert.deepEqual(editor.splitLicenseText(editor.composeLicenseText(draft)), {
    copyright: '© 2026 A',
    licenseText: 'Body line 1\nBody line 2',
  })
  assert.deepEqual(editor.splitLicenseText(undefined), { copyright: '', licenseText: '' })

  for (const key of PALETTE_KEYS) {
    draft.palette.light[key] = '#123456'
  }
  const exported = await exporter.buildStylePackZip(draft)
  const parsed = await parseStylePackZip(
    new File([await exported.blob.arrayBuffer()], exported.name, { type: 'application/zip' })
  )
  assert.equal(Object.keys(parsed.manifest.color_palette.light).length, PALETTE_KEYS.length)
  for (const key of PALETTE_KEYS) {
    assert.equal(parsed.manifest.color_palette.light[key], '#123456')
  }
})
