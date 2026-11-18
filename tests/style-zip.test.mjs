// Style pack zip parsing (src/services/style/zip.ts): manifest validation, default path
// resolution, asset option/effect boundaries, palette and zip safety limits.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { strToU8, zipSync } from 'fflate'

const { StylePackError, parseStylePackZip } = await import('../.test-build/services/style/zip.js')
const { STYLE_PREFIX } = await import('../.test-build/services/style/types.js')

const P = STYLE_PREFIX

const manifest = (overrides = {}) => ({ schema: 1, id: 'demo-pack', name: 'Demo Pack', assets: {}, ...overrides })

const makeZip = (index, extra = {}) =>
  new File(
    [
      zipSync({
        'index.json': strToU8(typeof index === 'string' ? index : JSON.stringify(index)),
        ...extra,
      }),
    ],
    'style.zip',
    { type: 'application/zip' }
  )

const expectCode = async (promise, code) => {
  await assert.rejects(
    promise,
    (error) => {
      assert.ok(error instanceof StylePackError, `expected StylePackError, got ${error?.name}`)
      assert.equal(error.code, code)
      return true
    },
    `expected StylePackError code ${code}`
  )
}

test('最小清单：assets 必填，其余可选字段缺省', async () => {
  const parsed = await parseStylePackZip(makeZip(manifest()))
  assert.equal(parsed.manifest.schema, 1)
  assert.equal(parsed.manifest.id, 'demo-pack')
  assert.equal(parsed.manifest.name, 'Demo Pack')
  assert.deepEqual(parsed.manifest.assets, {})
  assert.deepEqual(parsed.assets, {})
  assert.equal(parsed.manifest.icon, undefined)
  assert.equal(parsed.manifest.cover, undefined)
  assert.equal(parsed.manifest.license, undefined)
  assert.equal(parsed.license, undefined)
  assert.deepEqual(parsed.icon, {})
  assert.deepEqual(parsed.cover, {})
  assert.deepEqual(parsed.ignored, [])
})

test('清单基本字段校验：schema / id / name / assets 结构', async () => {
  await expectCode(parseStylePackZip(makeZip(manifest({ schema: 2 }))), 'badIndex')
  await expectCode(parseStylePackZip(makeZip(manifest({ id: 'Bad Pack' }))), 'badIndex')
  await expectCode(parseStylePackZip(makeZip(manifest({ id: '' }))), 'badIndex')
  await expectCode(parseStylePackZip(makeZip(manifest({ name: '   ' }))), 'badIndex')
  await expectCode(parseStylePackZip(makeZip(manifest({ name: 'x'.repeat(81) }))), 'badIndex')
  await expectCode(parseStylePackZip(makeZip(manifest({ assets: null }))), 'badIndex')
  await expectCode(parseStylePackZip(makeZip(manifest({ assets: [] }))), 'badIndex')
  await expectCode(parseStylePackZip(makeZip('{invalid json')), 'badIndex')
})

test('zip 基础校验：非 zip / 无 index / index 不在根目录 / 条目过多 / 文件过大', async () => {
  await expectCode(parseStylePackZip(new File([strToU8('nope')], 'x.zip')), 'notZip')
  await expectCode(parseStylePackZip(new File([zipSync({})], 'x.zip')), 'noIndex')
  await expectCode(
    parseStylePackZip(
      new File([zipSync({ 'sub/index.json': strToU8(JSON.stringify(manifest())) })], 'x.zip')
    ),
    'noIndex'
  )

  const tooMany = { 'index.json': strToU8(JSON.stringify(manifest())) }
  for (let index = 0; index < 300; index += 1) {
    tooMany[`f${index}.txt`] = strToU8('x')
  }
  await expectCode(parseStylePackZip(new File([zipSync(tooMany)], 'x.zip')), 'tooManyFiles')

  const huge = new File([new Uint8Array(20 * 1024 * 1024 + 1)], 'x.zip')
  await expectCode(parseStylePackZip(huge), 'tooLarge')
})

test('zip 里显式的目录条目不影响导入（按文件条目计数）', async () => {
  // 常见 zip 工具会写入 assets/ 这类目录条目；它们没有内容，不应被当成非法路径
  const parsed = await parseStylePackZip(
    new File(
      [
        zipSync({
          'index.json': strToU8(JSON.stringify(manifest())),
          'assets/': new Uint8Array(0),
          'assets/icons/': new Uint8Array(0),
        }),
      ],
      'style.zip'
    )
  )
  assert.equal(parsed.manifest.id, 'demo-pack')
  assert.deepEqual(parsed.ignored, [])
})

