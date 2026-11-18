/**
 * 内置许可模板（纯数据 + 纯函数，便于单测；运行时绝不联网）。
 *
 * 正文来自 SPDX license-list-data，经 `tools/license/fetch-license-templates.mjs`
 * 下载后生成 `templates.generated.ts`；这里只做「占位符化 / 署名行替换」：
 * - 代码许可：把版权行替换为 `Copyright (c) {{year}} {{name}}`，
 *   原文没有署名占位符时在正文前补这一行；其它条款一个字不改；
 * - CC 许可：在完整法律文本前补一行署名
 *   `© {{year}} {{name}} — Licensed under <名称>`，原文完整保留。
 * - `{{project}}` 仅在原文出现 `<program>` 等程序名占位符时填充。
 *
 * 模板只是初始填充，用户可以继续手动修改任意文字（见 LicenseEditor）。
 */
import { LICENSE_TEMPLATES_DATA } from './templates.generated.js'

export type LicenseTemplateKind = 'code' | 'creativeCommons'

export type LicenseTemplateFill = {
  year: number | string
  author: string
  project: string
}

export type LicenseTemplate = {
  id: string
  name: string
  kind: LicenseTemplateKind
  /** 1–3 句通俗摘要（中英成对，纯内置文案） */
  summary: { zh: string; en: string }
  /** 官方原文 / 条款页面（https，仅跳转，不在应用内抓取） */
  officialUrl: string
  /** 用于从已有文本粗略识别许可（语言包详情展示摘要用） */
  markers: readonly string[]
  /** 含 {{year}} / {{author}} / {{project}} 占位符的完整许可文本 */
  text: string
}

/**
 * 允许跳转的官方链接域名白名单：许可证链接只做外部跳转，
 * 应用不联网抓取页面，离线也能展示内置摘要。
 */
export const LICENSE_LINK_HOSTS: readonly string[] = [
  'spdx.org',
  'www.apache.org',
  'www.gnu.org',
  'www.mozilla.org',
  'opensource.org',
  'www.isc.org',
  'unlicense.org',
  'www.wtfpl.net',
  'polyformproject.org',
  'creativecommons.org',
]

/** 校验官方链接：必须是 https 且域名在白名单内（供组件与单测共用） */
export const isAllowedLicenseUrl = (url: string): boolean => {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && LICENSE_LINK_HOSTS.includes(parsed.hostname)
  } catch {
    return false
  }
}

/**
 * 代码许可：SPDX 正文里的版权行可能写成 `<year> <copyright holders>`、`[yyyy]` 等，
 * 统一替换为 `Copyright (c) {{year}} {{name}}`；其余条款保持原样。
 * 若原文完全没有署名占位符（如 MPL / LGPL / WTFPL），在正文前补一行版权声明。
 */
const CODE_COPYRIGHT_PATTERNS: readonly [RegExp, string][] = [
  [/Copyright\s*\(c\)\s*<year>\s*<copyright holders?>/gi, 'Copyright (c) {{year}} {{name}}'],
  [/Copyright\s*\(c\)\s*<year>\s*<owner>/gi, 'Copyright (c) {{year}} {{name}}'],
  [/Copyright\s*\(c\)\s*<year>\s*<name of author>/gi, 'Copyright (c) {{year}} {{name}}'],
  [/Copyright\s*<year>\s*<owner>/gi, 'Copyright (c) {{year}} {{name}}'],
  [/Copyright\s*\[yyyy\]\s*\[name of copyright owner\]/gi, 'Copyright (c) {{year}} {{name}}'],
]

const CODE_TOKEN_PATTERNS: readonly [RegExp, string][] = [
  [/<copyright holders?>/gi, '{{name}}'],
  [/<name of author>/gi, '{{name}}'],
  [/<owner>/gi, '{{name}}'],
  [/<program>/gi, '{{project}}'],
  [/\[name of copyright owner\]/gi, '{{name}}'],
  [/\[yyyy\]/gi, '{{year}}'],
  [/<year>/gi, '{{year}}'],
]

