import { useLayoutEffect, useMemo, useState, type RefObject } from 'react'
import { enterDelays, exitDelays, resolveMotionTokens } from './motionMath.js'

export type StaggerPhase = 'idle' | 'enter' | 'exit'

/** 单个列表项这一轮要播的动画：进入 / 退出 + 延时 */
export type StaggeredItem = { phase: 'enter' | 'exit'; delayMs: number }

type StaggerPlan = { phase: 'enter' | 'exit'; ids: string[] }

/**
 * 列表 stagger：动画开始时量一次「当前屏幕内可见的项」，屏幕外的项不参与（长列表不全量动画）。
 * 返回 id → { phase, delayMs }，组件把 delayMs 写进 animation-delay。
 * DOM 约定：列表项带 data-motion-item="<id>"。
 */
export const useStaggeredList = ({
  containerRef,
  phase,
  run,
  reduced,
}: {
  containerRef: RefObject<HTMLElement | null>
  phase: StaggerPhase
  /** 同一 phase 重播时的递增标记（例如「开启新对话」退完再进） */
  run: number
  reduced: boolean
}): Map<string, StaggeredItem> => {
  const [plan, setPlan] = useState<StaggerPlan | null>(null)

  useLayoutEffect(() => {
    const container = containerRef.current
    if (phase === 'idle' || !container) {
      setPlan(null)
      return
    }
    const viewport = container.getBoundingClientRect()
    const ids = Array.from(container.querySelectorAll<HTMLElement>('[data-motion-item]'))
      .filter((item) => {
        const rect = item.getBoundingClientRect()
        return rect.top < viewport.bottom && rect.bottom > viewport.top
      })
      .map((item) => item.dataset.motionItem ?? '')
      .filter((id) => id !== '')
    setPlan({ phase, ids })
  }, [containerRef, phase, run])

  return useMemo(() => {
    const items = new Map<string, StaggeredItem>()
    if (!plan) {
      return items
    }
    const tokens = resolveMotionTokens(reduced)
    const delays =
      plan.phase === 'enter' ? enterDelays(plan.ids.length, tokens) : exitDelays(plan.ids.length, tokens)
    for (const [index, id] of plan.ids.entries()) {
      items.set(id, { phase: plan.phase, delayMs: delays[index] ?? 0 })
    }
    return items
  }, [plan, reduced])
}
