// License templates + decision wizard (src/services/license/templates.ts & decide.ts):
// template catalogue completeness (summary / official URL whitelist), placeholder
// replacement, variable validation, and deterministic decision-tree mapping.
import assert from 'node:assert/strict'
import { test } from 'node:test'

const {
  fillLicenseTemplate,
  identifyLicenseTemplate,
  isAllowedLicenseUrl,
  LICENSE_LINK_HOSTS,
  LICENSE_TEMPLATES,
  licenseTemplateData,
} = await import('../.test-build/services/license/templates.js')
const { LICENSE_TEMPLATES_DATA } = await import(
  '../.test-build/services/license/templates.generated.js'
)
const {
  applyLicenseTemplate,
  LicenseApplyError,
  licenseQuestionProgress,
  nextLicenseQuestion,
  recommendLicense,
} = await import('../.test-build/services/license/decide.js')

const CODE_TEMPLATE_IDS = [
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
]
const CC_TEMPLATE_IDS = [
  'CC0-1.0',
  'CC-BY-4.0',
  'CC-BY-SA-4.0',
  'CC-BY-NC-4.0',
  'CC-BY-NC-SA-4.0',
  'CC-BY-ND-4.0',
  'CC-BY-NC-ND-4.0',
]

test('生成的 SPDX 数据：全部目标 ID、正文长度与关键特征串、来源 URL 合法', () => {
  const expected = [
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
  assert.deepEqual(Object.keys(LICENSE_TEMPLATES_DATA).sort(), [...expected].sort())
  for (const id of expected) {
    const entry = LICENSE_TEMPLATES_DATA[id]
    assert.equal(entry.name.length > 0, true, `${id} name`)
    assert.equal(entry.licenseText.length > 100, true, `${id} licenseText too short`)
    assert.match(entry.sourceUrl, /^https:\/\//, `${id} sourceUrl not https`)
    assert.equal(typeof entry.spdxTemplate, 'string', `${id} spdxTemplate`)
  }
  assert.match(LICENSE_TEMPLATES_DATA.MIT.licenseText, /Permission is hereby granted/)
  assert.match(
    LICENSE_TEMPLATES_DATA['GPL-3.0-only'].licenseText,
    /GNU GENERAL PUBLIC LICENSE/
  )
  assert.match(LICENSE_TEMPLATES_DATA['CC-BY-NC-4.0'].licenseText, /NonCommercial/)
  // 模板正文来自生成数据：代码许可版权行占位符化、CC 前置署名
  assert.match(licenseTemplateData('MIT').licenseText, /<year>/)
  const mit = LICENSE_TEMPLATES.find((template) => template.id === 'MIT')
  assert.match(mit.text, /Copyright \(c\) \{\{year\}\} \{\{name\}\}/)
  const cc = LICENSE_TEMPLATES.find((template) => template.id === 'CC-BY-NC-4.0')
  assert.match(cc.text, /^© \{\{year\}\} \{\{name\}\} — Licensed under CC BY-NC 4.0/)
  assert.match(cc.text, /NonCommercial/)
})

test('变量替换不破坏正文：正文条款原样保留', () => {
  const gpl = LICENSE_TEMPLATES.find((template) => template.id === 'GPL-3.0-only')
  const filled = fillLicenseTemplate(gpl, { year: 2026, author: 'Ada', project: 'Aurora' })
  assert.match(filled, /GNU GENERAL PUBLIC LICENSE/)
  assert.match(filled, /END OF TERMS AND CONDITIONS/)
  assert.match(filled, /2026/)
  assert.match(filled, /Ada/)
  // 除占位符替换外，正文条款原样保留（关键段落在填充后仍存在）
  for (const marker of [
    'GNU GENERAL PUBLIC LICENSE',
    'TERMS AND CONDITIONS',
    'END OF TERMS AND CONDITIONS',
  ]) {
    assert.equal(filled.includes(marker), gpl.text.includes(marker), `marker ${marker}`)
  }
  const mit = LICENSE_TEMPLATES.find((template) => template.id === 'MIT')
  const mitFilled = fillLicenseTemplate(mit, { year: 2026, author: 'Ada' })
  assert.match(mitFilled, /THE SOFTWARE IS PROVIDED "AS IS"/)
  assert.match(mitFilled, /Copyright \(c\) 2026 Ada/)
})

test('模板目录：id 唯一、文本非空、中英摘要非空、官方链接 https 且域名在白名单内', () => {
  assert.equal(new Set(LICENSE_TEMPLATES.map((item) => item.id)).size, LICENSE_TEMPLATES.length)
  for (const template of LICENSE_TEMPLATES) {
    assert.ok(template.text.length > 100, `${template.id} text too short`)
    assert.ok(template.summary.zh.trim().length > 0, `${template.id} missing zh summary`)
    assert.ok(template.summary.en.trim().length > 0, `${template.id} missing en summary`)
    assert.ok(template.officialUrl.startsWith('https://'), `${template.id} officialUrl not https`)
    assert.ok(isAllowedLicenseUrl(template.officialUrl), `${template.id} officialUrl not allowed`)
    const host = new URL(template.officialUrl).hostname
    assert.ok(LICENSE_LINK_HOSTS.includes(host), `${template.id} host ${host} not whitelisted`)
  }
  for (const id of CODE_TEMPLATE_IDS) {
    assert.ok(LICENSE_TEMPLATES.some((template) => template.id === id), `missing code template ${id}`)
  }
  for (const id of CC_TEMPLATE_IDS) {
    assert.ok(LICENSE_TEMPLATES.some((template) => template.id === id), `missing CC template ${id}`)
  }
  assert.equal(LICENSE_TEMPLATES.filter((item) => item.kind === 'code').length >= 12, true)
  assert.equal(LICENSE_TEMPLATES.filter((item) => item.kind === 'creativeCommons').length, 7)
})

test('isAllowedLicenseUrl：拒绝 http / 非白名单 / 非法 URL', () => {
  assert.equal(isAllowedLicenseUrl('https://spdx.org/licenses/MIT.html'), true)
  assert.equal(isAllowedLicenseUrl('https://creativecommons.org/licenses/by/4.0/'), true)
  assert.equal(isAllowedLicenseUrl('http://spdx.org/licenses/MIT.html'), false)
  assert.equal(isAllowedLicenseUrl('https://example.com/license'), false)
  assert.equal(isAllowedLicenseUrl('not a url'), false)
})

test('填充占位符：{{year}} / {{author}} / {{name}} / {{project}}，未知占位符原样保留', () => {
  const text = 'A {{year}} B {{author}} C {{name}} D {{project}} E {{unknown}}'
  assert.equal(
    fillLicenseTemplate({ text }, { year: 2026, author: 'Ada', project: 'Aurora' }),
    'A 2026 B Ada C Ada D Aurora E {{unknown}}'
  )
  // 不提供时年份回退当前年、作者 / 项目为空串
  assert.match(fillLicenseTemplate({ text }, {}), /\d{4}/)
  // 不破坏正文空白与结构
  const mit = LICENSE_TEMPLATES.find((template) => template.id === 'MIT')
  const filled = fillLicenseTemplate(mit, { year: 2026, author: 'Ada', project: 'Aurora' })
  assert.match(filled, /MIT License/)
  assert.match(filled, /2026/)
  assert.match(filled, /Ada/)
})

test('applyLicenseTemplate：name / year 缺失或年份非法拒绝，合法时替换且不改模板原文', () => {
  const template = LICENSE_TEMPLATES.find((item) => item.id === 'MIT')
  const before = template.text
  assert.throws(
    () => applyLicenseTemplate(template, { name: '  ', year: '2026' }),
    (error) => error instanceof LicenseApplyError && error.code === 'missingName'
  )
  assert.throws(
    () => applyLicenseTemplate(template, { name: 'Ada', year: '   ' }),
    (error) => error instanceof LicenseApplyError && error.code === 'missingYear'
  )
  assert.throws(
    () => applyLicenseTemplate(template, { name: 'Ada', year: '26' }),
    (error) => error instanceof LicenseApplyError && error.code === 'invalidYear'
  )
  assert.throws(
    () => applyLicenseTemplate(template, { name: 'Ada', year: 'abcd' }),
    (error) => error instanceof LicenseApplyError && error.code === 'invalidYear'
  )
  const text = applyLicenseTemplate(template, { name: ' Ada ', year: '2026', project: 'Aurora' })
  assert.match(text, /2026/)
  assert.match(text, /Ada/)
  assert.equal(text.includes('{{'), false)
  // 纯函数：模板原文没有被改写
  assert.equal(template.text, before)
  // 手动修改不被覆盖：改后的文本与模板常量无关
  assert.notEqual(`${text}\nEdited`, template.text)
})

test('identifyLicenseTemplate：能从填充后的文本识别模板', () => {
  const gpl = LICENSE_TEMPLATES.find((item) => item.id === 'GPL-3.0-only')
  const filled = fillLicenseTemplate(gpl, { year: 2026, author: 'Ada', project: 'Aurora' })
  assert.equal(identifyLicenseTemplate(filled)?.id, 'GPL-3.0-only')
  assert.equal(identifyLicenseTemplate('my own license text'), undefined)
  const mit = LICENSE_TEMPLATES.find((item) => item.id === 'MIT')
  assert.equal(
    identifyLicenseTemplate(fillLicenseTemplate(mit, { year: 2026, author: 'Ada' }))?.id,
    'MIT'
  )
})

test('决策树：所有问题组合都有确定 licenseId 与至少一条 rationale', () => {
  const values = {
    workType: ['code', 'creative'],
    commercial: [true, false],
    derivatives: [true, false],
    shareAlike: [true, false],
    allowProprietaryDerivatives: [true, false],
    publicDomain: ['accept', 'reject', 'dontCare'],
  }
  let combos = 0
  for (const workType of values.workType) {
    for (const commercial of values.commercial) {
      for (const derivatives of values.derivatives) {
        for (const shareAlike of values.shareAlike) {
          for (const allowProprietaryDerivatives of values.allowProprietaryDerivatives) {
            for (const publicDomain of values.publicDomain) {
              combos += 1
              const result = recommendLicense({
                workType,
                commercial,
                derivatives,
                shareAlike,
                allowProprietaryDerivatives,
                publicDomain,
              })
              assert.ok(result.licenseId, `missing licenseId for ${JSON.stringify({ workType, commercial, derivatives, shareAlike, allowProprietaryDerivatives, publicDomain })}`)
              assert.ok(result.rationale.length > 0, 'missing rationale')
              for (const key of result.rationale) {
                assert.equal(typeof key, 'string')
                assert.ok(key.length > 0)
              }
              assert.ok(
                LICENSE_TEMPLATES.some((template) => template.id === result.licenseId),
                `recommended license ${result.licenseId} has no template`
              )
            }
          }
        }
      }
    }
  }
  assert.equal(combos, 96)
})

test('决策树：关键分支映射（代码 / 创意 / CC0 / ShareAlike / ND / NC）', () => {
  const recommend = (overrides) =>
    recommendLicense({
      workType: 'code',
      commercial: true,
      derivatives: true,
      shareAlike: false,
      allowProprietaryDerivatives: true,
      publicDomain: 'reject',
      ...overrides,
    }).licenseId

  // 代码：允许商用 + 要求开源 → GPL-3.0；网络服务 → AGPL-3.0；允许闭源衍生 → MPL
  assert.equal(
    recommend({ shareAlike: true, allowProprietaryDerivatives: false }),
    'GPL-3.0-only'
  )
  assert.equal(
    recommend({ shareAlike: true, allowProprietaryDerivatives: false, networkService: true }),
    'AGPL-3.0-only'
  )
  assert.equal(recommend({ shareAlike: true, allowProprietaryDerivatives: true }), 'MPL-2.0')
  assert.equal(recommend({}), 'MIT')
  assert.equal(recommend({ publicDomain: 'accept' }), 'Unlicense')
  assert.equal(recommend({ commercial: false }), 'PolyForm-Noncommercial-1.0.0')

  // 创意：不允许商用 + 允许衍生 + 要求 ShareAlike → CC BY-NC-SA 4.0
  const creative = (overrides) =>
    recommendLicense({
      workType: 'creative',
      commercial: false,
      derivatives: true,
      shareAlike: true,
      allowProprietaryDerivatives: false,
      publicDomain: 'reject',
      ...overrides,
    }).licenseId
  assert.equal(creative({}), 'CC-BY-NC-SA-4.0')
  assert.equal(creative({ commercial: true }), 'CC-BY-SA-4.0')
  assert.equal(creative({ commercial: true, shareAlike: false, allowProprietaryDerivatives: true }), 'CC-BY-4.0')
  assert.equal(creative({ derivatives: false }), 'CC-BY-NC-ND-4.0')
  assert.equal(creative({ commercial: true, derivatives: false }), 'CC-BY-ND-4.0')
  assert.equal(creative({ shareAlike: false }), 'CC-BY-NC-4.0')
  assert.equal(creative({ publicDomain: 'accept' }), 'CC0-1.0')
  assert.equal(creative({ publicDomain: 'dontCare' }), 'CC-BY-NC-SA-4.0')
})

test('决策树问题顺序：逐步推进、允许返回上一步重答', () => {
  const answers = {}
  const sequence = []
  for (;;) {
    const question = nextLicenseQuestion(answers)
    if (question === null) {
      break
    }
    sequence.push(question)
    const value =
      question === 'workType'
        ? 'creative'
        : question === 'publicDomain'
          ? 'reject'
          : question === 'allowProprietaryDerivatives'
            ? true
            : true
    answers[question] = value
  }
  assert.deepEqual(sequence, [
    'workType',
    'commercial',
    'derivatives',
    'shareAlike',
    'allowProprietaryDerivatives',
    'publicDomain',
  ])
  // 路径进度：答满后 next 为 null
  assert.equal(nextLicenseQuestion(answers), null)
  assert.ok(licenseQuestionProgress(answers).total >= 1)
})
