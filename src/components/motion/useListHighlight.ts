import { useEffect, useLayoutEffect, useState, type RefObject } from 'react'

/** 高亮块在滚动容器内容坐标里的位置（只用于 transform，不写 top / left） */
export type HighlightRect = { x: number; y: number; width: number; height: number }

/**
 * 侧边栏选中高亮：量出选中项在滚动容器内容坐标里的位置，
 * 高亮块用它做 translate（同一列表内各项等高，只有纵向位移），CSS 负责过渡与圆角。
 * 列表滚动时高亮随内容一起滚（绝对定位在滚动容器内），不需要滚动监听。
 */
export const useListHighlight = ({
  containerRef,
  activeId,
  revision,
  enabled,
}: {
  containerRef: RefObject<HTMLElement | null>
  activeId: string | null
  /** 列表数据变化时递增，触发重新测量（例如删会话、重新分组） */
  revision: number
  enabled: boolean
}): HighlightRect | null => {
  const [highlight, setHighlight] = useState<HighlightRect | null>(null)
  const [resizeTick, setResizeTick] = useState(0)

  useEffect(() => {
    const container = containerRef.current
    if (!container) {
      return
    }
    // 断点切换、窗口缩放会改变项宽高与行高：容器尺寸变化时重新量
    const observer = new ResizeObserver(() => setResizeTick((tick) => tick + 1))
    observer.observe(container)
    return () => observer.disconnect()
  }, [containerRef])

  useLayoutEffect(() => {
    const container = containerRef.current
    if (!enabled || !container || activeId === null) {
      setHighlight(null)
      return
    }
    const item = Array.from(container.querySelectorAll<HTMLElement>('[data-motion-item]')).find(
      (element) => element.dataset.motionItem === activeId
    )
    if (!item) {
      setHighlight(null)
      return
    }
    const box = container.getBoundingClientRect()
    const rect = item.getBoundingClientRect()
    setHighlight({
      x: rect.left - box.left + container.scrollLeft,
      y: rect.top - box.top + container.scrollTop,
      width: rect.width,
      height: rect.height,
    })
  }, [containerRef, activeId, revision, resizeTick, enabled])

  return highlight
}
