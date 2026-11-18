/**
 * 编辑模式悬浮面板的拖动定位（纯函数，便于单测）：
 * - 拖动时面板整体限制在视口内并留边距；
 * - 面板高于视口时，至少保证标题栏（拖动手柄）留在视口内可抓取；
 * - 松手保持位置（由调用方保存返回值），进入 / 退出编辑模式由组件挂载状态重置。
 */

/** 面板与视口边缘之间保留的边距（px） */
export const PANEL_VIEWPORT_MARGIN = 8

export type PanelPosition = { left: number; top: number }

/** 面板尺寸：拖动期间固定为按下时的实测尺寸，避免布局跳动 */
export type PanelSize = {
  width: number
  height: number
  /** 标题栏高度：面板比视口高时用它保证手柄仍可见 */
  titleHeight: number
}

export type ViewportSize = { width: number; height: number }

const finite = (value: number, fallback: number): number =>
  Number.isFinite(value) ? value : fallback

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(finite(value, min), min), max)

/**
 * 把「目标左上角坐标」夹到视口内。
 * - left：`[margin, viewport.width - width - margin]`（视口比面板窄时退化到 margin）；
 * - top：优先整块面板留在视口内；面板高于视口时退化为「标题栏留在视口内」。
 * 非有限数值（NaN 等）按最小边距处理，不会把面板拖丢。
 */
export const clampPanelPosition = (
  position: PanelPosition,
  size: PanelSize,
  viewport: ViewportSize,
  margin: number = PANEL_VIEWPORT_MARGIN
): PanelPosition => {
  const safeMargin = Math.max(0, finite(margin, PANEL_VIEWPORT_MARGIN))
  const safeWidth = Math.max(0, finite(size.width, 0))
  const safeHeight = Math.max(0, finite(size.height, 0))
  const safeTitleHeight = Math.max(0, finite(size.titleHeight, 0))
  const viewportWidth = Math.max(0, finite(viewport.width, 0))
  const viewportHeight = Math.max(0, finite(viewport.height, 0))
  const maxLeft = Math.max(safeMargin, viewportWidth - safeWidth - safeMargin)

  const panelFits = safeHeight <= viewportHeight - safeMargin * 2
  const visibleHeight = panelFits ? safeHeight : safeTitleHeight
  const maxTop = Math.max(safeMargin, viewportHeight - visibleHeight - safeMargin)

  return {
    left: clamp(position.left, safeMargin, maxLeft),
    top: clamp(position.top, safeMargin, maxTop),
  }
}
