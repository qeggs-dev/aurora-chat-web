/**
 * 样式包视觉特效：alpha 通道静态特效的 canvas 派生图、CSS 映射与伪 3D 偏转。
 *
 * 安全边界与 apply.ts 一致：这里只消费 zip.ts 已净化的枚举 / 数值 / 颜色值，
 * 不把清单字符串拼进 URL 或 HTML；派生图只以 `URL.createObjectURL(png Blob)` 形式出现。
 *
 * 派生图只计算一次：以「资源 ID + effects 指纹」为键缓存；切包 / 停用时由 store 调用
 * `pruneEffectsCache` 释放不再需要的 blob URL。处理失败的资源回退原图（只 warn 一次），
 * 同一时刻最多 4 个处理任务，其余排队，避免导入大包时一次占满主线程。
 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
import { EFFECT_DEFAULTS, TILT_DEFAULTS } from './types.js'
import type { StyleEffects, StyleTiltEffect } from './types.js'

/** 派生画布最大边长：超出的原图先等比缩小，避免大图长时间占用 canvas */
const MAX_CANVAS_SIZE = 1024
/** 同时处理的派生图上限 */
const MAX_CONCURRENT_JOBS = 4
/** 「alpha 足够不透明」的阈值：低于它的像素视为透明，用于距离变换 / 内发光反相 */
const ALPHA_THRESHOLD = 0.02

/** 样式包告警走 console.warn（项目全局禁 console，这里集中豁免一处） */
// oxlint-disable-next-line no-console
const warn = (message: string): void => console.warn(message)

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value))

const clamp01 = (value: number): number => clamp(value, 0, 1)

/** 稳定序列化：键排序后再拼字符串，保证同一份 effects 的指纹不随对象键顺序变化 */
const stableStringify = (value: unknown): string => {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null'
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`
  }
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`
}

/** FNV-1a 32 位哈希，输出 base36 字符串 */
const hashText = (text: string): string => {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}

/**
 * effects 指纹：缓存键的一部分。
 * 空对象与 undefined 等价（都不产生特效），统一返回 'none'——否则导入时被净化成 `{}`
 * 的资源会与没有 effects 的资源算出不同缓存键，白白重复派生。
 */
export const effectsHash = (effects: StyleEffects | undefined): string =>
  effects && Object.keys(effects).length > 0 ? hashText(stableStringify(effects)) : 'none'

/** 是否需要 alpha 通道派生图（描边 / 外发光 / 内发光 / 浮雕） */
export const hasStaticEffects = (effects: StyleEffects | undefined): boolean =>
  Boolean(effects && (effects.stroke || effects.outerGlow || effects.innerGlow || effects.emboss))

/** 是否需要 canvas 派生图：静态特效，或 window 裁切 / zoom 缩放 */
export const needsCanvasProcessing = (effects: StyleEffects | undefined): boolean =>
  Boolean(
    effects &&
    (hasStaticEffects(effects) ||
      effects.window !== undefined ||
      (effects.zoom !== undefined && effects.zoom !== 1))
  )

type ResolvedShadow = { x: number; y: number; blur: number; color: string }
type ResolvedGlow = { radius: number; color: string; intensity: number }
type ResolvedEmboss = { depth: number; angle: number; intensity: number }
type ResolvedStroke = { width: number; color: string }

type ResolvedEffects = {
  shadow?: ResolvedShadow
  outerGlow?: ResolvedGlow
  innerGlow?: ResolvedGlow
  emboss?: ResolvedEmboss
  stroke?: ResolvedStroke
}

/** 把 effects 里出现过的子字段与 EFFECT_DEFAULTS 合并；没出现的效果保持 undefined */
const resolveEffects = (effects: StyleEffects): ResolvedEffects => ({
  shadow: effects.shadow ? { ...EFFECT_DEFAULTS.shadow, ...effects.shadow } : undefined,
  outerGlow: effects.outerGlow ? { ...EFFECT_DEFAULTS.outerGlow, ...effects.outerGlow } : undefined,
  innerGlow: effects.innerGlow ? { ...EFFECT_DEFAULTS.innerGlow, ...effects.innerGlow } : undefined,
  emboss: effects.emboss ? { ...EFFECT_DEFAULTS.emboss, ...effects.emboss } : undefined,
  stroke: effects.stroke ? { ...EFFECT_DEFAULTS.stroke, ...effects.stroke } : undefined,
})

