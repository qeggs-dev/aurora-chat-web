// 转场动效纯逻辑（src/components/motion/motionMath.ts）：
// 可视项 stagger 数量与延时、高亮 1/3 时机、设置标签换页方向、弹窗从按钮放大、reduced-motion 降级配置。
import assert from 'node:assert/strict'
import { test } from 'node:test'

const motion = await import('../.test-build/components/motion/motionMath.js')

test('tokens：默认与 reduced-motion 两套配置的时长 / stagger / 位移', () => {
  const { MOTION_TOKENS, REDUCED_MOTION_TOKENS, resolveMotionTokens } = motion
  assert.equal(motion.resolveMotionTokens(false), MOTION_TOKENS)
  assert.equal(resolveMotionTokens(true), REDUCED_MOTION_TOKENS)
  // reduced：位移与 stagger 全部归零，只剩极短淡入
  assert.equal(REDUCED_MOTION_TOKENS.staggerMs, 0)
  assert.equal(REDUCED_MOTION_TOKENS.staggerExitMs, 0)
  assert.equal(REDUCED_MOTION_TOKENS.shiftX, 0)
  assert.equal(REDUCED_MOTION_TOKENS.shiftExitX, 0)
  assert.equal(REDUCED_MOTION_TOKENS.shiftContent, 0)
  assert.equal(REDUCED_MOTION_TOKENS.panelShift, 0)
  assert.equal(REDUCED_MOTION_TOKENS.dialogScaleMin, 1)
  for (const key of ['listEnterMs', 'listExitMs', 'panelMs', 'highlightMs', 'dialogMs']) {
    assert.ok(REDUCED_MOTION_TOKENS[key] <= MOTION_TOKENS[key], `${key} 应不慢于默认值`)
  }
  // 默认值：stagger 16ms、进入 200ms、退出 160ms
  assert.equal(MOTION_TOKENS.staggerMs, 16)
  assert.equal(MOTION_TOKENS.listEnterMs, 200)
  assert.equal(MOTION_TOKENS.listExitMs, 160)
})

test('enterDelays：从上到下逐项延时，超过可视项上限后不再增长', () => {
  const { MOTION_TOKENS, enterDelays } = motion
  assert.deepEqual(enterDelays(3, MOTION_TOKENS), [0, 16, 32])
  assert.deepEqual(enterDelays(0, MOTION_TOKENS), [])
  const long = enterDelays(100, MOTION_TOKENS)
  assert.equal(long.length, MOTION_TOKENS.maxStaggerItems)
  assert.equal(long.at(-1), (MOTION_TOKENS.maxStaggerItems - 1) * MOTION_TOKENS.staggerMs)
})

test('exitDelays：从屏幕底部开始向上，最下面一项先走', () => {
  const { MOTION_TOKENS, exitDelays } = motion
  assert.deepEqual(exitDelays(3, MOTION_TOKENS), [24, 12, 0])
  assert.deepEqual(exitDelays(1, MOTION_TOKENS), [0])
  assert.equal(exitDelays(100, MOTION_TOKENS).length, MOTION_TOKENS.maxStaggerItems)
})

test('staggerWindowMs：列表 stagger 的最长结束时间', () => {
  const { MOTION_TOKENS, staggerWindowMs, enterDelays } = motion
  assert.equal(staggerWindowMs(0, MOTION_TOKENS, 'enter'), 0)
  // 3 项进入：最后一项 delay 32 + 时长 200
  assert.equal(staggerWindowMs(3, MOTION_TOKENS, 'enter'), 32 + MOTION_TOKENS.listEnterMs)
  assert.equal(staggerWindowMs(3, MOTION_TOKENS, 'exit'), 24 + MOTION_TOKENS.listExitMs)
  // 与 enterDelays 的最后一项一致
  assert.equal(
    staggerWindowMs(3, MOTION_TOKENS, 'enter') - MOTION_TOKENS.listEnterMs,
    enterDelays(3, MOTION_TOKENS).at(-1)
  )
})

test('可视项：只有与容器相交的列表项参与动画（填满当前屏幕为止）', () => {
  const { isVisibleInViewport, countVisibleItems } = motion
  const viewport = { top: 0, bottom: 400 }
  assert.equal(isVisibleInViewport({ top: 0, bottom: 40 }, viewport), true)
  assert.equal(isVisibleInViewport({ top: 399, bottom: 439 }, viewport), true)
  assert.equal(isVisibleInViewport({ top: 400, bottom: 440 }, viewport), false)
  assert.equal(isVisibleInViewport({ top: -40, bottom: 0 }, viewport), false)
  // 滚动后：滚出上方的项不算，屏幕内的项参与
  const scrolled = { top: 200, bottom: 600 }
  const items = [
    { top: 0, bottom: 40 },
    { top: 210, bottom: 250 },
    { top: 250, bottom: 290 },
    { top: 600, bottom: 640 },
  ]
  assert.equal(countVisibleItems(items, scrolled), 2)
  assert.equal(countVisibleItems([], viewport), 0)
})

test('oneThirdDelay：高亮移动 1/3 时开始整体退出', () => {
  const { oneThirdDelay } = motion
  assert.equal(oneThirdDelay(260), 87)
  assert.equal(oneThirdDelay(90), 30)
  assert.equal(oneThirdDelay(1), 0)
  assert.equal(oneThirdDelay(0), 0)
  assert.equal(oneThirdDelay(-10), 0)
})

