import clsx from 'clsx'
import type { ReactNode } from 'react'
import { useStyleAssetUrl } from '../../services/style/index.js'
import styles from './PackIcon.module.css'

/** 有样式包覆盖时渲染图片，否则原样显示内置图标 */
export const PackIcon = ({
  slot,
  size = 16,
  className,
  fallback,
}: {
  slot: string
  size?: number
  className?: string
  fallback: ReactNode
}) => {
  const url = useStyleAssetUrl(slot)
  return url ? (
    <img src={url} width={size} height={size} alt="" className={clsx(styles.icon, className)} />
  ) : (
    fallback
  )
}
