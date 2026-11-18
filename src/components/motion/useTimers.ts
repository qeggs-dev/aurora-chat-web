import { useCallback, useEffect, useRef } from 'react'

/**
 * 可打断的定时器集合：后来的一次 schedule 不会自动取消前面的，但 clear() 与卸载会全部清理。
 * 组件里的动效编排（高亮 1/3 退出、列表退出后重新进入等）都走这里，避免中途状态错乱。
 */
export const useTimers = () => {
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>())

  const clear = useCallback(() => {
    for (const timer of timers.current) {
      clearTimeout(timer)
    }
    timers.current.clear()
  }, [])

  const schedule = useCallback((callback: () => void, delayMs: number) => {
    const timer = setTimeout(() => {
      timers.current.delete(timer)
      callback()
    }, delayMs)
    timers.current.add(timer)
  }, [])

  useEffect(() => clear, [clear])

  return { schedule, clear }
}
