/**
 * LicenseEditor：完整许可文本编辑器 + 许可证选择向导 + 内置模板列表。
 *
 * 三条路径：
 * 1. 选择许可证向导：Q1 作品类型 → 商用 → 衍生 → ShareAlike → 专有改编 → 网络服务 → 放弃权利，
 *    逐步作答、可返回上一步，最后给出推荐许可证、判定依据、替换后全文预览；
 *    应用前必须填写署名（name）与 4 位年份（year），应用后仍可任意手动修改全文。
 * 2. 直接选模板：从内置模板列表选择（MIT / Apache / GPL / LGPL / AGPL / MPL / BSD / ISC /
 *    Unlicense / WTFPL / PolyForm / CC0 / CC BY 系列），按当前元信息填充占位符。
 * 3. 手动输入：下方多行文本框，保持原有用法；模板只是初始填充，不锁定内容。
 *
 * 模板文本来自 SPDX 许可全文，不联网；底部固定「仅为模板参考，不构成法律建议」。
 */
import { useId, useMemo, useState } from 'react'
import clsx from 'clsx'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { builtinLocaleOf } from '../../i18n/messages.js'
import { useSettings } from '../../services/settings.js'
import {
  fillLicenseTemplate,
  identifyLicenseTemplate,
  isAllowedLicenseUrl,
  LICENSE_TEMPLATES,
  type LicenseTemplate,
} from '../../services/license/templates.js'
import {
  applyLicenseTemplate,
  LicenseApplyError,
  licenseQuestionProgress,
  nextLicenseQuestion,
  recommendLicense,
  validateLicenseVariables,
  type LicenseAnswers,
  type LicenseQuestionId,
} from '../../services/license/decide.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import styles from './LicenseEditor.module.css'

type WizardScreen = 'closed' | 'wizard' | 'templates'

const currentYear = (): string => String(new Date().getFullYear())

const isBooleanQuestion = (
  id: LicenseQuestionId
): id is 'commercial' | 'derivatives' | 'shareAlike' | 'allowProprietaryDerivatives' | 'networkService' =>
  id !== 'workType' && id !== 'publicDomain'

/**
 * 官方原文链接：只做跳转（白名单 https），不在应用内联网抓取。
 * Android（Capacitor）走系统外部浏览器，其它端新窗口打开。
 */
const OfficialLicenseLink = ({ url }: { url: string }) => {
  const t = useTranslate()
  if (!isAllowedLicenseUrl(url)) {
    return null
  }
  return (
    <a
      className={styles.officialLink}
      href={url}
      target="_blank"
      rel="noreferrer noopener"
      onClick={(event) => {
        event.preventDefault()
        const android =
          typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent)
        window.open(url, android ? '_system' : '_blank', 'noopener,noreferrer')
      }}
    >
      {t('licenseTemplateOfficial')}
    </a>
  )
}