test('路径穿越条目整包拒绝（badPath）', async () => {
  for (const badName of ['../evil.png', 'a/../b.png', 'a//b.png']) {
    await assert.rejects(
      parseStylePackZip(
        new File(
          [
            zipSync({
              'index.json': strToU8(JSON.stringify(manifest())),
              [badName]: strToU8('x'),
            }),
          ],
          'x.zip'
        )
      ),
      (error) => error instanceof StylePackError && error.code === 'badPath',
      `expected badPath for ${badName}`
    )
  }
})

test('assets：显式 file 严格读取，缺失文件 / 非对象拒绝；未知扩展名忽略', async () => {
  await expectCode(
    parseStylePackZip(makeZip(manifest({ assets: { [`${P}.icon.send.light`]: { file: 'missing.png' } } }))),
    'missingFile'
  )
  await expectCode(
    parseStylePackZip(makeZip(manifest({ assets: { [`${P}.icon.send.light`]: 'not-an-object' } }))),
    'missingFile'
  )
  const parsed = await parseStylePackZip(
    makeZip(
      manifest({
        assets: {
          [`${P}.icon.send.light`]: { file: 'img/send.png' },
          [`${P}.font.light`]: { file: 'font.woff2' },
          [`${P}.background.main.light`]: { file: 'notes.txt' },
          [`${P}.background.chat.light`]: { file: 'doc.pdf' },
        },
      }),
      {
        'img/send.png': new Uint8Array([1, 2, 3]),
        'font.woff2': new Uint8Array([4, 5]),
        'notes.txt': strToU8('text asset'),
        'doc.pdf': new Uint8Array([1]),
      }
    )
  )
  assert.equal(parsed.manifest.assets[`${P}.icon.send.light`].file, 'img/send.png')
  assert.equal(parsed.assets[`${P}.icon.send.light`].kind, 'image')
  assert.equal(parsed.assets[`${P}.font.light`].kind, 'font')
  // .txt 作为文本资源进入 assets；pdf 不在支持列表 → ignored
  assert.equal(parsed.assets[`${P}.background.main.light`].kind, 'font')
  assert.equal(parsed.assets[`${P}.background.chat.light`], undefined)
  assert.deepEqual(parsed.ignored, [`${P}.background.chat.light`])
})

test('assets：alpha / exposure 夹到边界，非数字回落默认', async () => {
  const parsed = await parseStylePackZip(
    makeZip(
      manifest({
        assets: {
          [`${P}.background.main.light`]: { file: 'a.png', alpha: 2, exposure: 5 },
          [`${P}.background.chat.light`]: { file: 'b.png', alpha: -1, exposure: -5 },
          [`${P}.background.sidebar.light`]: { file: 'c.png', alpha: 'x', exposure: Number.NaN },
        },
      }),
      { 'a.png': new Uint8Array([1]), 'b.png': new Uint8Array([1]), 'c.png': new Uint8Array([1]) }
    )
  )
  assert.equal(parsed.assets[`${P}.background.main.light`].alpha, 1)
  assert.equal(parsed.assets[`${P}.background.main.light`].exposure, 1)
  assert.equal(parsed.assets[`${P}.background.chat.light`].alpha, 0)
  assert.equal(parsed.assets[`${P}.background.chat.light`].exposure, -1)
  assert.equal(parsed.assets[`${P}.background.sidebar.light`].alpha, 1)
  assert.equal(parsed.assets[`${P}.background.sidebar.light`].exposure, 0)
})

