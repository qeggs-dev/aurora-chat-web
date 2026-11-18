import { useRef, useState } from 'react'
import clsx from 'clsx'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { setLocale, systemLocale, useSettings, type Locale } from '../../services/settings.js'
import { builtinLocaleOf, customLocalePreference } from '../../i18n/messages.js'
import { identifyLicenseTemplate } from '../../services/license/templates.js'
import {
  exportCurrentLocale,
  importLocalePack,
  removeLocalePack,
  useLocaleStore,
} from '../../services/locale/store.js'
import { LocalePackError, type LocalePackErrorCode } from '../../services/locale/pack.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { Select } from '../base/Select.js'
import { showToast } from '../base/toastState.js'
import settingsStyles from './Settings.module.css'
import styles from './LocaleSection.module.css'

/** 语言包错误码 → 文案 key；detail 作为 `{field}` 参数展示 */
const errorKeys: Record<LocalePackErrorCode, TranslationKey> = {
  tooLarge: 'localePackErrorTooLarge',
  badJson: 'localePackErrorBadJson',
  badSchema: 'localePackErrorBadSchema',
  badId: 'localePackErrorBadId',
  reservedId: 'localePackErrorReservedId',
  missingField: 'localePackErrorMissingField',
  badMessages: 'localePackErrorBadMessages',
}

const localeLabel = (
  locale: string,
  t: ReturnType<typeof useTranslate>
): string =>
  locale === 'zh-CN'
    ? t('settingsLocaleZhCN')
    : locale === 'en-US'
      ? t('settingsLocaleEnUS')
      : locale

/** 触发浏览器下载（对象 URL 只来自 Blob，10 秒后释放） */
const download = (filename: string, text: string): void => {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/**
 * 语言设置：内置语言 + 自定义语言选择、导入 / 导出语言文件、
 * 自定义语言包列表（名称 / 作者，可查看详情与删除）。
 *
 * 导出：当前语言（内置或自定义）→ 全部 key 的完整 JSON，文件名 `<id>-locale.json`；
 * 内置语言用内置元信息（id aurora-zh / aurora-en）与 MIT 文本，导出后可直接改文案再导入。
 */
export const LocaleSection = () => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  const packs = useLocaleStore((state) => state.packs)
  const ready = useLocaleStore((state) => state.ready)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const detail = detailId === null ? undefined : packs.find((pack) => pack.id === detailId)

  const options: { value: Locale; label: string; lang: string }[] = [
    { value: 'zh-CN', label: t('settingsLocaleZhCN'), lang: 'zh-CN' },
    { value: 'en-US', label: t('settingsLocaleEnUS'), lang: 'en' },
    ...packs.map((pack) => ({
      value: customLocalePreference(pack.id),
      label: pack.name,
      lang: pack.locale,
    })),
  ]

  const onPick = async (file: File) => {
    try {
      const result = await importLocalePack(file)
      showToast(
        result.skippedKeys > 0
          ? {
              key: 'settingsLocaleImportedSkipped',
              params: {
                name: result.pack.name,
                imported: result.importedKeys,
                skipped: result.skippedKeys,
                missing: result.missingKeys,
              },
            }
          : {
              key: 'settingsLocaleImported',
              params: { name: result.pack.name, imported: result.importedKeys },
            }
      )
    } catch (error) {
      if (error instanceof LocalePackError) {
        showToast({
          key: errorKeys[error.code],
          params: { field: error.detail ?? error.code },
          type: 'error',
        })
      } else {
        showToast({
          key: 'settingsLocaleImportFailed',
          params: { message: error instanceof Error ? error.message : String(error) },
          type: 'error',
        })
      }
    }
  }

  const onExport = () => {
    try {
      const { filename, json } = exportCurrentLocale()
      download(filename, json)
      showToast({ key: 'settingsLocaleExported', params: { name: filename } })
    } catch (error) {
      showToast({
        key: 'settingsLocaleExportFailed',
        params: { message: error instanceof Error ? error.message : String(error) },
        type: 'error',
      })
    }
  }

  const onDelete = async (id: string) => {
    if (deletingId !== null) {
      return
    }
    const target = packs.find((pack) => pack.id === id)
    if (!target) {
      return
    }
    setDeletingId(id)
    try {
      const { fallback } = await removeLocalePack(id)
      showToast(
        fallback
          ? {
              key: 'settingsLocaleDeletedFallback',
              params: { name: target.name, locale: localeLabel(systemLocale(), t) },
            }
          : { key: 'settingsLocaleDeleted', params: { name: target.name } }
      )
    } catch {
      showToast({ key: 'settingsLocaleDeleteFailed', type: 'error' })
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <div className={styles.group}>
      <div className={clsx(settingsStyles.cell, settingsStyles.row)}>
        <div className={settingsStyles.text}>
          <div className={settingsStyles.label}>{t('settingsLocalePreference')}</div>
          <div className={settingsStyles.description}>
            {t('settingsLocalePreferenceDescription')}
          </div>
        </div>
        <div className={styles.actions}>
          <Select
            ariaLabel={t('settingsLocalePreference')}
            value={locale}
            options={options}
            onChange={setLocale}
          />
          <Button
            variant="outlined"
            size="m"
            className={settingsStyles.cellButton}
            disabled={!ready}
            onClick={() => fileRef.current?.click()}
          >
            {t('settingsLocaleImport')}
          </Button>
          <Button variant="outlined" size="m" className={settingsStyles.cellButton} onClick={onExport}>
            {t('settingsLocaleExport')}
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file) {
                void onPick(file)
              }
            }}
          />
        </div>
      </div>

      {packs.length > 0 ? (
        <ul className={styles.packs}>
          {packs.map((pack) => {
            const active = locale === customLocalePreference(pack.id)
            const meta = [pack.author, pack.version].filter(Boolean).join(' · ')
            return (
              <li key={pack.id} className={styles.pack}>
                <div className={styles.packInfo}>
                  <span className={styles.packName} lang={pack.locale}>
                    {pack.name}
                  </span>
                  <span className={styles.packMeta}>{meta}</span>
                  {active ? (
                    <span className={styles.packBadge}>{t('settingsLocaleInUse')}</span>
                  ) : null}
                </div>
                <div className={styles.packActions}>
                  <Button
                    variant="outlined"
                    size="m"
                    className={settingsStyles.cellButton}
                    onClick={() => setDetailId(pack.id)}
                  >
                    {t('settingsLocaleDetails')}
                  </Button>
                  <Button
                    variant="dangerOutlined"
                    size="m"
                    className={settingsStyles.cellButton}
                    disabled={deletingId !== null}
                    onClick={() => void onDelete(pack.id)}
                  >
                    {t('settingsLocaleDelete')}
                  </Button>
                </div>
              </li>
            )
          })}
        </ul>
      ) : (
        <div className={styles.empty}>{t('settingsLocaleNoCustom')}</div>
      )}

      {detail ? (
        <LocaleDetail
          pack={detail}
          onClose={() => setDetailId(null)}
          onDelete={() => {
            setDetailId(null)
            void onDelete(detail.id)
          }}
        />
      ) : null}
    </div>
  )
}

