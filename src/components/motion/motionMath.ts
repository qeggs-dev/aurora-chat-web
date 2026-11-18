/**
 * 转场动效的纯逻辑（不依赖 DOM / React，便于单测）：
 * 时长与位移的 JS 镜像、可视项 stagger 计算、高亮移动 1/3 时机、设置标签换页方向、
 * 设置弹窗「从按钮放大」的 transform-origin / 起始缩放。
 *
 * 数值与 src/app/motion.css 的 --motion-* 变量一一对应，改一边必须改另一边。
 */

/** 与 CSS 变量同一套的时长 / stagger / 位移配置 */
export type MotionTokens = {
  /** 列表项进入时长 */
  listEnterMs: number
  /** 列表项退出时长 */
  listExitMs: number
  /** 进入 stagger（从上到下） */
  staggerMs: number
  /** 退出 stagger（从下到上） */
  staggerExitMs: number
  /** 参与 stagger 的最大可视项数：屏幕外的项不参与，长列表不会全量动画 */
  maxStaggerItems: number
  /** 面板（侧边栏 / 抽屉）整体滑入滑出时长 */
  panelMs: number
  /** 列表逐项退出后、整体滑动前的停顿 */
  panelExitDelayMs: number
  /** 高亮滑动时长 */
  highlightMs: number
  /** 设置弹窗放大 / 缩小时长 */
  dialogMs: number
  /** 设置内容区旧内容侧移退出时长 */
  contentOutMs: number
  /** 设置内容区新内容侧移进入时长 */
  contentInMs: number
  /** 列表项进入位移（左 → 右） */
  shiftX: number
  /** 列表项退出位移（右 → 左，负数） */
  shiftExitX: number
  /** 内容区换页位移 */
  shiftContent: number
  /** 面板位移：100 表示整块从屏幕边缘外滑入，reduced-motion 时 0 */
  panelShift: number
  /** 没有触发按钮 rect 时弹窗的兜底起始缩放 */
  dialogScaleMin: number
}

/** 默认动效配置（对应 motion.css 的 :root） */
export const MOTION_TOKENS: MotionTokens = {
  listEnterMs: 200,
  listExitMs: 160,
  staggerMs: 16,
  staggerExitMs: 12,
  maxStaggerItems: 12,
  panelMs: 240,
  panelExitDelayMs: 120,
  highlightMs: 260,
  dialogMs: 260,
  contentOutMs: 90,
  contentInMs: 150,
  shiftX: 14,
  shiftExitX: -18,
  shiftContent: 18,
  panelShift: 100,
  dialogScaleMin: 0.94,
}

/** reduced-motion 降级配置：位移与 stagger 归零，只留极短淡入 */
export const REDUCED_MOTION_TOKENS: MotionTokens = {
  listEnterMs: 80,
  listExitMs: 80,
  staggerMs: 0,
  staggerExitMs: 0,
  maxStaggerItems: 12,
  panelMs: 60,
  panelExitDelayMs: 0,
  highlightMs: 1,
  dialogMs: 80,
  contentOutMs: 1,
  contentInMs: 80,
  shiftX: 0,
  shiftExitX: 0,
  shiftContent: 0,
  panelShift: 0,
  dialogScaleMin: 1,
}

/** 按 reduced-motion 取一套配置 */
export const resolveMotionTokens = (reduced: boolean): MotionTokens =>
  reduced ? REDUCED_MOTION_TOKENS : MOTION_TOKENS

/** 高亮位移 1/3 时刻（四舍五入到毫秒）：此时开始侧边栏整体退出 */
export const oneThirdDelay = (durationMs: number): number => Math.max(0, Math.round(durationMs / 3))

/** 一次列表 stagger 的最长结束时间（可视项数取上限） */
export const staggerWindowMs = (
  count: number,
  tokens: MotionTokens,
  phase: 'enter' | 'exit'
): number => {
  const capped = Math.max(0, Math.min(count, tokens.maxStaggerItems))
  if (capped === 0) {
    return 0
  }
  const stagger = phase === 'enter' ? tokens.staggerMs : tokens.staggerExitMs
  const duration = phase === 'enter' ? tokens.listEnterMs : tokens.listExitMs
  return (capped - 1) * stagger + duration
}

/**
 * 进入延时（从上到下依次）：第 i 项（i 从 0 开始、按 DOM 顺序）delay = i * stagger。
 * 位移与透明度由 CSS keyframes 负责，这里只给 delay。
 */
export const enterDelays = (count: number, tokens: MotionTokens): number[] => {
  const capped = Math.max(0, Math.min(count, tokens.maxStaggerItems))
  return Array.from({ length: capped }, (_, index) => index * tokens.staggerMs)
}

/**
 * 退出延时（从屏幕边缘 / 底部开始向上画到列表头）：
 * 最下面一项先走（delay 0），最上面一项最后走（delay 最大），每项自身从右到左淡出。
 */
export const exitDelays = (count: number, tokens: MotionTokens): number[] => {
  const capped = Math.max(0, Math.min(count, tokens.maxStaggerItems))
  return Array.from(
    { length: capped },
    (_, index) => (capped - 1 - index) * tokens.staggerExitMs
  )
}