test('assets：图片选项枚举与 position 边界（custom 必填 / 非 custom 忽略）', async () => {
  const imageEntry = (extra) => ({ file: 'a.png', ...extra })
  const base = (entry) =>
    makeZip(manifest({ assets: { [`${P}.background.main.light`]: entry } }), { 'a.png': new Uint8Array([1]) })

  await expectCode(parseStylePackZip(base(imageEntry({ fit: 'zoom' }))), 'badConfig')
  await expectCode(parseStylePackZip(base(imageEntry({ align: 'middle' }))), 'badConfig')
  await expectCode(parseStylePackZip(base(imageEntry({ render: 'nearest' }))), 'badConfig')
  await expectCode(parseStylePackZip(base(imageEntry({ align: 'custom' }))), 'badConfig')
  await expectCode(parseStylePackZip(base(imageEntry({ position: 'url(x)' }))), 'badConfig')

  const valid = await parseStylePackZip(
    base(imageEntry({ fit: 'tile', align: 'custom', position: '50% 20%', render: 'pixelated' }))
  )
  const entry = valid.manifest.assets[`${P}.background.main.light`]
  assert.equal(entry.fit, 'tile')
  assert.equal(entry.align, 'custom')
  assert.equal(entry.position, '50% 20%')
  assert.equal(entry.render, 'pixelated')

  // position 只在 align=custom 时生效：其它情况忽略并清掉
  const ignored = await parseStylePackZip(base(imageEntry({ align: 'center', position: '10px 20px' })))
  assert.equal(ignored.manifest.assets[`${P}.background.main.light`].position, undefined)
})

test('assets：图标只应用 render；字体 / 文本资源清掉图片选项与 effects', async () => {
  const parsed = await parseStylePackZip(
    makeZip(
      manifest({
        assets: {
          [`${P}.icon.send.light`]: {
            file: 'icon.png',
            fit: 'cover',
            align: 'center',
            render: 'pixelated',
            position: 'center',
          },
          [`${P}.font.light`]: {
            file: 'font.ttf',
            fit: 'cover',
            render: 'smooth',
            effects: { opacity: 0.5 },
          },
        },
      }),
      {
        'icon.png': new Uint8Array([1]),
        'font.ttf': new Uint8Array([1]),
      }
    )
  )
  const icon = parsed.manifest.assets[`${P}.icon.send.light`]
  assert.equal(icon.render, 'pixelated')
  assert.equal(icon.fit, undefined)
  assert.equal(icon.align, undefined)
  assert.equal(icon.position, undefined)

  const font = parsed.manifest.assets[`${P}.font.light`]
  assert.equal(font.fit, undefined)
  assert.equal(font.render, undefined)
  assert.equal(font.effects, undefined)
})

test('默认路径：背景 / 图标资源按主题目录与扩展名顺序补齐 file', async () => {
  const parsed = await parseStylePackZip(
    makeZip(
      manifest({
        assets: {
          [`${P}.background.main.light`]: {},
          [`${P}.icon.send.dark`]: {},
          [`${P}.font.light`]: {},
        },
      }),
      {
        'assets/light/main.png': new Uint8Array([1]),
        'assets/icons/send.svg': new Uint8Array([2]),
        'font.woff2': new Uint8Array([3]),
      }
    )
  )
  assert.equal(parsed.manifest.assets[`${P}.background.main.light`].file, 'assets/light/main.png')
  assert.equal(parsed.manifest.assets[`${P}.icon.send.dark`].file, 'assets/icons/send.svg')
  assert.equal(parsed.manifest.assets[`${P}.font.light`].file, 'font.woff2')
})

test('默认路径：没有主题后缀的资源与找不到默认位置的资源被跳过', async () => {
  const parsed = await parseStylePackZip(
    makeZip(
      manifest({
        assets: {
          [`${P}.background.main`]: {},
          [`${P}.icon.send.light`]: {},
        },
      }),
      { 'other.png': new Uint8Array([1]) }
    )
  )
  assert.deepEqual(parsed.manifest.assets, {})
  assert.deepEqual(parsed.assets, {})
})