const normalizeText = (raw: string): string => raw.replace(/\r\n/g, '\n')

/** 代码许可正文：版权行替换（含兜底补行），其它条款不动 */
const renderCodeLicense = (licenseText: string): string => {
  let text = normalizeText(licenseText)
  for (const [pattern, replacement] of CODE_COPYRIGHT_PATTERNS) {
    text = text.replace(pattern, replacement)
  }
  for (const [pattern, replacement] of CODE_TOKEN_PATTERNS) {
    text = text.replace(pattern, replacement)
  }
  return text.includes('{{name}}') ? text : `Copyright (c) {{year}} {{name}}\n\n${text}`
}

/** CC 许可正文：完整法律文本前补一行署名，正文原样保留 */
const renderCcLicense = (licenseText: string, name: string): string =>
  `© {{year}} {{name}} — Licensed under ${name}\n\n${normalizeText(licenseText)}`

/** 定义表里可选的旧署名行：正文署名现在由 generated 数据统一生成，该字段不再使用 */
const attributionHeader = (title: string): string =>
  `"{{project}}" © {{year}} {{author}}, licensed under ${title}.\n\n`

type Definition = {
  id: string
  name: string
  kind: LicenseTemplateKind
  summary: { zh: string; en: string }
  markers: readonly string[]
  /** 原文里没有署名占位符时，在正文前补一行署名 */
  header?: string
}

