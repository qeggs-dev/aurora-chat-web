// Style pack effect summaries for the detail page (src/services/style/effectSummary.ts):
// only explicitly configured, non-default effect fields are shown; resources without
// custom effects fall back to "uses default effects".
import assert from 'node:assert/strict'
import { test } from 'node:test'

const summary = await import('../.test-build/services/style/effectSummary.js')

const PREFIX = 'dslike_chat.style_pkg'

test('summarizeEffects：没有 effects 或全为默认值时返回空数组', () => {
  assert.deepEqual(summary.summarizeEffects(undefined), [])
  assert.deepEqual(summary.summarizeEffects({}), [])
  // 显式写默认值不算自定义效果（opacity 1 / zoom 1 / shadow 默认四字段）
  assert.deepEqual(
    summary.summarizeEffects({
      opacity: 1,
      zoom: 1,
      shadow: { x: 0, y: 4, blur: 12, color: '#00000066' },
      window: { x1: 0, y1: 0, x2: 1, y2: 1 },
    }),
    []
  )
  assert.equal(summary.hasCustomEffects({ opacity: 1 }), false)
  assert.equal(summary.hasCustomEffects({ opacity: 0.8 }), true)
})

test('summarizeEffects：标量效果与 window 只保留非默认字段，顺序按规范键序', () => {
  const result = summary.summarizeEffects({
    zoom: 1.2,
    window: { x1: 0.25, y1: 0, x2: 0.75, y2: 1 },
  })
  // STYLE_EFFECT_KEYS 顺序：window 在 zoom 之前
  assert.deepEqual(result, [
    {
      group: 'window',
      values: [
        { field: 'x1', value: '0.25' },
        { field: 'x2', value: '0.75' },
      ],
    },
    { group: 'zoom', values: [{ value: '1.2' }] },
  ])
})

test('summarizeEffects：图标静态效果按组输出非默认字段（颜色默认值忽略、比较忽略大小写）', () => {
  const result = summary.summarizeEffects({
    outerGlow: { radius: 6, color: '#7FD4FF' },
    emboss: { depth: 2 },
    stroke: { width: 3, color: '#000000' },
  })
  assert.deepEqual(result, [
    {
      group: 'outerGlow',
      values: [
        { field: 'radius', value: '6' },
        { field: 'color', value: '#7FD4FF' },
      ],
    },
    { group: 'emboss', values: [{ field: 'depth', value: '2' }] },
    { group: 'stroke', values: [{ field: 'width', value: '3' }] },
  ])
  // 大小写不同的默认颜色仍视为默认值
  assert.deepEqual(summary.summarizeEffects({ shadow: { color: '#00000066' } }), [])
})

test('summarizeEffects：shadow / tilt 只展示显式且非默认的字段', () => {
  assert.deepEqual(summary.summarizeEffects({ shadow: { y: 6, color: '#11223344' } }), [
    {
      group: 'shadow',
      values: [
        { field: 'y', value: '6' },
        { field: 'color', value: '#11223344' },
      ],
    },
  ])
  assert.deepEqual(summary.summarizeEffects({ tilt: { maxAngle: 8 } }), [
    { group: 'tilt', values: [{ field: 'maxAngle', value: '8' }] },
  ])
  // 浮点尾差归一化，不出现 0.30000000000000004 这类值
  assert.deepEqual(summary.summarizeEffects({ opacity: 0.1 + 0.2 }), [
    { group: 'opacity', values: [{ value: '0.3' }] },
  ])
})

test('styleAssetLabel：去掉统一前缀与主题后缀', () => {
  assert.equal(summary.styleAssetLabel(`${PREFIX}.background.main.light`), 'background.main')
  assert.equal(summary.styleAssetLabel(`${PREFIX}.icon.send.dark`), 'icon.send')
})

test('collectThemeEffectResources：只列当前主题的资源，包图标 / 封面排在最后', () => {
  const manifest = {
    schema: 1,
    id: 'fx-demo',
    name: 'FX demo',
    icon: { light: { file: 'assets/light/icon.png', effects: { zoom: 1.5 } } },
    cover: { light: { file: 'assets/light/cover.png' } },
    assets: {
      [`${PREFIX}.background.main.light`]: {
        file: 'assets/light/main.png',
        effects: { window: { x1: 0, y1: 0, x2: 0.5, y2: 1 } },
      },
      [`${PREFIX}.icon.send.light`]: { file: 'assets/icons/light/send.png' },
      [`${PREFIX}.font.light`]: { file: 'assets/fonts/light.ttf' },
      [`${PREFIX}.icon.send.dark`]: { file: 'assets/icons/dark/send.png' },
      [`${PREFIX}.background.main.dark`]: { file: 'assets/dark/main.png' },
    },
  }
  const light = summary.collectThemeEffectResources(manifest, 'light')
  assert.deepEqual(
    light.map((resource) => [resource.id, resource.kind, resource.file]),
    [
      [`${PREFIX}.background.main.light`, 'background', 'assets/light/main.png'],
      [`${PREFIX}.icon.send.light`, 'icon', 'assets/icons/light/send.png'],
      [`${PREFIX}.font.light`, 'font', 'assets/fonts/light.ttf'],
      ['icon', 'packIcon', 'assets/light/icon.png'],
      ['cover', 'cover', 'assets/light/cover.png'],
    ]
  )
  // 主题无关写法里缺失的主题不跨主题借用（dark 没有包图标 / 封面）
  const dark = summary.collectThemeEffectResources(manifest, 'dark')
  assert.deepEqual(
    dark.map((resource) => [resource.id, resource.kind]),
    [
      [`${PREFIX}.icon.send.dark`, 'icon'],
      [`${PREFIX}.background.main.dark`, 'background'],
    ]
  )
})