test('effects 边界：数值区间 / CSS 颜色 / window 坐标 / 未知键忽略', async () => {
  const withEffects = (effects) =>
    makeZip(manifest({ assets: { [`${P}.icon.send.light`]: { file: 'a.png', effects } } }), {
      'a.png': new Uint8Array([1]),
    })
  await expectCode(parseStylePackZip(withEffects({ opacity: 2 })), 'badConfig')
  await expectCode(parseStylePackZip(withEffects({ zoom: 5 })), 'badConfig')
  await expectCode(parseStylePackZip(withEffects({ shadow: { x: 101 } })), 'badConfig')
  await expectCode(parseStylePackZip(withEffects({ shadow: { color: 'red' } })), 'badConfig')
  await expectCode(parseStylePackZip(withEffects({ window: { x1: 0.5, y1: 0, x2: 0.5, y2: 1 } })), 'badConfig')
  await expectCode(parseStylePackZip(withEffects({ window: { x1: 0 } })), 'badConfig')
  await expectCode(parseStylePackZip(withEffects('nope')), 'badConfig')

  const parsed = await parseStylePackZip(
    withEffects({
      opacity: 0.5,
      zoom: 2,
      unknownEffect: true,
      shadow: { x: -10, y: 10, blur: 5, color: 'rgba(0,0,0,0.5)' },
      window: { x1: 0, y1: 0, x2: 1, y2: 0.5 },
      tilt: { maxAngle: 15 },
    })
  )
  const entry = parsed.manifest.assets[`${P}.icon.send.light`]
  assert.equal(entry.effects.opacity, 0.5)
  assert.equal(entry.effects.zoom, 2)
  assert.equal(entry.effects.unknownEffect, undefined)
  assert.deepEqual(entry.effects.shadow, { x: -10, y: 10, blur: 5, color: 'rgba(0,0,0,0.5)' })
  assert.deepEqual(entry.effects.window, { x1: 0, y1: 0, x2: 1, y2: 0.5 })
  assert.deepEqual(entry.effects.tilt, { maxAngle: 15 })
})

test('背景下只保留 window / zoom（静态特效与 tilt 忽略）', async () => {
  const parsed = await parseStylePackZip(
    makeZip(
      manifest({
        assets: {
          [`${P}.background.main.light`]: {
            file: 'bg.png',
            effects: { window: { x1: 0, y1: 0, x2: 0.5, y2: 0.5 }, zoom: 1.5, stroke: {}, tilt: {} },
          },
          [`${P}.background.chat.light`]: {
            file: 'bg2.png',
            effects: { opacity: 0.5, shadow: {}, zoom: 2 },
          },
        },
      }),
      { 'bg.png': new Uint8Array([1]), 'bg2.png': new Uint8Array([1]) }
    )
  )
  assert.deepEqual(parsed.manifest.assets[`${P}.background.main.light`].effects, {
    window: { x1: 0, y1: 0, x2: 0.5, y2: 0.5 },
    zoom: 1.5,
  })
  assert.deepEqual(parsed.manifest.assets[`${P}.background.chat.light`].effects, { zoom: 2 })
})

test('包图标 / 封面：默认位置、主题写法、tilt 限制与封面扩展名 / 大小限制', async () => {
  // 默认位置优先主题目录；另一个主题找不到自己的默认位置时回退到已找到的文件 → 主题无关写法
  const defaultIcon = await parseStylePackZip(
    makeZip(manifest(), { 'assets/light/icon.png': new Uint8Array([1]) })
  )
  assert.deepEqual(defaultIcon.manifest.icon, { file: 'assets/light/icon.png' })
  assert.ok(defaultIcon.icon.light instanceof Blob)
  assert.ok(defaultIcon.icon.dark instanceof Blob)
  // 两个主题各自命中默认位置（根目录兜底）→ 按主题写法
  const bothThemes = await parseStylePackZip(
    makeZip(manifest(), {
      'assets/light/icon.png': new Uint8Array([1]),
      'assets/dark/icon.png': new Uint8Array([2]),
    })
  )
  assert.deepEqual(bothThemes.manifest.icon, {
    light: { file: 'assets/light/icon.png' },
    dark: { file: 'assets/dark/icon.png' },
  })

  // 主题写法：两个主题不同文件
  const themed = await parseStylePackZip(
    makeZip(manifest({ icon: { light: { file: 'l.png' }, dark: { file: 'd.png' } } }), {
      'l.png': new Uint8Array([1]),
      'd.png': new Uint8Array([2]),
    })
  )
  assert.deepEqual(themed.manifest.icon, {
    light: { file: 'l.png' },
    dark: { file: 'd.png' },
  })

  // 图标上的 tilt 非法；封面允许 tilt
  await expectCode(
    parseStylePackZip(makeZip(manifest({ icon: { file: 'icon.png', effects: { tilt: {} } } }), {
      'icon.png': new Uint8Array([1]),
    })),
    'badConfig'
  )
  const cover = await parseStylePackZip(
    makeZip(
      manifest({ cover: { file: 'cover.svg', effects: { tilt: { maxAngle: 10 } } } }),
      { 'cover.svg': strToU8('<svg/>') }
    )
  )
  assert.equal(cover.manifest.cover.file, 'cover.svg')
  assert.deepEqual(cover.manifest.cover.effects.tilt, { maxAngle: 10 })

  // 封面不接受 gif
  await expectCode(
    parseStylePackZip(makeZip(manifest({ cover: { file: 'cover.gif' } }), {
      'cover.gif': new Uint8Array([1]),
    })),
    'badFileType'
  )
  // 封面 > 5MB
  await expectCode(
    parseStylePackZip(makeZip(manifest({ cover: { file: 'cover.png' } }), {
      'cover.png': new Uint8Array(5 * 1024 * 1024 + 1),
    })),
    'badConfig'
  )
})