/** 自定义语言包详情：完整元信息 + 可折叠的 LICENSE 全文 */
const LocaleDetail = ({
  pack,
  onClose,
  onDelete,
}: {
  pack: {
    id: string
    name: string
    description: string
    author: string
    version: string
    license: string
    locale: string
  }
  onClose: () => void
  onDelete: () => void
}) => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  const summaryLang = builtinLocaleOf(locale) === 'en-US' ? 'en' : 'zh'
  const template = identifyLicenseTemplate(pack.license)
  const rows: { label: TranslationKey; value: string }[] = [
    { label: 'settingsLocaleDetailName', value: pack.name },
    { label: 'settingsLocaleDetailId', value: pack.id },
    { label: 'settingsLocaleDetailLocale', value: pack.locale },
    { label: 'settingsLocaleDetailDescription', value: pack.description },
    { label: 'settingsLocaleDetailAuthor', value: pack.author },
    { label: 'settingsLocaleDetailVersion', value: pack.version },
  ]
  return (
    <Modal
      title={t('settingsLocaleDetailTitle')}
      className={settingsStyles.deleteConfirm}
      closable
      onClose={onClose}
      footer={
        <div className={settingsStyles.deleteActions}>
          <Button variant="dangerOutlined" size="m" onClick={onDelete}>
            {t('settingsLocaleDelete')}
          </Button>
          <Button size="m" onClick={onClose}>
            {t('confirm')}
          </Button>
        </div>
      }
    >
      <dl className={styles.detailRows}>
        {rows.map((row) => (
          <div key={row.label} className={styles.detailRow}>
            <dt className={styles.detailLabel}>{t(row.label)}</dt>
            <dd className={styles.detailValue}>{row.value || '—'}</dd>
          </div>
        ))}
      </dl>
      <details className={styles.licenseDetails}>
        <summary className={styles.licenseSummary}>{t('settingsLocaleDetailLicense')}</summary>
        {template ? (
          <p className={styles.licenseTemplate}>
            {t('settingsLocaleDetailLicenseTemplate', { name: template.name })}
            <br />
            {template.summary[summaryLang]}
          </p>
        ) : null}
        <pre className={styles.licenseText}>{pack.license}</pre>
      </details>
    </Modal>
  )
}
