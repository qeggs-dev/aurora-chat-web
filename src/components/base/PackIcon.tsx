import clsx from 'clsx'
import type { CSSProperties, ReactNode } from 'react'
import { useStyleAsset } from '../../services/style/index.js'
import { effectCss, useEffectsImage, useTilt } from '../../services/style/effects.js'
import { RENDER_CSS } from '../../services/style/types.js'
import styles from './PackIcon.module.css'

/**
 * 有样式包覆盖时渲染图片，否则原样显示内置图标。
 * 图标按清单里的 render 决定插值方式（像素图标用 pixelated），写进 inline style 的 image-rendering；
 * URL 只来自 createObjectURL 的 blob: 地址，不来自清单路径。
 *
 * effects：
 * - 阴影 / 透明度走 CSS（drop-shadow / opacity）；
 * - 描边 / 内外发光 / 浮雕先用 canvas 派生一张 PNG（异步，加载期间先用原图占位），该图的
 *   四周按特效半径留了 padding，因此用 scale 补偿，让图形看起来仍是原来的尺寸；
 * - 带 tilt 的图标套一层透视容器，鼠标移入按光标位置轻微偏转，移出回正（触屏 / reduced-motion 不启用）。
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
  const effects = asset?.meta?.effects
  const derived = useEffectsImage(asset?.url, effects, asset?.assetId)
  const tone = effectCss(effects)
  const tilt = useTilt(effects?.tilt)

  if (!asset) {
    // 没有样式包资源时也要能就地编辑（例如空白草稿）：包一层 data-style-slot 标记，
    // 用 display: contents 让它不产生盒模型、不改变原有布局。
    return (
      <span className={styles.slotTarget} data-style-slot={slot}>
        {fallback}
      </span>
    )
  }

  const scaleTransform = derived.scale > 1.0001 ? `scale(${derived.scale})` : undefined
  const transform = tilt.enabled
    ? [tilt.transform, scaleTransform].filter(Boolean).join(' ') || undefined
    : scaleTransform

  const image = (
    <img
      src={derived.url ?? asset.url}
      width={size}
      height={size}
      alt=""
      data-style-slot={slot}
      className={clsx(styles.icon, tilt.enabled && styles.tiltImage, className)}
      style={{
        // 不支持的关键字由 CSS 的无效值回退机制落到浏览器默认的 auto
        imageRendering: (RENDER_CSS[asset.meta?.render ?? 'auto'] ??
          'auto') as CSSProperties['imageRendering'],
        filter: tone.filter,
        opacity: tone.opacity,
        transform,
      }}
    />
  )

  // 没有 tilt 的图标保持原来的 DOM（不让透视容器影响既有布局）
  if (!tilt.enabled) {
    return image
  }

  return (
    <span
      className={styles.tiltFrame}
      data-style-slot={slot}
      style={{ width: size, height: size, perspective: tilt.frameStyle?.perspective }}
      {...tilt.handlers}
    >
      {image}
    </span>
  )
}
