// Style pack types and pure effect helpers (src/services/style/types.ts,
// src/services/style/effects.ts): slot ids, CSS safety, file-ref resolution,
// effect CSS mapping and fingerprinting.
import assert from 'node:assert/strict'
import { test } from 'node:test'

const types = await import('../.test-build/services/style/types.js')
const effects = await import('../.test-build/services/style/effects.js')

test('样式槽位：统一前缀、派生图标列表与 slotId', () => {
  assert.equal(types.STYLE_PREFIX, 'dslike_chat.style_pkg')
  assert.equal(types.STYLE_SLOTS.bgMain, 'dslike_chat.style_pkg.background.main')
  assert.equal(types.STYLE_SLOTS.font, 'dslike_chat.style_pkg.font')
  assert.equal(types.slotId(types.STYLE_SLOTS.bgMain, 'dark'), 'dslike_chat.style_pkg.background.main.dark')
  // ICON_SLOTS 由 STYLE_SLOTS 派生：只含 icon. 前缀，顺序与声明一致
  const iconSlots = Object.values(types.STYLE_SLOTS).filter((slot) => slot.startsWith('dslike_chat.style_pkg.icon.'))
  assert.deepEqual(types.ICON_SLOTS, iconSlots)
  assert.ok(types.ICON_SLOTS.length > 30)
  assert.ok(types.ICON_SLOTS.every((slot) => slot.startsWith('dslike_chat.style_pkg.icon.')))
})

test('枚举与默认值', () => {
  assert.deepEqual(types.STYLE_FITS, ['cover', 'contain', 'stretch', 'tile'])
  assert.deepEqual(types.STYLE_ALIGNS, [
    'top-left',
    'top-center',
    'top-right',
    'center-left',
    'center',
    'center-right',
    'bottom-left',
    'bottom-center',
    'bottom-right',
    'custom',
  ])
  assert.equal(types.STYLE_FIT_DEFAULT, 'cover')
  assert.equal(types.STYLE_ALIGN_DEFAULT, 'center')
  assert.equal(types.STYLE_RENDER_DEFAULT, 'auto')
  assert.equal(types.RENDER_CSS.pixelated, 'pixelated')
  assert.equal(types.RENDER_CSS.smooth, 'auto')
  assert.equal(types.RENDER_CSS['optimize-speed'], 'optimizeSpeed')
  assert.equal(types.RENDER_CSS['optimize-quality'], 'optimizeQuality')
  assert.deepEqual(types.EFFECT_DEFAULTS, {
    opacity: 1,
    shadow: { x: 0, y: 4, blur: 12, color: '#00000066' },
    outerGlow: { radius: 10, color: '#ffffff', intensity: 1 },
    innerGlow: { radius: 6, color: '#ffffff', intensity: 1 },
    emboss: { depth: 1.5, angle: 45, intensity: 0.6 },
    stroke: { width: 2, color: '#000000' },
    zoom: 1,
  })
  assert.deepEqual(types.TILT_DEFAULTS, { maxAngle: 12, perspective: 700, scale: 1.02 })
})

test('isSafePosition：只放行安全 CSS background-position 片段', () => {
  for (const valid of ['center', '50% 20%', 'left 10px bottom 20%', '0% 100%', 'calc(50% - 10px)']) {
    assert.equal(types.isSafePosition(valid), true, valid)
  }
  for (const invalid of [
    '',
    'url(https://evil.example/x.png)',
    'url(x)',
    'expression(alert(1))',
    'a;b',
    'a{b}',
    'a<b',
    'a>b',
    'a\\b',
    'a@b',
    'a"b',
    "a'b",
    'a/*b*/',
    'x'.repeat(61),
    42,
    null,
  ]) {
    assert.equal(types.isSafePosition(invalid), false, String(invalid))
  }
})

test('isThemedFileRef / resolveStyleFileRef：主题无关与按主题两种写法', () => {
  assert.equal(types.isThemedFileRef({ file: 'a.png' }), false)
  assert.equal(types.isThemedFileRef({ light: { file: 'l.png' } }), true)

  assert.equal(types.resolveStyleFileRef(undefined, 'light'), undefined)
  assert.equal(types.resolveStyleFileRef({}, 'light'), undefined)

  const plain = { file: 'a.png', effects: { opacity: 0.5 } }
  assert.deepEqual(types.resolveStyleFileRef(plain, 'light'), plain)
  assert.deepEqual(types.resolveStyleFileRef(plain, 'dark'), plain)

  const themed = {
    light: { file: 'light.png', effects: { opacity: 0.8 } },
    dark: { file: 'dark.png' },
    file: 'shared.png',
    effects: { opacity: 0.5 },
  }
  assert.deepEqual(types.resolveStyleFileRef(themed, 'light'), { file: 'light.png', effects: { opacity: 0.8 } })
  assert.deepEqual(types.resolveStyleFileRef(themed, 'dark'), { file: 'dark.png', effects: { opacity: 0.5 } })

  // 主题项存在但没写 file：只回退到同级 file，不借用另一主题的文件
  const onlyLight = { light: { file: 'l.png' }, dark: {} }
  assert.deepEqual(types.resolveStyleFileRef(onlyLight, 'dark'), undefined)
  const withShared = { light: { file: 'l.png' }, dark: {}, file: 'shared.png' }
  assert.deepEqual(types.resolveStyleFileRef(withShared, 'dark'), { file: 'shared.png', effects: undefined })
})

