/** 版本比较：与 GitHub Release tag 对比用 semver 语义，忽略 `v` 前缀。 */

export type ParsedVersion = {
  major: number
  minor: number
  patch: number
  /** 预发布标识（`-beta.1` → ['beta','1']）；正式版为空数组 */
  prerelease: ReadonlyArray<string>
}

/** `v0.3.17` / `0.3.17` / `1.2.3-beta.1` / `1.2.3+build` */
const VERSION_PATTERN = /^[vV]?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

const NUMERIC = /^\d+$/

/** 解析 semver；格式不符合返回 null，不抛错 */
export const parseVersion = (input: string): ParsedVersion | null => {
  if (typeof input !== 'string') {
    return null
  }
  const match = VERSION_PATTERN.exec(input.trim())
  if (!match) {
    return null
  }
  const major = Number(match[1])
  const minor = Number(match[2])
  const patch = Number(match[3])
  if (![major, minor, patch].every(Number.isSafeInteger)) {
    return null
  }
  const prerelease = match[4] ? match[4].split('.') : []
  // semver 不允许空标识（`1.2.3-` / `1.2.3-a..b`）
  if (prerelease.some((part) => part.length === 0)) {
    return null
  }
  return { major, minor, patch, prerelease }
}

const comparePrerelease = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): number => {
  // 正式版大于任何预发布版
  if (a.length === 0 && b.length === 0) {
    return 0
  }
  if (a.length === 0) {
    return 1
  }
  if (b.length === 0) {
    return -1
  }
  const length = Math.min(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    const left = a[index]
    const right = b[index]
    if (left === right) {
      continue
    }
    const leftNumeric = NUMERIC.test(left)
    const rightNumeric = NUMERIC.test(right)
    if (leftNumeric && rightNumeric) {
      return Number(left) < Number(right) ? -1 : 1
    }
    // 数字标识小于字母数字标识
    if (leftNumeric) {
      return -1
    }
    if (rightNumeric) {
      return 1
    }
    return left < right ? -1 : 1
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1
}

/**
 * 按 semver 比较两个版本：a < b 返回 -1，相等 0，a > b 返回 1。
 * 任一版本无法解析时返回 null（调用方决定如何提示，而不是静默当成相等）。
 */
export const compareVersions = (a: string, b: string): number | null => {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (!left || !right) {
    return null
  }
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (left[key] !== right[key]) {
      return left[key] < right[key] ? -1 : 1
    }
  }
  return comparePrerelease(left.prerelease, right.prerelease)
}

/** candidate 是否比 current 新；任一版本非法时按「不是更新」处理 */
export const isNewerVersion = (candidate: string, current: string): boolean =>
  compareVersions(candidate, current) === 1

/** 当前应用版本：来自 rspack HtmlRspackPlugin 注入的 `<meta name="application-version">` */
export const readApplicationVersion = (): string => {
  if (typeof document === 'undefined') {
    return ''
  }
  const meta = document.querySelector('meta[name="application-version"]')
  return meta?.getAttribute('content')?.trim() ?? ''
}