/** 顺序即 UI 顺序：代码许可在前、CC 许可在后 */
const DEFINITIONS: readonly Definition[] = [
  {
    id: 'MIT',
    name: 'MIT',
    kind: 'code',
    summary: {
      zh: '最宽松的常见许可：可商用、可修改、可再发布，只需保留版权与许可声明。',
      en: 'A permissive license: use, modify and redistribute freely, just keep the copyright and license notice.',
    },
    markers: ['MIT License'],
  },
  {
    id: 'Apache-2.0',
    name: 'Apache-2.0',
    kind: 'code',
    summary: {
      zh: '宽松许可，额外提供明确的专利授权；修改过的文件需要标注，并保留 NOTICE 与许可文本。',
      en: 'Permissive with an explicit patent grant; mark modified files and keep the NOTICE and license text.',
    },
    markers: ['Apache License', 'Version 2.0'],
  },
  {
    id: 'GPL-2.0-only',
    name: 'GPL-2.0',
    kind: 'code',
    summary: {
      zh: '强 copyleft：分发修改版或衍生作品时必须以 GPL-2.0 开源完整源代码。',
      en: 'Strong copyleft: distributing modified or derivative works requires releasing the full source under GPL-2.0.',
    },
    markers: ['GNU GENERAL PUBLIC LICENSE', 'Version 2, June 1991'],
    header: 'Copyright (c) {{year}} {{author}}\n"{{project}}"\n\n',
  },
  {
    id: 'GPL-3.0-only',
    name: 'GPL-3.0',
    kind: 'code',
    summary: {
      zh: '强 copyleft，并加入专利授权与反 Tivo 化条款；分发衍生作品需以 GPL-3.0 开源。',
      en: 'Strong copyleft with a patent grant and anti-tivoization terms; derivatives must be released under GPL-3.0.',
    },
    markers: ['GNU GENERAL PUBLIC LICENSE', 'Version 3, 29 June 2007'],
  },
  {
    id: 'LGPL-3.0-only',
    name: 'LGPL-3.0',
    kind: 'code',
    summary: {
      zh: '弱 copyleft：允许以动态链接等方式在专有程序中使用库，修改库本身时需开源库代码。',
      en: 'Weak copyleft: use the library in proprietary programs (e.g. dynamically linked), but share changes to the library itself.',
    },
    markers: ['GNU LESSER GENERAL PUBLIC LICENSE', 'Version 3, 29 June 2007'],
    header: attributionHeader('LGPL-3.0'),
  },
  {
    id: 'AGPL-3.0-only',
    name: 'AGPL-3.0',
    kind: 'code',
    summary: {
      zh: '最强 copyleft：即使只通过网络提供服务，也必须向用户提供对应源代码。',
      en: 'The strongest copyleft: even offering the software as a network service obliges you to provide the source.',
    },
    markers: ['GNU AFFERO GENERAL PUBLIC LICENSE', 'Version 3, 19 November 2007'],
    header: attributionHeader('AGPL-3.0'),
  },
  {
    id: 'MPL-2.0',
    name: 'MPL-2.0',
    kind: 'code',
    summary: {
      zh: '文件级 copyleft：修改过的 MPL 文件必须开源，其它文件可与专有代码组合。',
      en: 'File-level copyleft: modified MPL files must be shared; other files may stay proprietary.',
    },
    markers: ['Mozilla Public License Version 2.0'],
    header: attributionHeader('MPL-2.0'),
  },
  {
    id: 'BSD-2-Clause',
    name: 'BSD-2-Clause',
    kind: 'code',
    summary: {
      zh: '宽松许可：保留版权与免责声明即可商用、修改、再发布（不涉及专利与背书条款）。',
      en: 'Permissive: keep the copyright and disclaimer, then use, modify and redistribute freely.',
    },
    markers: ['Redistribution and use in source and binary forms'],
  },
  {
    id: 'BSD-3-Clause',
    name: 'BSD-3-Clause',
    kind: 'code',
    summary: {
      zh: '宽松许可，比 BSD-2 多一条：未经许可不得用作者名义为衍生产品背书。',
      en: 'Permissive; adds a no-endorsement clause: do not use the authors’ names to promote derivatives.',
    },
    markers: ['Neither the name of the copyright holder'],
  },
  {
    id: 'ISC',
    name: 'ISC',
    kind: 'code',
    summary: {
      zh: '与 MIT 等价的宽松许可，文本更短；保留版权与许可声明即可。',
      en: 'A short permissive license equivalent to MIT: keep the copyright and permission notice.',
    },
    markers: ['ISC License'],
  },
  {
    id: 'Unlicense',
    name: 'Unlicense',
    kind: 'code',
    summary: {
      zh: '放弃著作权，将作品投入公有领域；任何用途都可自由使用，无需署名。',
      en: 'Waives copyright and dedicates the work to the public domain; no attribution required.',
    },
    markers: ['This is free and unencumbered software released into the public domain'],
    header: 'Copyright (c) {{year}} {{author}}\n"{{project}}"\n\n',
  },
  {
    id: 'WTFPL',
    name: 'WTFPL',
    kind: 'code',
    summary: {
      zh: '极度宽松的玩笑式许可：可以做任何事，不提供任何担保。',
      en: 'An extremely permissive, joke-style license: do whatever you want, with no warranty.',
    },
    markers: ['DO WHAT THE FUCK YOU WANT TO PUBLIC LICENSE'],
    header: 'Copyright (c) {{year}} {{author}}\n"{{project}}"\n\n',
  },
  {
    id: 'PolyForm-Noncommercial-1.0.0',
    name: 'PolyForm Noncommercial 1.0.0',
    kind: 'code',
    summary: {
      zh: '软件专用非商业许可：可用于个人、研究与非营利用途，商业使用需另行授权。',
      en: 'A software license for noncommercial use only: personal, research and nonprofit use, commercial use needs a separate license.',
    },
    markers: ['PolyForm Noncommercial License 1.0.0'],
    header: 'Copyright (c) {{year}} {{author}}\n"{{project}}"\n\n',
  },
  {
    id: 'CC0-1.0',
    name: 'CC0-1.0',
    kind: 'creativeCommons',
    summary: {
      zh: '放弃著作权，将作品投入公有领域；可商用、可修改、无需署名。',
      en: 'Dedicates the work to the public domain: commercial use, modification and no attribution required.',
    },
    markers: ['CC0 1.0 Universal'],
    header: '"{{project}}" © {{year}} {{author}} — dedicated to the public domain under CC0 1.0 Universal.\n\n',
  },
  {
    id: 'CC-BY-4.0',
    name: 'CC BY 4.0',
    kind: 'creativeCommons',
    summary: {
      zh: '可商用、可修改、可再发布，必须署名（作者与来源）并附许可链接。',
      en: 'Commercial use, modification and redistribution allowed with attribution and a link to the license.',
    },
    markers: ['Creative Commons Attribution 4.0 International'],
    header: attributionHeader('Creative Commons Attribution 4.0 International (CC BY 4.0)'),
  },
  {
    id: 'CC-BY-SA-4.0',
    name: 'CC BY-SA 4.0',
    kind: 'creativeCommons',
    summary: {
      zh: '可商用、可修改，必须署名，且衍生作品须以相同许可（SA）共享。',
      en: 'Commercial use and modification allowed with attribution; derivatives must use the same license (SA).',
    },
    markers: ['Creative Commons Attribution-ShareAlike 4.0 International'],
    header: attributionHeader('Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0)'),
  },
  {
    id: 'CC-BY-NC-4.0',
    name: 'CC BY-NC 4.0',
    kind: 'creativeCommons',
    summary: {
      zh: '可修改、可再发布，必须署名，但不得用于商业目的（NC）。',
      en: 'Modification and redistribution allowed with attribution, but no commercial use (NC).',
    },
    markers: ['Creative Commons Attribution-NonCommercial 4.0 International'],
    header: attributionHeader('Creative Commons Attribution-NonCommercial 4.0 International (CC BY-NC 4.0)'),
  },
  {
    id: 'CC-BY-NC-SA-4.0',
    name: 'CC BY-NC-SA 4.0',
    kind: 'creativeCommons',
    summary: {
      zh: '必须署名、不得商用（NC），且衍生作品须以相同许可共享（SA）。',
      en: 'Attribution required, no commercial use (NC), and derivatives must be shared under the same license (SA).',
    },
    markers: ['Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International'],
    header: attributionHeader(
      'Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International (CC BY-NC-SA 4.0)'
    ),
  },
  {
    id: 'CC-BY-ND-4.0',
    name: 'CC BY-ND 4.0',
    kind: 'creativeCommons',
    summary: {
      zh: '可商用、可再发布，必须署名，但不得发布修改后的作品（ND）。',
      en: 'Commercial use and redistribution allowed with attribution, but modified versions may not be shared (ND).',
    },
    markers: ['Creative Commons Attribution-NoDerivatives 4.0 International'],
    header: attributionHeader('Creative Commons Attribution-NoDerivatives 4.0 International (CC BY-ND 4.0)'),
  },
  {
    id: 'CC-BY-NC-ND-4.0',
    name: 'CC BY-NC-ND 4.0',
    kind: 'creativeCommons',
    summary: {
      zh: '限制最多：必须署名、不得商用（NC）、不得发布修改版（ND）。',
      en: 'Most restrictive: attribution required, no commercial use (NC), no derivative works (ND).',
    },
    markers: ['Creative Commons Attribution-NonCommercial-NoDerivatives 4.0 International'],
    header: attributionHeader(
      'Creative Commons Attribution-NonCommercial-NoDerivatives 4.0 International (CC BY-NC-ND 4.0)'
    ),
  },
]

