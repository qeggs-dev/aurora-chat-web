import { useEffect, useLayoutEffect, useState, type RefObject } from 'react'
import { tabHighlight, type TabHighlight } from './motionMath.js'

/** 高亮元素固定宽度：靠 scaleX 拉到目标标签宽度，保证只动 transform */
const BASE_WIDTH = 100
const RADIUS = 12

/**
 * 设置标签高亮：量出当前选中标签在标签栏内容坐标里的位置，
 * 用 translate + scaleX 滑过去（替代给每个标签单独画背景色）。
 * 标签栏尺寸或某个标签宽度变化（窗口 resize、语言切换）时重新测量。
 */
export const useTabHighlight = ({
  navRef,
  activeIndex,
  revision,
}: {
  navRef: RefObject<HTMLElement | null>
  activeIndex: number
  /** 额外的重新测量触发值 */
  revision: number
}): TabHighlight | null => {
  const [highlight, setHighlight] = useState<TabHighlight | null>(null)
  const [resizeTick, setResizeTick] = useState(0)

  useEffect(() => {
    const nav = navRef.current
    if (!nav) {
      return
    }
    const observer = new ResizeObserver(() => setResizeTick((tick) => tick + 1))
    observer.observe(nav)
    for (const tab of nav.querySelectorAll('[role="tab"]')) {
      observer.observe(tab)
    }
    return () => observer.disconnect()
  }, [navRef])

  useLayoutEffect(() => {
    const nav = navRef.current
    if (!nav) {
      setHighlight(null)
      return
    }
    const tab = Array.from(nav.querySelectorAll<HTMLElement>('[role="tab"]'))[activeIndex]
    if (!tab) {
      setHighlight(null)
      return
    }
    const box = nav.getBoundingClientRect()
    const rect = tab.getBoundingClientRect()
    setHighlight(
      tabHighlight({
        x: rect.left - box.left + nav.scrollLeft,
        y: rect.top - box.top + nav.scrollTop,
        width: rect.width,
        height: rect.height,
        radius: RADIUS,
        baseWidth: BASE_WIDTH,
      })
    )
  }, [navRef, activeIndex, revision, resizeTick])

  return highlight
}
