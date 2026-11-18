import { useSyncExternalStore } from 'react'

/** prefers-reduced-motion: reduce 时所有动效降级为无位移 / 极短淡入 */
const query = window.matchMedia('(prefers-reduced-motion: reduce)')

const subscribe = (listener: () => void) => {
  query.addEventListener('change', listener)
  return () => query.removeEventListener('change', listener)
}

const getSnapshot = () => query.matches

const getServerSnapshot = () => false

export const usePrefersReducedMotion = (): boolean =>
  useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