/** 官方原文 / 条款页面（https 白名单域名；只跳转，不抓取） */
const OFFICIAL_URLS: Record<string, string> = {
  MIT: 'https://spdx.org/licenses/MIT.html',
  'Apache-2.0': 'https://www.apache.org/licenses/LICENSE-2.0',
  'GPL-2.0-only': 'https://www.gnu.org/licenses/old-licenses/gpl-2.0.html',
  'GPL-3.0-only': 'https://www.gnu.org/licenses/gpl-3.0.html',
  'LGPL-3.0-only': 'https://www.gnu.org/licenses/lgpl-3.0.html',
  'AGPL-3.0-only': 'https://www.gnu.org/licenses/agpl-3.0.html',
  'MPL-2.0': 'https://www.mozilla.org/en-US/MPL/2.0/',
  'BSD-2-Clause': 'https://opensource.org/licenses/BSD-2-Clause',
  'BSD-3-Clause': 'https://opensource.org/licenses/BSD-3-Clause',
  ISC: 'https://www.isc.org/licenses/',
  Unlicense: 'https://unlicense.org/',
  WTFPL: 'https://www.wtfpl.net/',
  'PolyForm-Noncommercial-1.0.0':
    'https://polyformproject.org/licenses/noncommercial/1.0.0',
  'CC0-1.0': 'https://creativecommons.org/publicdomain/zero/1.0/',
  'CC-BY-4.0': 'https://creativecommons.org/licenses/by/4.0/',
  'CC-BY-SA-4.0': 'https://creativecommons.org/licenses/by-sa/4.0/',
  'CC-BY-NC-4.0': 'https://creativecommons.org/licenses/by-nc/4.0/',
  'CC-BY-NC-SA-4.0': 'https://creativecommons.org/licenses/by-nc-sa/4.0/',
  'CC-BY-ND-4.0': 'https://creativecommons.org/licenses/by-nd/4.0/',
  'CC-BY-NC-ND-4.0': 'https://creativecommons.org/licenses/by-nc-nd/4.0/',
}

