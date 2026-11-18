// Floating style edit panel drag position (src/components/style-editor/panelPosition.ts):
// clamping to the viewport while keeping the title bar reachable.
import assert from 'node:assert/strict'
import { test } from 'node:test'

const panel = await import('../.test-build/components/style-editor/panelPosition.js')

const size = { width: 360, height: 600, titleHeight: 40 }
const viewport = { width: 1280, height: 800 }

test('clampPanelPosition：视口内的位置保持不变', () => {
  assert.deepEqual(panel.clampPanelPosition({ left: 600, top: 100 }, size, viewport), {
    left: 600,
    top: 100,
  })
  // 自定义边距：留 16px
  assert.deepEqual(panel.clampPanelPosition({ left: 600, top: 100 }, size, viewport, 16), {
    left: 600,
    top: 100,
  })
})

test('clampPanelPosition：越界时夹到边距内（右下优先完整可见）', () => {
  // 左上越界
  assert.deepEqual(panel.clampPanelPosition({ left: -500, top: -80 }, size, viewport), {
    left: 8,
    top: 8,
  })
  // 右下越界：maxLeft = 1280 - 360 - 8，maxTop = 800 - 600 - 8
  assert.deepEqual(panel.clampPanelPosition({ left: 5000, top: 5000 }, size, viewport), {
    left: 912,
    top: 192,
  })
  // 恰好贴边不越界
  assert.deepEqual(panel.clampPanelPosition({ left: 912, top: 192 }, size, viewport), {
    left: 912,
    top: 192,
  })
})

test('clampPanelPosition：面板比视口宽时退化为左边距', () => {
  const narrow = { width: 320, height: 500, titleHeight: 40 }
  assert.deepEqual(
    panel.clampPanelPosition({ left: 600, top: 0 }, { ...narrow, width: 1400 }, viewport),
    { left: 8, top: 8 }
  )
  // 接近视口宽度时夹到右侧仍留边距
  assert.deepEqual(
    panel.clampPanelPosition({ left: 600, top: 0 }, { ...narrow, width: 900 }, viewport),
    { left: 372, top: 8 }
  )
})

test('clampPanelPosition：面板比视口高时保证标题栏可抓取', () => {
  const tall = { width: 360, height: 1200, titleHeight: 40 }
  // maxTop = 视口高 - 标题栏高 - 边距 = 800 - 40 - 8
  assert.deepEqual(panel.clampPanelPosition({ left: 100, top: 5000 }, tall, viewport), {
    left: 100,
    top: 752,
  })
  assert.deepEqual(panel.clampPanelPosition({ left: 100, top: 900 }, tall, viewport), {
    left: 100,
    top: 752,
  })
})

test('clampPanelPosition：异常尺寸不产生负数 / NaN', () => {
  assert.deepEqual(
    panel.clampPanelPosition({ left: 10, top: 10 }, { width: 0, height: 0, titleHeight: 0 }, {
      width: 0,
      height: 0,
    }),
    { left: 8, top: 8 }
  )
  assert.deepEqual(
    panel.clampPanelPosition({ left: Number.NaN, top: Number.NaN }, size, viewport),
    { left: 8, top: 8 }
  )
})
