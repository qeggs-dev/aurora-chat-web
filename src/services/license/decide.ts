/**
 * 许可证选择向导的决策树（纯函数，便于单测）。
 *
 * 输入用户对 Q1–Q6 的回答，输出确定性的推荐许可证 id 与判定依据；
 * 依据以 i18n key 数组返回（UI 用 t() 翻译，测试只断言非空）。
 *
 * 规则概要：
 * - 软件代码：
 *   - 接受放弃权利 → Unlicense
 *   - 不允许商用 → PolyForm Noncommercial 1.0.0
 *   - 要求衍生作品相同方式共享（copyleft）：
 *       * 允许衍生作品闭源 / 专有分发 → MPL-2.0（文件级 copyleft）
 *       * 否则：会作为网络服务提供 → AGPL-3.0；否则 GPL-3.0
 *   - 其余（宽松许可）→ MIT
 * - 创意作品：
 *   - 接受放弃权利 → CC0-1.0
 *   - 不允许商用：不允许衍生 → CC BY-NC-ND；要求相同方式共享 → CC BY-NC-SA；否则 CC BY-NC
 *   - 允许商用：不允许衍生 → CC BY-ND；要求相同方式共享（或不允许专有改编）→ CC BY-SA；否则 CC BY
 */
import { licenseTemplateById, type LicenseTemplate } from './templates.js'

export type LicenseWorkType = 'code' | 'creative'

export type LicenseAnswers = {
  workType: LicenseWorkType
  /** 是否允许商业使用 */
  commercial: boolean
  /** 是否允许修改 / 衍生 */
  derivatives: boolean
  /** 衍生作品是否必须以相同方式共享（copyleft / ShareAlike） */
  shareAlike?: boolean
  /** 是否允许改编作品闭源 / 专有分发 */
  allowProprietaryDerivatives?: boolean
  /** 是否作为网络服务提供（仅代码 + copyleft 时询问） */
  networkService?: boolean
  /** 是否接受放弃全部权利（CC0 / 公有领域） */
  publicDomain?: 'accept' | 'reject' | 'dontCare'
}

export type LicenseQuestionId =
  | 'workType'
  | 'commercial'
  | 'derivatives'
  | 'shareAlike'
  | 'allowProprietaryDerivatives'
  | 'networkService'
  | 'publicDomain'

/**
 * 下一道要问的题；全部答完返回 null。
 * 顺序：作品类型 → 商用 → 衍生 →（允许衍生时）相同方式共享 →（允许衍生时）专有改编
 * →（代码 + copyleft + 不允许专有改编时）网络服务 → 放弃全部权利。
 */
export const nextLicenseQuestion = (
  answers: Partial<LicenseAnswers>
): LicenseQuestionId | null => {
  if (answers.workType === undefined) {
    return 'workType'
  }
  if (answers.commercial === undefined) {
    return 'commercial'
  }
  if (answers.derivatives === undefined) {
    return 'derivatives'
  }
  if (answers.derivatives) {
    if (answers.shareAlike === undefined) {
      return 'shareAlike'
    }
    if (answers.allowProprietaryDerivatives === undefined) {
      return 'allowProprietaryDerivatives'
    }
    if (
      answers.workType === 'code' &&
      answers.commercial &&
      answers.shareAlike === true &&
      answers.allowProprietaryDerivatives === false &&
      answers.networkService === undefined
    ) {
      return 'networkService'
    }
  }
  if (answers.publicDomain === undefined) {
    return 'publicDomain'
  }
  return null
}

/** 已作答的题数 / 当前路径的总题数（UI 进度展示；总题数按当前回答动态变化） */
export const licenseQuestionProgress = (
  answers: Partial<LicenseAnswers>
): { step: number; total: number } => {
  const total = Math.max(1, countQuestions(answers))
  const answered = answeredCount(answers)
  const step = nextLicenseQuestion(answers) === null ? Math.min(answered, total) : Math.min(answered + 1, total)
  return { step: Math.max(1, step), total }
}

const answeredCount = (answers: Partial<LicenseAnswers>): number =>
  [
    answers.workType,
    answers.commercial,
    answers.derivatives,
    answers.shareAlike,
    answers.allowProprietaryDerivatives,
    answers.networkService,
    answers.publicDomain,
  ].filter((value) => value !== undefined).length

/** 按回答路径数当前路径上最多会问的题数（未回答的可选分支按最多算） */
const countQuestions = (answers: Partial<LicenseAnswers>): number => {
  let total = 4 // workType / commercial / derivatives / publicDomain
  if (answers.derivatives !== false) {
    total += 2 // shareAlike / allowProprietaryDerivatives（未定是否衍生时按最多算）
    if (answers.workType !== 'creative') {
      total += 1 // networkService
    }
  }
  return total
}