/* ============================ effects.ts 纯函数 ============================ */

test('effectCss：阴影走 drop-shadow，透明度走 opacity，默认值不产生多余 CSS', () => {
  assert.deepEqual(effects.effectCss(undefined), {})
  // 空 shadow 对象按默认值补齐：0 / 4 / 12 / #00000066
  assert.deepEqual(effects.effectCss({ shadow: {} }), {
    filter: 'drop-shadow(0px 4px 12px #00000066)',
  })
  // 全零阴影 = 不可见，不产生 filter
  assert.deepEqual(effects.effectCss({ shadow: { x: 0, y: 0, blur: 0 } }), {})
  assert.deepEqual(effects.effectCss({ opacity: 0.5 }), { opacity: 0.5 })
  assert.deepEqual(effects.effectCss({ opacity: 1 }), {})
  assert.deepEqual(effects.effectCss({ shadow: { x: 1, y: 2, blur: 3, color: '#fff' }, opacity: 0 }), {
    filter: 'drop-shadow(1px 2px 3px #fff)',
    opacity: 0,
  })
})

test('effectsHash：undefined 固定为 none，键顺序无关，值 / 数组顺序相关', () => {
  assert.equal(effects.effectsHash(undefined), 'none')
  // 空对象仍参与哈希（与 undefined 区分）
  assert.notEqual(effects.effectsHash({}), 'none')
  const a = { opacity: 0.5, shadow: { x: 1, y: 2 } }
  const b = { shadow: { y: 2, x: 1 }, opacity: 0.5 }
  assert.equal(effects.effectsHash(a), effects.effectsHash(b))
  assert.notEqual(effects.effectsHash(a), effects.effectsHash({ ...a, opacity: 0.6 }))
  assert.notEqual(
    effects.effectsHash({ window: { x1: 0, y1: 0, x2: 1, y2: 1 } }),
    effects.effectsHash({ window: { x1: 0, y1: 0, x2: 1, y2: 0.5 } })
  )
})

test('hasStaticEffects / needsCanvasProcessing：只有静态特效与 window/zoom 需要派生图', () => {
  assert.equal(effects.hasStaticEffects(undefined), false)
  assert.equal(effects.hasStaticEffects({}), false)
  assert.equal(effects.hasStaticEffects({ opacity: 0.5 }), false)
  assert.equal(effects.hasStaticEffects({ shadow: {} }), false)
  for (const key of ['stroke', 'outerGlow', 'innerGlow', 'emboss']) {
    assert.equal(effects.hasStaticEffects({ [key]: {} }), true, key)
  }

  assert.equal(effects.needsCanvasProcessing(undefined), false)
  assert.equal(effects.needsCanvasProcessing({ opacity: 0.5 }), false)
  assert.equal(effects.needsCanvasProcessing({ zoom: 1 }), false)
  assert.equal(effects.needsCanvasProcessing({ zoom: 1.5 }), true)
  assert.equal(effects.needsCanvasProcessing({ window: { x1: 0, y1: 0, x2: 1, y2: 1 } }), true)
  assert.equal(effects.needsCanvasProcessing({ stroke: {} }), true)
})

test('resolveTilt：缺省值补齐与覆写', () => {
  assert.deepEqual(effects.resolveTilt({}), {
    maxAngle: 12,
    perspective: 700,
    scale: 1.02,
  })
  assert.deepEqual(effects.resolveTilt({ maxAngle: 0, perspective: 2000, scale: 0.8 }), {
    maxAngle: 0,
    perspective: 2000,
    scale: 0.8,
  })
})

test('pruneEffectsCache：空缓存 / 空保留集合不抛错', () => {
  assert.doesNotThrow(() => effects.pruneEffectsCache(new Set()))
  assert.doesNotThrow(() => effects.pruneEffectsCache(new Set(['blob:not-there'])))
})