/** CSS 映射：阴影走 drop-shadow（天然按 alpha 生效），透明度走 opacity */
export type EffectCss = { filter?: string; opacity?: number }

export const effectCss = (effects: StyleEffects | undefined): EffectCss => {
  if (!effects) {
    return {}
  }
  const css: EffectCss = {}
  const shadow = effects.shadow ? { ...EFFECT_DEFAULTS.shadow, ...effects.shadow } : undefined
  if (shadow && (shadow.x !== 0 || shadow.y !== 0 || shadow.blur > 0)) {
    css.filter = `drop-shadow(${shadow.x}px ${shadow.y}px ${shadow.blur}px ${shadow.color})`
  }
  const opacity = effects.opacity ?? EFFECT_DEFAULTS.opacity
  if (opacity < 1) {
    css.opacity = opacity
  }
  return css
}

/* ============================ canvas 基础设施 ============================ */

type DrawableCanvas = OffscreenCanvas | HTMLCanvasElement
type DrawableContext = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D

const createCanvas = (
  width: number,
  height: number
): { canvas: DrawableCanvas; ctx: DrawableContext } => {
  if (typeof OffscreenCanvas === 'function') {
    const canvas = new OffscreenCanvas(width, height)
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (ctx) {
      return { canvas, ctx }
    }
  }
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) {
    throw new Error('2d canvas context unavailable')
  }
  return { canvas, ctx }
}

const canvasToBlob = async (canvas: DrawableCanvas): Promise<Blob> => {
  if (typeof OffscreenCanvas === 'function' && canvas instanceof OffscreenCanvas) {
    return canvas.convertToBlob({ type: 'image/png' })
  }
  return new Promise<Blob>((resolve, reject) => {
    ;(canvas as HTMLCanvasElement).toBlob((blob) => {
      if (blob) {
        resolve(blob)
      } else {
        reject(new Error('canvas.toBlob returned null'))
      }
    }, 'image/png')
  })
}

type LoadedImage = { image: CanvasImageSource; width: number; height: number; dispose: () => void }

/**
 * 解码图片：优先 createImageBitmap（再把 bitmap 画进 OffscreenCanvas），
 * 不可用 / SVG 解码失败时回退到 `<img>` 元素（drawImage 同样接受）。
 * 两种方式都只接受 blob: URL。
 */
const loadImage = async (sourceUrl: string): Promise<LoadedImage> => {
  const image = new Image()
  image.decoding = 'async'
  image.src = sourceUrl
  await image.decode()
  const width = image.naturalWidth || image.width
  const height = image.naturalHeight || image.height
  if (!width || !height) {
    throw new Error('image has no intrinsic size')
  }
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(image)
      return {
        image: bitmap,
        width,
        height,
        dispose: () => {
          bitmap.close()
        },
      }
    } catch {
      // 某些内核不支持把 SVG `<img>` 转 bitmap：继续用 <img> 直接 drawImage
    }
  }
  return {
    image,
    width,
    height,
    dispose: () => {
      image.src = ''
    },
  }
}

/** 只取 alpha 通道，归一化到 0..1；所有 alpha 运算都在这个数组上做 */
const extractAlpha = (data: Uint8ClampedArray): Float32Array => {
  const length = data.length / 4
  const alpha = new Float32Array(length)
  for (let index = 0; index < length; index += 1) {
    alpha[index] = data[index * 4 + 3] / 255
  }
  return alpha
}

