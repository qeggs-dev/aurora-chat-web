#!/usr/bin/env node
/**
 * 生成内置许可模板正文：从 SPDX license-list-data 官方数据下载 → 写成
 * `web/src/services/license/templates.generated.ts`，运行时只读这份离线文件，绝不联网。
 *
 * 用法（在 web/ 下）：
 *   node tools/license/fetch-license-templates.mjs
 *
 * 数据源优先级：
 *   1. https://raw.githubusercontent.com/spdx/license-list-data/main/json/details/<ID>.json
 *   2. 匿名镜像前缀 + 完整 URL（只用于公开内容 GET，不带任何凭据）：
 *      ghproxy.net / gh-proxy.com / gh-proxy.org / fastgit.cc
 *   3. jsDelivr 的 GitHub 镜像（同一份 SPDX 仓库，仅当上面的来源都不通时使用）
 *
 * 脚本可重复运行：成功时整体覆盖生成文件；任何一个 license 没下到都明确报错并列出失败 ID。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.dirname(path.dirname(here))
const OUT_FILE = path.join(root, 'src/services/license/templates.generated.ts')

/** 目标许可证（SPDX ID）：代码许可 + CC 全系列 + PolyForm 非商业 */
const LICENSES = [
  'MIT',
  'Apache-2.0',
  'GPL-2.0-only',
  'GPL-3.0-only',
  'LGPL-3.0-only',
  'AGPL-3.0-only',
  'MPL-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  'Unlicense',
  'WTFPL',
  'PolyForm-Noncommercial-1.0.0',
  'CC0-1.0',
  'CC-BY-4.0',
  'CC-BY-SA-4.0',
  'CC-BY-NC-4.0',
  'CC-BY-NC-SA-4.0',
  'CC-BY-ND-4.0',
  'CC-BY-NC-ND-4.0',
]

const SPDX_DETAILS =
  'https://raw.githubusercontent.com/spdx/license-list-data/main/json/details'

/**
 * 下载来源：官方 GitHub raw 优先，失败时用匿名镜像前缀拼接完整 URL；
 * 镜像域名白名单写死在脚本里，防止把请求发到未知地址。
 */
export const MIRROR_PREFIXES = [
  'https://ghproxy.net/',
  'https://gh-proxy.com/',
  'https://gh-proxy.org/',
  'https://fastgit.cc/',
]
/** jsDelivr 的 GitHub 镜像（SPDX 仓库同一份数据），兜底使用 */
export const JSDELIVR_BASE = 'https://cdn.jsdelivr.net/gh/spdx/license-list-data@main'

export const SOURCES = [
  { id: 'spdx-github-raw', build: (license) => `${SPDX_DETAILS}/${license}.json` },
  ...MIRROR_PREFIXES.map((prefix) => ({
    id: prefix.replace(/^https:\/\/|\/$/g, ''),
    build: (license) => `${prefix}${SPDX_DETAILS}/${license}.json`,
  })),
  { id: 'jsdelivr', build: (license) => `${JSDELIVR_BASE}/json/details/${license}.json` },
]

/** 允许请求的域名白名单：只有官方 SPDX raw 与已知匿名镜像 */
export const SOURCE_HOSTS = [
  'raw.githubusercontent.com',
  'ghproxy.net',
  'gh-proxy.com',
  'gh-proxy.org',
  'fastgit.cc',
  'cdn.jsdelivr.net',
]

const TIMEOUT_MS = 15_000

const fetchJson = async (url) => {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    redirect: 'follow',
    headers: { Accept: 'application/json' },
  })
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`)
  }
  return response.json()
}

/** 当前验证可用、优先使用的来源下标（后续 license 先试它） */
let preferredSource = 0
const failures = []

const downloadLicense = async (license) => {
  const order = [
    SOURCES[preferredSource],
    ...SOURCES.filter((_, index) => index !== preferredSource),
  ]
  for (const source of order) {
    try {
      const data = await fetchJson(source.build(license))
      if (typeof data.licenseText !== 'string' || data.licenseText.length < 100) {
        throw new Error('licenseText missing or too short')
      }
      preferredSource = SOURCES.indexOf(source)
      return {
        id: license,
        name: typeof data.name === 'string' && data.name ? data.name : license,
        licenseText: data.licenseText,
        spdxTemplate: typeof data.standardLicenseTemplate === 'string' ? data.standardLicenseTemplate : '',
        sourceUrl: source.build(license),
        source: source.id,
        isOsiApproved: data.isOsiApproved === true,
      }
    } catch (error) {
      // 换下一个来源；全部失败时记录原因
      failures.push(`${license} via ${source.id}: ${error instanceof Error ? error.message : error}`)
    }
  }
  return null
}

const main = async () => {
  const result = {}
  const sources = new Map()
  for (const license of LICENSES) {
    const entry = await downloadLicense(license)
    if (entry === null) {
      continue
    }
    sources.set(entry.source, (sources.get(entry.source) ?? 0) + 1)
    result[license] = {
      name: entry.name,
      licenseText: entry.licenseText,
      spdxTemplate: entry.spdxTemplate,
      sourceUrl: entry.sourceUrl,
      isOsiApproved: entry.isOsiApproved,
    }
    console.log(`✔ ${license} (${entry.licenseText.length} chars, via ${entry.source})`)
  }
  const missing = LICENSES.filter((license) => result[license] === undefined)
  if (missing.length > 0) {
    console.error(`\n✖ 以下 license 未能下载：${missing.join(', ')}`)
    for (const failure of failures.slice(-40)) {
      console.error(`  - ${failure}`)
    }
    process.exit(1)
  }
  mkdirSync(path.dirname(OUT_FILE), { recursive: true })
  const header = [
    '/**',
    ' * 内置许可模板正文（离线数据，运行时绝不联网）。',
    ' *',
    ' * 由 `web/tools/license/fetch-license-templates.mjs` 生成，请勿手改：',
    ' *   node tools/license/fetch-license-templates.mjs',
    ' *',
    ' * 数据源：SPDX license-list-data（https://github.com/spdx/license-list-data）',
    ` * 下载来源：${[...sources.keys()].sort().join(', ')}`,
    ` * 生成时间：${new Date().toISOString()}`,
    ' *',
    ' * 每条记录：{ name, licenseText, spdxTemplate, sourceUrl, isOsiApproved }。',
    ' * 摘要 / 官方链接 / 决策树规则由 templates.ts 与 decide.ts 手写，不依赖网络。',
    ' */',
  ].join('\n')
  const body = `export type GeneratedLicense = {\n  name: string\n  licenseText: string\n  spdxTemplate: string\n  sourceUrl: string\n  isOsiApproved: boolean\n}\n\nexport const LICENSE_TEMPLATES_DATA: Record<string, GeneratedLicense> = ${JSON.stringify(
    result,
    null,
    2
  )}\n`
  writeFileSync(OUT_FILE, `${header}\n${body}`)
  console.log(`\n生成 ${Object.keys(result).length} 个模板 → ${OUT_FILE}`)
  console.log(`下载来源统计：${JSON.stringify(Object.fromEntries(sources))}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