export type LicenseRecommendation = {
  licenseId: string
  /** 判定依据（i18n key，UI 逐条翻译显示） */
  rationale: string[]
}

/** 决策树映射：每个回答组合都有确定结果，rationale 至少一条 */
export const recommendLicense = (answers: LicenseAnswers): LicenseRecommendation => {
  const publicDomain = answers.publicDomain === 'accept'
  if (answers.workType === 'code') {
    if (publicDomain) {
      return { licenseId: 'Unlicense', rationale: ['licenseWhyUnlicense'] }
    }
    if (!answers.commercial) {
      return { licenseId: 'PolyForm-Noncommercial-1.0.0', rationale: ['licenseWhyNonCommercialCode'] }
    }
    if (!answers.derivatives) {
      return { licenseId: 'MIT', rationale: ['licenseWhyCodeNoDerivatives'] }
    }
    if (answers.shareAlike) {
      if (answers.allowProprietaryDerivatives) {
        return { licenseId: 'MPL-2.0', rationale: ['licenseWhyMpl'] }
      }
      if (answers.networkService) {
        return { licenseId: 'AGPL-3.0-only', rationale: ['licenseWhyAgpl'] }
      }
      return { licenseId: 'GPL-3.0-only', rationale: ['licenseWhyGpl'] }
    }
    return { licenseId: 'MIT', rationale: ['licenseWhyPermissive'] }
  }

  // 创意作品
  if (publicDomain) {
    return { licenseId: 'CC0-1.0', rationale: ['licenseWhyCc0'] }
  }
  if (!answers.commercial) {
    if (!answers.derivatives) {
      return { licenseId: 'CC-BY-NC-ND-4.0', rationale: ['licenseWhyCcByNcNd'] }
    }
    if (answers.shareAlike) {
      return { licenseId: 'CC-BY-NC-SA-4.0', rationale: ['licenseWhyCcByNcSa'] }
    }
    return { licenseId: 'CC-BY-NC-4.0', rationale: ['licenseWhyCcByNc'] }
  }
  if (!answers.derivatives) {
    return { licenseId: 'CC-BY-ND-4.0', rationale: ['licenseWhyCcByNd'] }
  }
  // 不允许专有改编等价于要求相同方式共享
  if (answers.shareAlike || answers.allowProprietaryDerivatives === false) {
    return { licenseId: 'CC-BY-SA-4.0', rationale: ['licenseWhyCcBySa'] }
  }
  return { licenseId: 'CC-BY-4.0', rationale: ['licenseWhyCcBy'] }
}

export type LicenseApplyErrorCode = 'missingName' | 'missingYear' | 'invalidYear'

export class LicenseApplyError extends Error {
  constructor(public code: LicenseApplyErrorCode) {
    super(code)
    this.name = 'LicenseApplyError'
  }
}

/** 应用模板时的变量：name / year 必填（trim 非空），year 必须是 4 位数字 */
export type LicenseVariables = {
  name: string
  year: string
  project?: string
}

/** 返回 null 表示可用；否则返回稳定错误码 */
export const validateLicenseVariables = (variables: LicenseVariables): LicenseApplyErrorCode | null => {
  if (!variables.name.trim()) {
    return 'missingName'
  }
  if (!variables.year.trim()) {
    return 'missingYear'
  }
  if (!/^\d{4}$/.test(variables.year.trim())) {
    return 'invalidYear'
  }
  return null
}

/**
 * 校验变量并生成完整许可文本：
 * `{{name}}` / `{{author}}` 填署名、`{{year}}` 填年份、`{{project}}` 填项目名；
 * 其它 `{{...}}` 占位符原样保留，正文其余内容不变。
 */
export const applyLicenseTemplate = (
  template: Pick<LicenseTemplate, 'text'>,
  variables: LicenseVariables
): string => {
  const error = validateLicenseVariables(variables)
  if (error !== null) {
    throw new LicenseApplyError(error)
  }
  return fillTemplate(template, variables)
}

const fillTemplate = (
  template: Pick<LicenseTemplate, 'text'>,
  variables: LicenseVariables
): string => {
  const values: Record<string, string> = {
    name: variables.name.trim(),
    author: variables.name.trim(),
    year: String(Number.parseInt(variables.year.trim(), 10)),
    project: variables.project?.trim() ?? '',
  }
  return template.text.replace(/\{\{(year|author|name|project)\}\}/g, (_match, key: string) =>
    Object.hasOwn(values, key) ? values[key] : _match
  )
}

/** 推荐结果对应的模板（理论上一定存在；找不到时 UI 回退列表） */
export const recommendationTemplate = (
  recommendation: LicenseRecommendation
): LicenseTemplate | undefined => licenseTemplateById(recommendation.licenseId)