test('调色板：只认 13 个令牌与合法 CSS 颜色，light/dark 可单独缺省', async () => {
  const parsed = await parseStylePackZip(
    makeZip(
      manifest({
        color_palette: {
          light: { accent: '#ff0000', background: 'rgb(10, 20, 30)', text: 'hsl(120, 50%, 50%)' },
          dark: { mask: 'rgba(0,0,0,0.5)', surface: 'transparent', unknown: '#fff' },
        },
      })
    )
  )
  assert.deepEqual(parsed.manifest.color_palette.light, {
    accent: '#ff0000',
    background: 'rgb(10, 20, 30)',
    text: 'hsl(120, 50%, 50%)',
  })
  assert.deepEqual(parsed.manifest.color_palette.dark, {
    mask: 'rgba(0,0,0,0.5)',
    surface: 'transparent',
  })

  await expectCode(
    parseStylePackZip(makeZip(manifest({ color_palette: { light: { accent: 'url(x)' } } }))),
    'badIndex'
  )
  await expectCode(parseStylePackZip(makeZip(manifest({ color_palette: [] }))), 'badIndex')
})

test('文本字段安全边界：sidebarTitle 致命拒绝，其它描述字段丢弃；超长类型错误', async () => {
  await expectCode(parseStylePackZip(makeZip(manifest({ sidebarTitle: 'x'.repeat(41) }))), 'badIndex')
  await expectCode(parseStylePackZip(makeZip(manifest({ sidebarTitle: '<b>' }))), 'badConfig')
  const trimmed = await parseStylePackZip(makeZip(manifest({ sidebarTitle: '  my pack  ' })))
  assert.equal(trimmed.manifest.sidebarTitle, 'my pack')
  assert.equal((await parseStylePackZip(makeZip(manifest({ sidebarTitle: '   ' })))).manifest.sidebarTitle, undefined)

  const dropped = await parseStylePackZip(
    makeZip(manifest({ description: 'a <b>', author: 'ok', version: '1.0' }))
  )
  assert.equal(dropped.manifest.description, undefined)
  assert.equal(dropped.manifest.author, 'ok')
  assert.equal(dropped.manifest.version, '1.0')
  await expectCode(parseStylePackZip(makeZip(manifest({ description: 'x'.repeat(401) }))), 'badIndex')
  await expectCode(parseStylePackZip(makeZip(manifest({ author: 42 }))), 'badIndex')
})

test('license：默认位置发现并保留全文；含不安全字符时不展示；显式缺失报错', async () => {
  const found = await parseStylePackZip(
    makeZip(manifest(), { 'LICENSE.md': strToU8('MIT License\n\nPermission is granted') })
  )
  assert.equal(found.license, 'MIT License\n\nPermission is granted')
  assert.deepEqual(found.manifest.license, { file: 'LICENSE.md' })

  const unsafe = await parseStylePackZip(
    makeZip(manifest(), { 'LICENSE': strToU8('<script>alert(1)</script>') })
  )
  assert.equal(unsafe.license, undefined)
  // 解析后的清单仍指向实际条目（只是不展示全文）
  assert.deepEqual(unsafe.manifest.license, { file: 'LICENSE' })

  await expectCode(
    parseStylePackZip(makeZip(manifest({ license: { file: 'missing.txt' } }))),
    'missingFile'
  )

  const explicit = await parseStylePackZip(
    makeZip(manifest({ license: { file: 'legal/LICENSE' } }), { 'legal/LICENSE': strToU8('APL') })
  )
  assert.equal(explicit.license, 'APL')
  assert.deepEqual(explicit.manifest.license, { file: 'legal/LICENSE' })
})