/** 滑窗 box blur（水平 + 垂直各一遍）；两遍近似高斯，溢出按下标 clamp */
const boxBlur = (
  source: Float32Array,
  width: number,
  height: number,
  radius: number
): Float32Array => {
  if (radius < 1) {
    return source
  }
  const r = Math.floor(radius)
  const window = r * 2 + 1
  const horizontal = new Float32Array(source.length)
  const result = new Float32Array(source.length)
  for (let y = 0; y < height; y += 1) {
    const row = y * width
    let sum = 0
    for (let offset = -r; offset <= r; offset += 1) {
      sum += source[row + clamp(offset, 0, width - 1)]
    }
    for (let x = 0; x < width; x += 1) {
      horizontal[row + x] = sum / window
      sum += source[row + clamp(x + r + 1, 0, width - 1)]
      sum -= source[row + clamp(x - r, 0, width - 1)]
    }
  }
  for (let x = 0; x < width; x += 1) {
    let sum = 0
    for (let offset = -r; offset <= r; offset += 1) {
      sum += horizontal[clamp(offset, 0, height - 1) * width + x]
    }
    for (let y = 0; y < height; y += 1) {
      result[y * width + x] = sum / window
      sum += horizontal[clamp(y + r + 1, 0, height - 1) * width + x]
      sum -= horizontal[clamp(y - r, 0, height - 1) * width + x]
    }
  }
  return result
}

/** 模糊两次（半径各取一半），让发光边缘比单次 box blur 更接近高斯 */
const blurAlpha = (
  source: Float32Array,
  width: number,
  height: number,
  radius: number
): Float32Array => {
  if (radius < 1) {
    return source
  }
  const half = Math.max(1, Math.round(radius / 2))
  return boxBlur(boxBlur(source, width, height, half), width, height, half)
}

/**
 * 二值 alpha 的 chamfer 距离变换：返回每个像素到最近不透明像素的近似欧氏距离。
 * 描边用它对 alpha 做膨胀（距离 ≤ 描边宽度的外部像素获得描边 alpha）。
 */
const distanceTransform = (alpha: Float32Array, width: number, height: number): Float32Array => {
  const size = alpha.length
  const infinity = 1e9
  const distance = new Float32Array(size)
  for (let index = 0; index < size; index += 1) {
    distance[index] = alpha[index] > ALPHA_THRESHOLD ? 0 : infinity
  }
  const diagonal = Math.SQRT2
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x
      let best = distance[index]
      if (x > 0) {
        best = Math.min(best, distance[index - 1] + 1)
      }
      if (y > 0) {
        best = Math.min(best, distance[index - width] + 1)
        if (x > 0) {
          best = Math.min(best, distance[index - width - 1] + diagonal)
        }
        if (x < width - 1) {
          best = Math.min(best, distance[index - width + 1] + diagonal)
        }
      }
      distance[index] = best
    }
  }
  for (let y = height - 1; y >= 0; y -= 1) {
    for (let x = width - 1; x >= 0; x -= 1) {
      const index = y * width + x
      let best = distance[index]
      if (x < width - 1) {
        best = Math.min(best, distance[index + 1] + 1)
      }
      if (y < height - 1) {
        best = Math.min(best, distance[index + width] + 1)
        if (x < width - 1) {
          best = Math.min(best, distance[index + width + 1] + diagonal)
        }
        if (x > 0) {
          best = Math.min(best, distance[index + width - 1] + diagonal)
        }
      }
      distance[index] = best
    }
  }
  return distance
}

/** 用 1x1 canvas 解析 CSS 颜色（zip.ts 已保证只可能是 hex / rgb / hsl / transparent） */
let colorContext: CanvasRenderingContext2D | null | undefined

const parseColor = (value: string): [number, number, number, number] => {
  if (colorContext === undefined) {
    const canvas = document.createElement('canvas')
    canvas.width = 1
    canvas.height = 1
    colorContext = canvas.getContext('2d', { willReadFrequently: true })
  }
  const ctx = colorContext
  if (!ctx) {
    return [0, 0, 0, 1]
  }
  ctx.clearRect(0, 0, 1, 1)
  ctx.fillStyle = '#ff00ff'
  ctx.fillStyle = value
  ctx.fillRect(0, 0, 1, 1)
  const data = ctx.getImageData(0, 0, 1, 1).data
  return [data[0] / 255, data[1] / 255, data[2] / 255, data[3] / 255]
}

/* ============================ 合成 ============================ */