/** 从生成的离线数据取正文并做占位符化（代码替换版权行 / CC 前置署名行） */
const renderText = (definition: Definition): string => {
  const generated = LICENSE_TEMPLATES_DATA[definition.id]
  if (!generated) {
    throw new Error(`missing generated license template: ${definition.id}`)
  }
  return definition.kind === 'creativeCommons'
    ? renderCcLicense(generated.licenseText, definition.name)
    : renderCodeLicense(generated.licenseText)
}

export const LICENSE_TEMPLATES: readonly LicenseTemplate[] = DEFINITIONS.map((definition) => ({
  id: definition.id,
  name: definition.name,
  kind: definition.kind,
  summary: definition.summary,
  officialUrl: OFFICIAL_URLS[definition.id] ?? `https://spdx.org/licenses/${definition.id}.html`,
  markers: definition.markers,
  text: renderText(definition),
}))

/** 生成数据里的 SPDX 元信息（名称 / OSI 认证 / 下载来源），供页面展示与排查 */
export const licenseTemplateData = (id: string) => LICENSE_TEMPLATES_DATA[id]

export const LICENSE_TEMPLATE_IDS: readonly string[] = LICENSE_TEMPLATES.map(
  (template) => template.id
)

export const licenseTemplateById = (id: string): LicenseTemplate | undefined =>
  LICENSE_TEMPLATES.find((template) => template.id === id)

/**
 * 模板占位符：`{{name}}` 与 `{{author}}` 等价（都填署名 / 版权人），`{{year}}` 年份，
 * `{{project}}` 项目名。只替换认识的占位符，其它 `{{xxx}}` 原样保留。
 */
const FILL_PATTERN = /\{\{(year|author|name|project)\}\}/g

/** 用当前元信息填充模板占位符；未提供时分别回退当前年份 / 空串 / 空串 */
export const fillLicenseTemplate = (
  template: Pick<LicenseTemplate, 'text'>,
  fill: Partial<LicenseTemplateFill> = {}
): string => {
  const values: Record<string, string> = {
    year: String(fill.year ?? new Date().getFullYear()),
    author: fill.author?.trim() ?? '',
    name: fill.author?.trim() ?? '',
    project: fill.project?.trim() ?? '',
  }
  return template.text.replace(FILL_PATTERN, (_match, name: string) => values[name] ?? '')
}

/**
 * 从已有文本粗略识别许可模板（语言包详情展示摘要用）：
 * 只做包含匹配，识别不出来返回 undefined（自定义文本）。
 */
export const identifyLicenseTemplate = (text: string): LicenseTemplate | undefined => {
  const value = text.replace(/\s+/g, ' ')
  return LICENSE_TEMPLATES.find((template) =>
    template.markers.every((marker) => value.includes(marker.replace(/\s+/g, ' ')))
  )
}
