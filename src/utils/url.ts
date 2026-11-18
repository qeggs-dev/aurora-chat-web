/** 可安全渲染为链接的 URL 协议：只放行 http / https（来源、引用、归档链接统一用它）。 */
export const isWebUrl = (value: string): boolean => {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol)
  } catch {
    return false
  }
}