export type RectLike = { top: number; bottom: number }
export type ViewportLike = { top: number; bottom: number }

/** 与可视区域相交的项：只有这些项参与 stagger（填满当前屏幕为止） */
export const isVisibleInViewport = (item: RectLike, viewport: ViewportLike): boolean =>
  item.top < viewport.bottom && item.bottom > viewport.top

/** 数出可视项数量（用于 stagger 与「只对可视区项做动画」） */
export const countVisibleItems = (
  items: readonly RectLike[],
  viewport: ViewportLike
): number => items.reduce((total, item) => total + (isVisibleInViewport(item, viewport) ? 1 : 0), 0)

/** 设置标签顺序 → 内容区/高亮的移动方向 */
export type SwipeDirection = 'forward' | 'backward'

export const swipeDirection = (fromIndex: number, toIndex: number): SwipeDirection =>
  toIndex >= fromIndex ? 'forward' : 'backward'

export type Rect = { left: number; top: number; width: number; height: number }
export type DialogExpand = { originX: number; originY: number; scaleX: number; scaleY: number }

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

/**
 * 设置弹窗「从按钮放大」：transform-origin 取按钮中心相对弹窗左上角的位置，
 * 起始缩放取按钮尺寸 / 弹窗尺寸（两轴独立，按钮沿自身矩形长成弹窗）。
 * 没有触发按钮（如 401 提示、缺 Key 自动打开）时从弹窗中心轻微放大。
 */
export const dialogExpand = (
  dialog: Rect,
  origin: Rect | null,
  tokens: MotionTokens
): DialogExpand => {
  const fallback = {
    originX: dialog.width / 2,
    originY: dialog.height / 2,
    scaleX: tokens.dialogScaleMin,
    scaleY: tokens.dialogScaleMin,
  }
  if (!origin || dialog.width <= 0 || dialog.height <= 0) {
    return fallback
  }
  if (origin.width <= 0 || origin.height <= 0) {
    return fallback
  }
  return {
    originX: origin.left + origin.width / 2 - dialog.left,
    originY: origin.top + origin.height / 2 - dialog.top,
    scaleX: clamp(origin.width / dialog.width, 0.02, 1),
    scaleY: clamp(origin.height / dialog.height, 0.02, 1),
  }
}

export type TabHighlight = { transform: string; height: number; borderRadius: string }

/**
 * 设置标签高亮：只动 transform。
 * 高亮元素固定 baseWidth 宽，靠 translate + scaleX 滑到目标标签的 x / 宽度；
 * 圆角按 scaleX 反向补偿，缩放后视觉半径仍是 radius，不会被拉成椭圆。
 */
export const tabHighlight = ({
  x,
  y,
  width,
  height,
  radius,
  baseWidth = 100,
}: {
  x: number
  y: number
  width: number
  height: number
  radius: number
  baseWidth?: number
}): TabHighlight => {
  const scale = Math.max(width / baseWidth, 0.001)
  return {
    transform: `translate(${round(x)}px, ${round(y)}px) scaleX(${round(scale, 4)})`,
    height: round(height),
    // 两值语法：水平半径按 scaleX 反向补偿，垂直半径保持 radius，视觉上不会被拉成椭圆
    borderRadius: `${round(radius / scale)}px ${radius}px`,
  }
}

const round = (value: number, digits = 2): number => {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

/** 侧边栏退出原因：决定要播哪些动效与整体等待多久 */
export type SiderExitReason = 'list' | 'selection' | 'plain'

/**
 * 侧边栏 / 移动端抽屉整体退出的等待时长（JS 侧，用于保持挂载直到 CSS 动画播完）：
 * - list：先逐项退出，再整体滑出（收起侧边栏 / 开启新对话）；
 * - selection：高亮滑到新项 1/3 时整体退出，不播逐项退出；
 * - plain：点遮罩等普通关闭，只整体滑出。
 */
export const siderExitMs = (reason: SiderExitReason, tokens: MotionTokens): number => {
  const window =
    reason === 'list'
      ? Math.max(
          tokens.panelExitDelayMs + tokens.panelMs,
          staggerWindowMs(tokens.maxStaggerItems, tokens, 'exit')
        )
      : reason === 'selection'
        ? oneThirdDelay(tokens.highlightMs) + tokens.panelMs
        : tokens.panelMs
  return window + 60
}

/** 设置弹窗退出等待时长（保持挂载到缩小动画播完） */
export const dialogExitMs = (tokens: MotionTokens): number => tokens.dialogMs + 60

/** 列表进入动画的清理时长（到点后摘掉 class，恢复静止态） */
export const listEnterMs = (tokens: MotionTokens): number =>
  staggerWindowMs(tokens.maxStaggerItems, tokens, 'enter') + 60

/** 列表退出动画的总时长（「开启新对话」在桌面端退完再重新进入） */
export const listExitMs = (tokens: MotionTokens): number =>
  staggerWindowMs(tokens.maxStaggerItems, tokens, 'exit') + 40

/** 设置内容区换页总时长（旧内容退出 → 换内容 → 新内容进入） */
export const contentSwitchMs = (tokens: MotionTokens): number =>
  tokens.contentOutMs + tokens.contentInMs