/** 预乘 alpha 的输出缓冲：out[i] 是预乘后的 r/g/b，out[i+3] 是 alpha */
const composite = (
  out: Float32Array,
  color: [number, number, number, number],
  alpha: Float32Array,
  multiplier: number
): void => {
  if (multiplier <= 0) {
    return
  }
  const colorAlpha = color[3] * multiplier
  for (let index = 0; index < alpha.length; index += 1) {
    const amount = alpha[index] * colorAlpha
    if (amount <= 0) {
      continue
    }
    const offset = index * 4
    out[offset] = color[0] * amount + out[offset] * (1 - amount)
    out[offset + 1] = color[1] * amount + out[offset + 1] * (1 - amount)
    out[offset + 2] = color[2] * amount + out[offset + 2] * (1 - amount)
    out[offset + 3] = amount + out[offset + 3] * (1 - amount)
  }
}

/** 原图按 source-over 画到最上层（source 是非预乘 RGBA） */
const compositeSource = (out: Float32Array, data: Uint8ClampedArray): void => {
  for (let index = 0; index < out.length / 4; index += 1) {
    const amount = data[index * 4 + 3] / 255
    if (amount <= 0) {
      continue
    }
    const offset = index * 4
    out[offset] = (data[index * 4] / 255) * amount + out[offset] * (1 - amount)
    out[offset + 1] = (data[index * 4 + 1] / 255) * amount + out[offset + 1] * (1 - amount)
    out[offset + 2] = (data[index * 4 + 2] / 255) * amount + out[offset + 2] * (1 - amount)
    out[offset + 3] = amount + out[offset + 3] * (1 - amount)
  }
}

/** 预乘缓冲还原成非预乘 RGBA，写回 canvas */
const writeImageData = (
  ctx: DrawableContext,
  out: Float32Array,
  width: number,
  height: number
): void => {
  const data = new Uint8ClampedArray(out.length)
  for (let offset = 0; offset < out.length; offset += 4) {
    const alpha = out[offset + 3]
    if (alpha > 0) {
      data[offset] = (out[offset] / alpha) * 255
      data[offset + 1] = (out[offset + 1] / alpha) * 255
      data[offset + 2] = (out[offset + 2] / alpha) * 255
    }
    data[offset + 3] = alpha * 255
  }
  ctx.putImageData(new ImageData(data, width, height), 0, 0)
}

/**
 * 单个图标的 alpha 通道特效：
 * 1) 外发光 = alpha 模糊 → 垫在最底层；
 * 2) 描边 = 距离变换膨胀 alpha → 染描边色；
 * 3) 原图画在上面；
 * 4) 内发光 = alpha 反相模糊 × 原 alpha → 叠在内部；
 * 5) 浮雕 = alpha 沿光照方向偏移求梯度 → 亮/暗叠在内部。
 * 画布四周按最大特效半径留 padding，避免发光被裁切；返回的 scale 供显示层补偿 padding。
 */
