// Style pack enum labels (src/components/style-editor/labels.ts): every user-visible enum
// (effect groups, effect fields, palette tokens, fit / align / render) must have zh + en
// translations, and unknown values must fall back to a localized generic label instead of
// the raw technical name.
import assert from 'node:assert/strict'
import { test } from 'node:test'

const labels = await import('../.test-build/components/style-editor/labels.js')
const types = await import('../.test-build/services/style/types.js')
const effectSummary = await import('../.test-build/services/style/effectSummary.js')
const { zh } = await import('../.test-build/i18n/zh.js')
const { en } = await import('../.test-build/i18n/en.js')

const assertTranslated = (map, values, name) => {
  for (const value of values) {
    const key = map[value]
    assert.ok(key, `${name} 缺少枚举 ${value} 的映射`)
    assert.equal(typeof zh[key], 'string', `${name}.${value} 缺中文文案（key: ${key}）`)
    assert.equal(typeof en[key], 'string', `${name}.${value} 缺英文文案（key: ${key}）`)
    assert.ok(zh[key].trim(), `${name}.${value} 中文文案为空`)
    assert.ok(en[key].trim(), `${name}.${value} 英文文案为空`)
    assert.notEqual(zh[key], value, `${name}.${value} 中文文案不能是原始技术值`)
    assert.notEqual(en[key], value, `${name}.${value} 英文文案不能是原始技术值`)
  }
}

test('效果组：每个技术枚举都有中英映射，且不是原始技术名', () => {
  assertTranslated(labels.EFFECT_GROUP_LABEL_KEYS, types.STYLE_EFFECT_KEYS, 'effectGroup')
  assert.equal(
    Object.keys(labels.EFFECT_GROUP_LABEL_KEYS).length,
    types.STYLE_EFFECT_KEYS.length,
    '效果组映射数量应与 STYLE_EFFECT_KEYS 一致'
  )
  // 抽查默认语言下的展示（英文首字母大写 / 中文完全本地化）
  assert.equal(zh[labels.effectGroupLabelKey('outerGlow')], '外发光')
  assert.equal(en[labels.effectGroupLabelKey('outerGlow')], 'Outer glow')
  assert.equal(zh[labels.effectGroupLabelKey('window')], '裁剪区域')
  assert.equal(en[labels.effectGroupLabelKey('window')], 'Crop area')
})

test('效果字段：EFFECT_FIELD_ORDER 里出现的字段全部有中英映射', () => {
  const fields = new Set()
  for (const order of Object.values(effectSummary.EFFECT_FIELD_ORDER)) {
    for (const field of order) {
      fields.add(field)
    }
  }
  assert.ok(fields.size > 0, 'EFFECT_FIELD_ORDER 不应为空')
  assertTranslated(labels.EFFECT_FIELD_LABEL_KEYS, [...fields], 'effectField')
  // 映射表里不应留下未覆盖的字段
  for (const field of Object.keys(labels.EFFECT_FIELD_LABEL_KEYS)) {
    assert.ok(fields.has(field), `效果字段映射表包含未使用的字段: ${field}`)
  }
  assert.equal(zh[labels.effectFieldLabelKey('blur')], '模糊')
  assert.equal(en[labels.effectFieldLabelKey('blur')], 'Blur')
  assert.equal(zh[labels.effectFieldLabelKey('maxAngle')], '最大角度')
})

test('fit / align / render：每个枚举值都有中英映射，且不是原始技术值', () => {
  assertTranslated(labels.STYLE_FIT_LABEL_KEYS, types.STYLE_FITS, 'fit')
  assertTranslated(labels.STYLE_ALIGN_LABEL_KEYS, types.STYLE_ALIGNS, 'align')
  assertTranslated(labels.STYLE_RENDER_LABEL_KEYS, types.STYLE_RENDERS, 'render')
  assert.equal(zh[labels.styleFitLabelKey('cover')], '铺满裁切')
  assert.equal(en[labels.styleFitLabelKey('cover')], 'Cover (crop)')
  assert.equal(zh[labels.styleAlignLabelKey('custom')], '自定义')
  assert.equal(en[labels.styleAlignLabelKey('custom')], 'Custom')
  assert.equal(zh[labels.styleRenderLabelKey('auto')], '自动')
  assert.equal(en[labels.styleRenderLabelKey('pixelated')], 'Pixelated')
})

test('配色令牌：13 个语义色都有中英映射', () => {
  assertTranslated(labels.PALETTE_TOKEN_LABEL_KEYS, types.PALETTE_KEYS, 'palette')
  assert.equal(
    Object.keys(labels.PALETTE_TOKEN_LABEL_KEYS).length,
    types.PALETTE_KEYS.length,
    '配色令牌映射数量应与 PALETTE_KEYS 一致'
  )
  assert.equal(zh[labels.paletteTokenLabelKey('surface_alt')], '次级表面')
  assert.equal(en[labels.paletteTokenLabelKey('surface_alt')], 'Secondary surface')
})

test('未知枚举回退到本地化通用文案，不回显原始技术名', () => {
  const fallbacks = [
    [labels.effectGroupLabelKey, 'styleEffectGroupOther'],
    [labels.effectFieldLabelKey, 'styleEffectFieldOther'],
    [labels.paletteTokenLabelKey, 'stylePaletteTokenOther'],
    [labels.styleFitLabelKey, 'styleFitOther'],
    [labels.styleAlignLabelKey, 'styleAlignOther'],
    [labels.styleRenderLabelKey, 'styleRenderOther'],
  ]
  for (const [resolve, expectedKey] of fallbacks) {
    assert.equal(resolve('mystery-technical-value'), expectedKey)
    assert.ok(zh[expectedKey]?.trim(), `${expectedKey} 缺中文回退文案`)
    assert.ok(en[expectedKey]?.trim(), `${expectedKey} 缺英文回退文案`)
    assert.ok(!zh[expectedKey].includes('mystery'), '中文回退文案不能包含原始技术名')
    assert.ok(!en[expectedKey].includes('mystery'), '英文回退文案不能包含原始技术名')
  }
})

test('技术枚举映射的 key 全部在 zh / en 中存在（三处 UI 共用同一套 key）', () => {
  const allKeys = new Set([
    ...Object.values(labels.EFFECT_GROUP_LABEL_KEYS),
    ...Object.values(labels.EFFECT_FIELD_LABEL_KEYS),
    ...Object.values(labels.PALETTE_TOKEN_LABEL_KEYS),
    ...Object.values(labels.STYLE_FIT_LABEL_KEYS),
    ...Object.values(labels.STYLE_ALIGN_LABEL_KEYS),
    ...Object.values(labels.STYLE_RENDER_LABEL_KEYS),
    'styleEffectGroupOther',
    'styleEffectFieldOther',
    'stylePaletteTokenOther',
    'styleFitOther',
    'styleAlignOther',
    'styleRenderOther',
  ])
  for (const key of allKeys) {
    assert.equal(typeof zh[key], 'string', `zh 缺少 key: ${key}`)
    assert.equal(typeof en[key], 'string', `en 缺少 key: ${key}`)
  }
})