test('swipeDirection：按标签顺序决定内容区侧移方向', () => {
  const { swipeDirection } = motion
  assert.equal(swipeDirection(0, 1), 'forward')
  assert.equal(swipeDirection(1, 4), 'forward')
  assert.equal(swipeDirection(4, 1), 'backward')
  assert.equal(swipeDirection(2, 2), 'forward')
})

test('dialogExpand：按钮中心作为 transform-origin，按钮尺寸 / 弹窗尺寸作为起始缩放', () => {
  const { dialogExpand, MOTION_TOKENS } = motion
  const dialog = { left: 100, top: 100, width: 760, height: 500 }
  const origin = { left: 16, top: 700, width: 240, height: 40 }
  const result = dialogExpand(dialog, origin, MOTION_TOKENS)
  // 按钮中心 (136, 720) 相对弹窗左上角 (100, 100)
  assert.equal(result.originX, 36)
  assert.equal(result.originY, 620)
  assert.ok(Math.abs(result.scaleX - 240 / 760) < 1e-9)
  assert.ok(Math.abs(result.scaleY - 40 / 500) < 1e-9)
  // 没有触发按钮（自动打开）时从弹窗中心轻微放大
  const fallback = dialogExpand(dialog, null, MOTION_TOKENS)
  assert.deepEqual(fallback, {
    originX: 380,
    originY: 250,
    scaleX: MOTION_TOKENS.dialogScaleMin,
    scaleY: MOTION_TOKENS.dialogScaleMin,
  })
  // 非法 rect 也走兜底，不产生 NaN / Infinity
  for (const bad of [
    { left: 0, top: 0, width: 0, height: 0 },
    { left: 10, top: 10, width: 50, height: 0 },
  ]) {
    const value = dialogExpand(dialog, bad, MOTION_TOKENS)
    assert.ok(Number.isFinite(value.originX) && Number.isFinite(value.scaleX))
    assert.ok(value.scaleX > 0 && value.scaleY > 0)
  }
})

test('tabHighlight：只动 transform，圆角按 scaleX 反向补偿', () => {
  const { tabHighlight } = motion
  const wide = tabHighlight({ x: 120, y: 4, width: 150, height: 40, radius: 12 })
  assert.equal(wide.transform, 'translate(120px, 4px) scaleX(1.5)')
  assert.equal(wide.height, 40)
  // 视觉水平半径 = (12 / 1.5) * 1.5 = 12，垂直半径保持 12
  assert.equal(wide.borderRadius, '8px 12px')
  const narrow = tabHighlight({ x: 0, y: 0, width: 50, height: 40, radius: 12 })
  assert.equal(narrow.transform, 'translate(0px, 0px) scaleX(0.5)')
  assert.equal(narrow.borderRadius, '24px 12px')
  // 宽度非法时不产生除零
  const zero = tabHighlight({ x: 0, y: 0, width: 0, height: 40, radius: 12 })
  assert.ok(!zero.transform.includes('Infinity'))
  assert.ok(!zero.borderRadius.includes('Infinity'))
})

test('siderExitMs：逐项退出的等待最长；reduced-motion 时明显更短', () => {
  const { siderExitMs, MOTION_TOKENS, REDUCED_MOTION_TOKENS } = motion
  const listMs = siderExitMs('list', MOTION_TOKENS)
  assert.ok(listMs > siderExitMs('selection', MOTION_TOKENS))
  assert.ok(siderExitMs('selection', MOTION_TOKENS) > siderExitMs('plain', MOTION_TOKENS))
  // list：等逐项退出再整体滑出（120 + 240 + 60 的缓冲）
  assert.equal(listMs, 120 + 240 + 60)
  // selection：高亮 1/3（87）+ 整体滑出（240）+ 缓冲
  assert.equal(siderExitMs('selection', MOTION_TOKENS), 87 + 240 + 60)
  assert.equal(siderExitMs('plain', MOTION_TOKENS), 240 + 60)
  for (const reason of ['list', 'selection', 'plain']) {
    assert.ok(siderExitMs(reason, REDUCED_MOTION_TOKENS) < siderExitMs(reason, MOTION_TOKENS))
  }
})

test('dialogExitMs / listEnterMs / listExitMs / contentSwitchMs', () => {
  const {
    dialogExitMs,
    listEnterMs,
    listExitMs,
    contentSwitchMs,
    MOTION_TOKENS,
    REDUCED_MOTION_TOKENS,
  } = motion
  assert.equal(dialogExitMs(MOTION_TOKENS), 260 + 60)
  assert.equal(dialogExitMs(REDUCED_MOTION_TOKENS), 80 + 60)
  // 列表进入清理时长覆盖最后一项的 delay + 时长
  assert.ok(listEnterMs(MOTION_TOKENS) > 11 * MOTION_TOKENS.staggerMs + MOTION_TOKENS.listEnterMs)
  assert.ok(listExitMs(MOTION_TOKENS) > 11 * MOTION_TOKENS.staggerExitMs + MOTION_TOKENS.listExitMs)
  assert.equal(contentSwitchMs(MOTION_TOKENS), 90 + 150)
  assert.ok(contentSwitchMs(REDUCED_MOTION_TOKENS) < contentSwitchMs(MOTION_TOKENS))
})
