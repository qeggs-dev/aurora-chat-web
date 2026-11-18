import { useEffect, useState } from 'react'

export type PresenceStage = 'start' | 'open' | 'exit'

type PresencePhase = 'hidden' | PresenceStage

/**
 * 挂载保持 + 两段式进入（统一侧边栏 / 抽屉 / 设置弹窗的进出场状态机）：
 * - 首次挂载的第一帧是 'start'（CSS 起点），下一帧才切到 'open'，让 transition 从起点播放；
 * - open 变 false 后仍保持挂载 exitMs 毫秒，让 CSS 退出动效播完再卸载；
 * - 退出途中重新打开时回到 'open'，transition 从当前视觉状态反向继续（可中断，取最新一次）。
 */
export const usePresence = (open: boolean, exitMs: number) => {
  const [state, setState] = useState<{ open: boolean; phase: PresencePhase }>(() => ({
    open,
    phase: open ? 'start' : 'hidden',
  }))

  // open 变化时在渲染期同步切换 phase：避免先按旧状态绘制一帧再纠正
  let phase = state.phase
  if (state.open !== open) {
    phase = open ? (state.phase === 'exit' ? 'open' : 'start') : state.phase === 'hidden' ? 'hidden' : 'exit'
    setState({ open, phase })
  }

  // start → open：下一帧再切，保证起点状态已经绘制过，transition 才会从起点播放
  useEffect(() => {
    if (phase !== 'start') {
      return
    }
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        setState((current) => (current.phase === 'start' ? { ...current, phase: 'open' } : current))
      })
    })
    return () => cancelAnimationFrame(frame)
  }, [phase])

  // exit → hidden：退出动画播完再卸载
  useEffect(() => {
    if (phase !== 'exit') {
      return
    }
    const timer = setTimeout(() => {
      setState((current) => (current.phase === 'exit' ? { ...current, phase: 'hidden' } : current))
    }, exitMs)
    return () => clearTimeout(timer)
  }, [phase, exitMs])

  return { mounted: phase !== 'hidden', stage: (phase === 'hidden' ? 'exit' : phase) as PresenceStage }
}

/**
 * value 变 true 后延迟 delayMs 才返回 true；变 false 立即返回 false；卸载时清理定时器。
 * 用于「列表逐项退出播一会，再整体滑出」这类错峰编排。
 */
export const useDelayedFlag = (value: boolean, delayMs: number): boolean => {
  const [on, setOn] = useState(false)

  useEffect(() => {
    if (!value) {
      setOn(false)
      return
    }
    const timer = setTimeout(() => setOn(true), delayMs)
    return () => clearTimeout(timer)
  }, [value, delayMs])

  return on
}