const renderIconEffects = async (
  sourceUrl: string,
  effects: StyleEffects
): Promise<{ blob: Blob; scale: number }> => {
  const zoom = effects.zoom ?? EFFECT_DEFAULTS.zoom
  if (zoom === 0) {
    // zoom = 0 表示不显示：给一个 1x1 透明图
    const { canvas } = createCanvas(1, 1)
    return { blob: await canvasToBlob(canvas), scale: 1 }
  }
  const resolved = resolveEffects(effects)
  const loaded = await loadImage(sourceUrl)
  try {
    // 先按 window 算裁切区域（归一化坐标 × 原图尺寸），缩放以裁切区域中心为基准
    const window = effects.window ?? {}
    const x1 = clamp(window.x1 ?? 0, 0, 1)
    const y1 = clamp(window.y1 ?? 0, 0, 1)
    const x2 = clamp(window.x2 ?? 1, x1, 1)
    const y2 = clamp(window.y2 ?? 1, y1, 1)
    const sourceX = x1 * loaded.width
    const sourceY = y1 * loaded.height
    const sourceWidth = Math.max(1, (x2 - x1) * loaded.width)
    const sourceHeight = Math.max(1, (y2 - y1) * loaded.height)
    const cap = Math.min(1, MAX_CANVAS_SIZE / Math.max(sourceWidth, sourceHeight))
    const contentWidth = Math.max(1, Math.round(sourceWidth * cap))
    const contentHeight = Math.max(1, Math.round(sourceHeight * cap))
    const strokeWidth = (resolved.stroke?.width ?? 0) * cap
    const outerRadius = (resolved.outerGlow?.radius ?? 0) * cap
    const innerRadius = (resolved.innerGlow?.radius ?? 0) * cap
    const embossDepth = (resolved.emboss?.depth ?? 0) * cap
    const padding = Math.ceil(Math.max(strokeWidth + 1, outerRadius * 2 + 2, embossDepth + 1, 2))
    const canvasWidth = contentWidth + padding * 2
    const canvasHeight = contentHeight + padding * 2
    const { canvas, ctx } = createCanvas(canvasWidth, canvasHeight)
    ctx.clearRect(0, 0, canvasWidth, canvasHeight)
    // zoom < 1 时内容缩小、四周留透明；zoom > 1 时内容放大，超出画布的部分被裁掉
    const drawWidth = contentWidth * zoom
    const drawHeight = contentHeight * zoom
    ctx.drawImage(
      loaded.image,
      sourceX,
      sourceY,
      sourceWidth,
      sourceHeight,
      padding + (contentWidth - drawWidth) / 2,
      padding + (contentHeight - drawHeight) / 2,
      drawWidth,
      drawHeight
    )
    const sourceData = ctx.getImageData(0, 0, canvasWidth, canvasHeight)
    const alpha = extractAlpha(sourceData.data)
    const out = new Float32Array(alpha.length * 4)

    // 1) 外发光（底层）
    if (resolved.outerGlow && outerRadius > 0) {
      const glow = blurAlpha(alpha, canvasWidth, canvasHeight, outerRadius)
      composite(out, parseColor(resolved.outerGlow.color), glow, resolved.outerGlow.intensity)
    }

    // 2) 描边：距离不透明像素越远 alpha 越低，形成以 glyph 为中心的膨胀
    if (resolved.stroke && strokeWidth > 0) {
      const distance = distanceTransform(alpha, canvasWidth, canvasHeight)
      const strokeAlpha = new Float32Array(alpha.length)
      for (let index = 0; index < strokeAlpha.length; index += 1) {
        strokeAlpha[index] = clamp01(strokeWidth + 1 - distance[index])
      }
      composite(out, parseColor(resolved.stroke.color), strokeAlpha, 1)
    }

    // 3) 原图
    compositeSource(out, sourceData.data)

    // 4) 内发光：反相 alpha 模糊后乘回原 alpha，只作用在字形内部靠边处
    if (resolved.innerGlow && innerRadius > 0) {
      const inverted = new Float32Array(alpha.length)
      for (let index = 0; index < alpha.length; index += 1) {
        inverted[index] = 1 - alpha[index]
      }
      const blurred = blurAlpha(inverted, canvasWidth, canvasHeight, innerRadius)
      const inner = new Float32Array(alpha.length)
      for (let index = 0; index < alpha.length; index += 1) {
        inner[index] = alpha[index] * blurred[index]
      }
      composite(out, parseColor(resolved.innerGlow.color), inner, resolved.innerGlow.intensity)
    }

    // 5) 浮雕：沿光照方向取 alpha 梯度，变亮处加白、变暗处加黑，只叠在字形内部
    if (resolved.emboss && embossDepth > 0) {
      const angle = (resolved.emboss.angle * Math.PI) / 180
      const directionX = Math.cos(angle)
      const directionY = -Math.sin(angle)
      const highlight = new Float32Array(alpha.length)
      const shadow = new Float32Array(alpha.length)
      const sample = (x: number, y: number): number =>
        alpha[
          clamp(Math.round(y), 0, canvasHeight - 1) * canvasWidth +
            clamp(Math.round(x), 0, canvasWidth - 1)
        ]
      for (let y = 0; y < canvasHeight; y += 1) {
        for (let x = 0; x < canvasWidth; x += 1) {
          const index = y * canvasWidth + x
          const clip = alpha[index]
          if (clip <= ALPHA_THRESHOLD) {
            continue
          }
          const towardLight = sample(x + directionX * embossDepth, y + directionY * embossDepth)
          const awayFromLight = sample(x - directionX * embossDepth, y - directionY * embossDepth)
          const delta = towardLight - awayFromLight
          if (delta > 0) {
            highlight[index] = delta * resolved.emboss.intensity * clip
          } else if (delta < 0) {
            shadow[index] = -delta * resolved.emboss.intensity * clip
          }
        }
      }
      composite(out, [1, 1, 1, 1], highlight, 1)
      composite(out, [0, 0, 0, 1], shadow, 1)
    }

    writeImageData(ctx, out, canvasWidth, canvasHeight)
    const blob = await canvasToBlob(canvas)
    return { blob, scale: canvasWidth / contentWidth }
  } finally {
    loaded.dispose()
  }
}