export const LicenseEditor = ({
  value,
  onChange,
  author,
  project,
  id,
  invalid = false,
  rows = 8,
  disabled = false,
}: {
  value: string
  onChange: (value: string) => void
  /** 当前包作者：Wizard 署名默认值，也用于直接选模板时的 {{author}} */
  author: string
  /** 当前包名称：填充模板 {{project}} */
  project: string
  id?: string
  invalid?: boolean
  rows?: number
  disabled?: boolean
}) => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  const summaryLang = builtinLocaleOf(locale) === 'en-US' ? 'en' : 'zh'
  const fallbackId = useId()
  const textareaId = id ?? fallbackId
  const [screen, setScreen] = useState<WizardScreen>('closed')
  const [answers, setAnswers] = useState<Partial<LicenseAnswers>>({})
  const [history, setHistory] = useState<LicenseQuestionId[]>([])
  const [variables, setVariables] = useState({ name: author, year: currentYear() })
  const [pending, setPending] = useState<{ template: LicenseTemplate; text: string } | null>(null)
  const current = identifyLicenseTemplate(value)

  const resetWizard = () => {
    setScreen('closed')
    setAnswers({})
    setHistory([])
  }

  const openWizard = () => {
    setAnswers({})
    setHistory([])
    setVariables({ name: author, year: currentYear() })
    setScreen('wizard')
  }

  /** 直接选模板：已有手动内容时先确认替换，避免误覆盖 */
  const pickTemplate = (template: LicenseTemplate) => {
    const text = fillLicenseTemplate(template, {
      year: variables.year.trim() || currentYear(),
      author: variables.name.trim() || author,
      project,
    })
    setScreen('closed')
    if (!value.trim() || value.trim() === text.trim()) {
      onChange(text)
      return
    }
    setPending({ template, text })
  }

  const question = screen === 'wizard' ? nextLicenseQuestion(answers) : null
  const answering = question !== null
  const recommendation = useMemo(
    () =>
      screen === 'wizard' && !answering
        ? recommendLicense({
            workType: answers.workType ?? 'code',
            commercial: answers.commercial ?? false,
            derivatives: answers.derivatives ?? false,
            shareAlike: answers.shareAlike,
            allowProprietaryDerivatives: answers.allowProprietaryDerivatives,
            networkService: answers.networkService,
            publicDomain: answers.publicDomain,
          })
        : null,
    [screen, answering, answers]
  )
  const recommended =
    recommendation === null
      ? undefined
      : LICENSE_TEMPLATES.find((template) => template.id === recommendation.licenseId)
  const variableError = validateLicenseVariables(variables)
  const preview =
    recommended === undefined
      ? ''
      : fillLicenseTemplate(recommended, {
          year: variables.year.trim() || currentYear(),
          author: variables.name.trim() || author,
          project,
        })

  const answer = (raw: string | boolean) => {
    if (question === null) {
      return
    }
    setAnswers((previous) => ({ ...previous, [question]: raw }))
    setHistory((previous) => [...previous, question])
  }

  const goBack = () => {
    const last = history.at(-1)
    if (last === undefined) {
      return
    }
    setHistory((previous) => previous.slice(0, -1))
    setAnswers(
      (previous) =>
        Object.fromEntries(
          Object.entries(previous).filter(([key]) => key !== last)
        ) as Partial<LicenseAnswers>
    )
  }

  const applyRecommendation = () => {
    if (recommended === undefined || variableError !== null) {
      return
    }
    try {
      onChange(applyLicenseTemplate(recommended, variables))
      resetWizard()
    } catch (error) {
      if (!(error instanceof LicenseApplyError)) {
        throw error
      }
      // 校验已在按钮禁用条件里拦下，这里只是兜底：保持向导打开，让用户修正
    }
  }

  return (
    <div className={styles.root}>
      <div className={styles.toolbar}>
        <Button
          variant="primary"
          size="s"
          disabled={disabled}
          aria-expanded={screen === 'wizard'}
          onClick={() => (screen === 'wizard' ? resetWizard() : openWizard())}
        >
          {t('licenseWizardOpen')}
        </Button>
        <Button
          variant="outlined"
          size="s"
          disabled={disabled}
          aria-expanded={screen === 'templates'}
          onClick={() => setScreen(screen === 'templates' ? 'closed' : 'templates')}
        >
          {t('licenseTemplateChoose')}
        </Button>
        {current ? (
          <span className={styles.current}>{current.name}</span>
        ) : (
          <span className={styles.currentMuted}>{t('licenseTemplateCustom')}</span>
        )}
        <span className={styles.hint}>{t('licenseTemplateFillHint')}</span>
      </div>

      {screen === 'templates' ? (
        <ul id={`${textareaId}-templates`} className={styles.list} role="listbox">
          {LICENSE_TEMPLATES.map((template) => (
            <li key={template.id} className={styles.optionRow}>
              <button
                type="button"
                role="option"
                aria-selected={current?.id === template.id}
                className={styles.option}
                onClick={() => pickTemplate(template)}
              >
                <span className={styles.optionHeader}>
                  <span className={styles.optionName}>{template.name}</span>
                  <span
                    className={clsx(
                      styles.optionKind,
                      template.kind === 'creativeCommons' && styles.optionKindCc
                    )}
                  >
                    {t(
                      template.kind === 'creativeCommons'
                        ? 'licenseTemplateKindCc'
                        : 'licenseTemplateKindCode'
                    )}
                  </span>
                </span>
                <span className={styles.optionSummary}>{template.summary[summaryLang]}</span>
              </button>
              <OfficialLicenseLink url={template.officialUrl} />
            </li>
          ))}
        </ul>
      ) : null}

      {screen === 'wizard' ? (
        <div className={styles.wizard} role="group" aria-label={t('licenseWizardTitle')}>
          {question !== null ? (
            <WizardQuestion
              question={question}
              answers={answers}
              step={licenseQuestionProgress(answers).step}
              total={licenseQuestionProgress(answers).total}
              canBack={history.length > 0}
              onAnswer={answer}
              onBack={goBack}
              onCancel={resetWizard}
            />
          ) : recommended !== undefined && recommendation !== null ? (
            <div className={styles.result}>
              <div className={styles.resultHeader}>
                <span className={styles.resultLabel}>{t('licenseWizardResult')}</span>
                <span className={styles.resultName}>{recommended.name}</span>
                <span
                  className={clsx(
                    styles.optionKind,
                    recommended.kind === 'creativeCommons' && styles.optionKindCc
                  )}
                >
                  {t(
                    recommended.kind === 'creativeCommons'
                      ? 'licenseTemplateKindCc'
                      : 'licenseTemplateKindCode'
                  )}
                </span>
              </div>
              <p className={styles.summary}>{recommended.summary[summaryLang]}</p>
              <OfficialLicenseLink url={recommended.officialUrl} />
              <div className={styles.rationaleTitle}>{t('licenseWizardRationale')}</div>
              <ul className={styles.rationale}>
                {recommendation.rationale.map((key) => (
                  <li key={key}>{t(key as TranslationKey)}</li>
                ))}
              </ul>

              <div className={styles.variables}>
                <label className={styles.variable}>
                  <span className={styles.variableLabel}>{t('licenseWizardName')}</span>
                  <input
                    className={clsx(
                      styles.input,
                      variableError === 'missingName' && styles.invalid
                    )}
                    value={variables.name}
                    placeholder={author || t('licenseWizardNamePlaceholder')}
                    onChange={(event) =>
                      setVariables((previous) => ({ ...previous, name: event.target.value }))
                    }
                  />
                </label>
                <label className={styles.variable}>
                  <span className={styles.variableLabel}>{t('licenseWizardYear')}</span>
                  <input
                    className={clsx(
                      styles.input,
                      (variableError === 'missingYear' || variableError === 'invalidYear') &&
                        styles.invalid
                    )}
                    inputMode="numeric"
                    value={variables.year}
                    onChange={(event) =>
                      setVariables((previous) => ({ ...previous, year: event.target.value }))
                    }
                  />
                </label>
              </div>
              {variableError !== null ? (
                <p className={styles.error} role="alert">
                  {t(
                    variableError === 'missingName'
                      ? 'licenseWizardNameRequired'
                      : variableError === 'missingYear'
                        ? 'licenseWizardYearRequired'
                        : 'licenseWizardYearInvalid'
                  )}
                </p>
              ) : null}

              <div className={styles.rationaleTitle}>{t('licenseWizardPreview')}</div>
              <pre className={styles.preview}>{preview}</pre>

              <div className={styles.wizardActions}>
                <Button variant="outlined" size="m" onClick={resetWizard}>
                  {t('cancel')}
                </Button>
                <Button variant="outlined" size="m" onClick={openWizard}>
                  {t('licenseWizardRestart')}
                </Button>
                <Button
                  variant="outlined"
                  size="m"
                  onClick={() => {
                    resetWizard()
                    pickTemplate(recommended)
                  }}
                >
                  {t('licenseWizardUseWithoutEdit')}
                </Button>
                <Button
                  size="m"
                  disabled={variableError !== null}
                  onClick={applyRecommendation}
                >
                  {t('licenseWizardApply')}
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {current ? <p className={styles.summary}>{current.summary[summaryLang]}</p> : null}

      <textarea
        id={textareaId}
        className={clsx(styles.textarea, invalid && styles.invalid)}
        rows={rows}
        value={value}
        disabled={disabled}
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
      />
      <p className={styles.disclaimer}>{t('licenseTemplateDisclaimer')}</p>

      {pending ? (
        <Modal
          title={t('licenseTemplateReplaceTitle')}
          onClose={() => setPending(null)}
          footer={
            <div className={styles.confirmActions}>
              <Button variant="outlined" size="m" autoFocus onClick={() => setPending(null)}>
                {t('cancel')}
              </Button>
              <Button
                variant="danger"
                size="m"
                onClick={() => {
                  onChange(pending.text)
                  setPending(null)
                }}
              >
                {t('licenseTemplateReplaceConfirm')}
              </Button>
            </div>
          }
        >
          {t('licenseTemplateReplaceBody', { name: pending.template.name })}
        </Modal>
      ) : null}
    </div>
  )
}

/** 单步问题：标题 + 选项按钮 + 上一步 / 取消 */
const WizardQuestion = ({
  question,
  answers,
  step,
  total,
  canBack,
  onAnswer,
  onBack,
  onCancel,
}: {
  question: LicenseQuestionId
  answers: Partial<LicenseAnswers>
  step: number
  total: number
  canBack: boolean
  onAnswer: (value: string | boolean) => void
  onBack: () => void
  onCancel: () => void
}) => {
  const t = useTranslate()
  const titleKey: TranslationKey =
    question === 'workType'
      ? 'licenseQWizardWorkType'
      : question === 'commercial'
        ? 'licenseQCommercial'
        : question === 'derivatives'
          ? 'licenseQDerivatives'
          : question === 'shareAlike'
            ? 'licenseQShareAlike'
            : question === 'allowProprietaryDerivatives'
              ? 'licenseQProprietary'
              : question === 'networkService'
                ? 'licenseQNetwork'
                : 'licenseQPublicDomain'
  const hintKey: TranslationKey =
    question === 'workType'
      ? 'licenseQWorkTypeHint'
      : question === 'commercial'
        ? 'licenseQCommercialHint'
        : question === 'derivatives'
          ? 'licenseQDerivativesHint'
          : question === 'shareAlike'
            ? 'licenseQShareAlikeHint'
            : question === 'allowProprietaryDerivatives'
              ? 'licenseQProprietaryHint'
              : question === 'networkService'
                ? 'licenseQNetworkHint'
                : 'licenseQPublicDomainHint'

  return (
    <>
      <div className={styles.wizardHeader}>
        <span className={styles.wizardProgress}>
          {t('licenseWizardProgress', { current: step, total })}
        </span>
        <div className={styles.wizardHeaderActions}>
          {canBack ? (
            <Button variant="outlined" size="s" onClick={onBack}>
              {t('licenseWizardBack')}
            </Button>
          ) : null}
          <Button variant="outlined" size="s" onClick={onCancel}>
            {t('cancel')}
          </Button>
        </div>
      </div>
      <div className={styles.questionTitle}>{t(titleKey)}</div>
      {/* 每步给出通俗依据，方便用户「快速了解」这个选择的后果 */}
      <p className={styles.questionHint}>{t(hintKey)}</p>
      <div className={styles.questionOptions}>
        {question === 'workType' ? (
          <>
            <Button variant="outlined" size="m" onClick={() => onAnswer('code')}>
              {t('licenseQWorkTypeCode')}
            </Button>
            <Button variant="outlined" size="m" onClick={() => onAnswer('creative')}>
              {t('licenseQWorkTypeCreative')}
            </Button>
          </>
        ) : question === 'publicDomain' ? (
          <>
            <Button variant="outlined" size="m" onClick={() => onAnswer('accept')}>
              {t('licenseQPublicDomainAccept')}
            </Button>
            <Button variant="outlined" size="m" onClick={() => onAnswer('reject')}>
              {t('licenseQPublicDomainReject')}
            </Button>
            <Button variant="outlined" size="m" onClick={() => onAnswer('dontCare')}>
              {t('licenseQPublicDomainDontCare')}
            </Button>
          </>
        ) : isBooleanQuestion(question) ? (
          <>
            <Button variant="outlined" size="m" onClick={() => onAnswer(true)}>
              {t('licenseWizardYes')}
            </Button>
            <Button variant="outlined" size="m" onClick={() => onAnswer(false)}>
              {t('licenseWizardNo')}
            </Button>
          </>
        ) : null}
      </div>
      {/* answers 仅用于让组件在回答变化时重渲染（父组件已按 answers 重算下一步） */}
      <span hidden>{JSON.stringify(answers)}</span>
    </>
  )
}
