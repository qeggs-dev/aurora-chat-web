import clsx from 'clsx'
import type { CSSProperties, ReactNode } from 'react'
import { useStyleAsset } from '../../services/style/index.js'
import { RENDER_CSS } from '../../services/style/types.js'
import styles from './PackIcon.module.css'

/**
 * 有样式包覆盖时渲染图片，否则原样显示内置图标。
 * 图标按清单里的 render 决定插值方式（像素图标用 pixelated），写进 inline style 的 image-rendering；
 * URL 只来自 createObjectURL 的 blob: 地址，不来自清单路径。
 */
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
  const asset = useStyleAsset(slot)
  return asset ? (
    <img
      src={asset.url}
      width={size}
      height={size}
      alt=""
      className={clsx(styles.icon, className)}
      style={{
        // 不支持的关键字由 CSS 的无效值回退机制落到浏览器默认的 auto
        imageRendering: (RENDER_CSS[asset.meta?.render ?? 'auto'] ?? 'auto') as CSSProperties['imageRendering'],
      }}
    />
  ) : (
    fallback
  )
}