/* ============================ 派生图缓存 ============================ */

type CacheEntry = {
  sourceUrl: string
  url: string
  scale: number
  pending: boolean
}

const cache = new Map<string, CacheEntry>()
const listeners = new Set<() => void>()
const warnedKeys = new Set<string>()
let version = 0
/** 缓存整体清理的代际号：清空后旧任务的结果直接丢弃 */
let generation = 0

const notify = (): void => {
  version += 1
  for (const listener of listeners) {
    listener()
  }
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

const getVersion = (): number => version

const warnOnce = (key: string, error: unknown): void => {
  if (warnedKeys.has(key)) {
    return
  }
  warnedKeys.add(key)
  warn(
    `[style-pack] 图标特效处理失败，已回退原图：${error instanceof Error ? error.message : String(error)}`
  )
}

let runningJobs = 0
const jobQueue: Array<() => void> = []

const scheduleJob = (task: () => Promise<void>): void => {
  const start = (): void => {
    runningJobs += 1
    void task().finally(() => {
      runningJobs -= 1
      const next = jobQueue.shift()
      if (next) {
        next()
      }
    })
  }
  if (runningJobs < MAX_CONCURRENT_JOBS) {
    start()
  } else {
    jobQueue.push(start)
  }
}

/** 登记（或复用）一次派生：同一 key 只算一次，失败回退原图 */
const ensureDerived = (key: string, sourceUrl: string, effects: StyleEffects): void => {
  const existing = cache.get(key)
  if (existing) {
    if (existing.sourceUrl === sourceUrl) {
      return
    }
    if (existing.url !== existing.sourceUrl) {
      URL.revokeObjectURL(existing.url)
    }
    cache.delete(key)
  }
  const entry: CacheEntry = { sourceUrl, url: sourceUrl, scale: 1, pending: true }
  cache.set(key, entry)
  const jobGeneration = generation
  scheduleJob(async () => {
    let derived: { url: string; scale: number } | undefined
    try {
      const { blob, scale } = await renderIconEffects(sourceUrl, effects)
      derived = { url: URL.createObjectURL(blob), scale }
    } catch (error) {
      warnOnce(key, error)
    }
    const current = cache.get(key)
    if (
      jobGeneration !== generation ||
      !current ||
      current.sourceUrl !== sourceUrl ||
      current !== entry
    ) {
      if (derived) {
        URL.revokeObjectURL(derived.url)
      }
      return
    }
    current.pending = false
    if (derived) {
      current.url = derived.url
      current.scale = derived.scale
    }
    notify()
  })
}

/**
 * 释放不再被引用的派生图：切包 / 停用 / 列表刷新后，由 store 传入当前仍有效的原图 blob URL 集合。
 * 指向已失效原图的派生图全部 revoke，挂载中的 hook 会按新 URL 重新派生。
 */
export const pruneEffectsCache = (keepSourceUrls: ReadonlySet<string>): void => {
  let changed = false
  for (const [key, entry] of cache) {
    if (keepSourceUrls.has(entry.sourceUrl)) {
      continue
    }
    if (entry.url !== entry.sourceUrl) {
      URL.revokeObjectURL(entry.url)
    }
    cache.delete(key)
    changed = true
  }
  if (changed) {
    generation += 1
    notify()
  }
}

/**
 * 非 React 场景（背景资源写 CSS 变量前）直接派生一张图：
 * 调用方拿到 objectURL 后自行管理释放（store 会把它并入 activeUrls）。
 */
export const createEffectsImageUrl = async (
  sourceUrl: string,
  effects: StyleEffects
): Promise<string | undefined> => {
  try {
    const { blob } = await renderIconEffects(sourceUrl, effects)
    return URL.createObjectURL(blob)
  } catch (error) {
    warn(
      `[style-pack] 背景特效处理失败，已回退原图：${
        error instanceof Error ? error.message : String(error)
      }`
    )
    return undefined
  }
}

export type EffectsImageState = { url: string | undefined; scale: number }

/**
 * 资源 URL + effects → 派生图 URL（异步，处理期间先用原图占位）。
 * 只对图标类资源调用；背景 / 文本的 effects 在导入时已净化。
 */
export const useEffectsImage = (
  sourceUrl: string | undefined,
  effects: StyleEffects | undefined,
  cacheKey: string | undefined
): EffectsImageState => {
  const snapshot = useSyncExternalStore(subscribe, getVersion, getVersion)
  const key = sourceUrl && cacheKey ? `${cacheKey}|${effectsHash(effects)}` : undefined
  const entry = key ? cache.get(key) : undefined
  const resolved = entry && entry.sourceUrl === sourceUrl ? entry : undefined
  useEffect(() => {
    if (!sourceUrl || !key || !effects || !needsCanvasProcessing(effects)) {
      return
    }
    // snapshot 参与依赖：缓存被清理后重新派生
    ensureDerived(key, sourceUrl, effects)
  }, [sourceUrl, key, effects, snapshot])
  if (!sourceUrl) {
    return { url: undefined, scale: 1 }
  }
  return { url: resolved?.url ?? sourceUrl, scale: resolved?.scale ?? 1 }
}

/* ============================ 伪 3D 偏转 ============================ */

/** 合并 card.tilt / effects.tilt 的缺省值 */
export const resolveTilt = (
  tilt: StyleTiltEffect
): { maxAngle: number; perspective: number; scale: number } => ({
  ...TILT_DEFAULTS,
  ...tilt,
})

const prefersReducedMotion = (): boolean =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches

export type TiltHandlers = {
  onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void
  onPointerLeave: () => void
  onPointerCancel: () => void
}

export type TiltState = {
  enabled: boolean
  /** 外层透视容器的 style；未启用时 undefined（不改变原布局） */
  frameStyle: CSSProperties | undefined
  /** 内层元素的 transform（rotateX / rotateY / scale）；未偏转时 undefined */
  transform: string | undefined
  handlers: TiltHandlers
}

/**
 * 伪 3D 偏转：pointermove 按光标在元素内的相对位置计算 rotateX / rotateY（限幅），
 * pointerleave / pointercancel 回正；prefers-reduced-motion: reduce 与触屏（pointerType !== mouse）不启用。
 * 只挂指针事件，不拦截点击与键盘事件。
 */
export const useTilt = (tilt: StyleTiltEffect | undefined): TiltState => {
  const [transform, setTransform] = useState<string | undefined>(undefined)
  const [reducedMotion, setReducedMotion] = useState<boolean>(prefersReducedMotion)
  const resolved = useMemo(() => (tilt ? resolveTilt(tilt) : undefined), [tilt])
  const enabled = Boolean(resolved) && !reducedMotion

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return
    }
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = (): void => setReducedMotion(query.matches)
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])

  useEffect(() => {
    if (!enabled) {
      setTransform(undefined)
    }
  }, [enabled])

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>): void => {
      if (!enabled || !resolved || event.pointerType !== 'mouse') {
        return
      }
      const rect = event.currentTarget.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) {
        return
      }
      const ratioX = (event.clientX - rect.left) / rect.width - 0.5
      const ratioY = (event.clientY - rect.top) / rect.height - 0.5
      const rotateY = ratioX * resolved.maxAngle * 2
      const rotateX = ratioY * resolved.maxAngle * -2
      setTransform(
        `rotateX(${rotateX.toFixed(2)}deg) rotateY(${rotateY.toFixed(2)}deg) scale(${resolved.scale})`
      )
    },
    [enabled, resolved]
  )

  const reset = useCallback((): void => setTransform(undefined), [])

  return {
    enabled,
    frameStyle: enabled && resolved ? { perspective: `${resolved.perspective}px` } : undefined,
    transform: enabled ? transform : undefined,
    handlers: { onPointerMove, onPointerLeave: reset, onPointerCancel: reset },
  }
}
