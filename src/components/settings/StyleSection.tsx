import clsx from 'clsx'
import { useRef, useState } from 'react'
import { useTranslate, type TranslationKey, type TranslationMessage } from '../../i18n/index.js'
import {
  activateStylePack,
  importStylePack,
  removeStylePack,
  useStylePackState,
} from '../../services/style/store.js'
import type { StylePackSummary } from '../../services/style/types.js'
import { StylePackError, type StylePackErrorCode } from '../../services/style/zip.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import settingsStyles from './Settings.module.css'
import styles from './StyleSection.module.css'

/** 样式分组的调色板图标：与设置弹窗里的 InfoIcon 一样用 16px 内联 SVG */
export const StyleIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
    <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.3" />
    <circle cx="5.4" cy="6.2" r="0.95" fill="currentColor" />
    <circle cx="8" cy="4.7" r="0.95" fill="currentColor" />
    <circle cx="10.6" cy="6.2" r="0.95" fill="currentColor" />
    <circle cx="10" cy="10.2" r="0.95" fill="currentColor" />
  </svg>
)

/** 每个导入错误码对应的文案 key；未知错误退回带原始 message 的通用文案。 */
const importErrorKeys: Record<StylePackErrorCode, TranslationKey> = {
  tooLarge: 'stylePackErrorTooLarge',
  tooManyFiles: 'stylePackErrorTooManyFiles',
  notZip: 'stylePackErrorNotZip',
  noIndex: 'stylePackErrorNoIndex',
  badIndex: 'stylePackErrorBadIndex',
  badConfig: 'stylePackErrorBadConfig',
  badPath: 'stylePackErrorBadPath',
  missingFile: 'stylePackErrorMissingFile',
  badFileType: 'stylePackErrorBadFileType',
}

/** 行内提示：`error` 为 true 时用错误色显示。 */
type Status = (TranslationMessage & { error?: boolean }) | null

const importErrorStatus = (error: unknown): Status =>
  error instanceof StylePackError
    ? { key: importErrorKeys[error.code], error: true }
    : {
        key: 'stylePackImportFailed',
        params: { message: error instanceof Error ? error.message : String(error) },
        error: true,
      }

/**
 * 样式设置分组：导入样式包 ZIP、查看已安装包并启用 / 删除。
 * 许可证全文由 store 的 active 提供，只对当前启用包展示。
 */
export const StyleSection = () => {
  const t = useTranslate()
  const { ready, packs, active, activeId, importing, error } = useStylePackState()
  const [importStatus, setImportStatus] = useState<Status>(null)
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<StylePackSummary | null>(null)
  const [deleting, setDeleting] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const activePack = activeId === null ? undefined : packs.find((pack) => pack.id === activeId)

  const onPick = async (file: File) => {
    setImportStatus(null)
    try {
      await importStylePack(file)
      showToast({ key: 'stylePackImported' })
    } catch (error) {
      setImportStatus(importErrorStatus(error))
    }
  }

  const activate = async (id: string) => {
    if (pendingId !== null) {
      return
    }
    setPendingId(id)
    try {
      await activateStylePack(id)
    } catch {
      showToast({ key: 'stylePackActivateFailed', type: 'error' })
    } finally {
      setPendingId(null)
    }
  }

  const confirmDelete = async () => {
    if (!deleteTarget || deleting) {
      return
    }
    setDeleting(true)
    try {
      await removeStylePack(deleteTarget.id)
      setDeleteTarget(null)
      showToast({ key: 'stylePackDeleted' })
    } catch {
      showToast({ key: 'stylePackDeleteFailed', type: 'error' })
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className={styles.section} aria-busy={importing}>
      <div className={styles.header}>
        <div className={styles.headerText}>
          <div className={styles.title}>{t('stylePackSectionTitle')}</div>
          <div className={styles.description}>{t('stylePackSectionDescription')}</div>
          <div className={styles.hint}>{t('stylePackImportHint')}</div>
        </div>
        <Button
          variant="outlined"
          size="m"
          className={styles.importButton}
          disabled={importing}
          onClick={() => fileRef.current?.click()}
        >
          {t(importing ? 'stylePackImporting' : 'stylePackImport')}
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept=".zip,application/zip"
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
      {importStatus ? (
        <div
          className={clsx(styles.status, importStatus.error && styles.statusError)}
          role={importStatus.error ? 'alert' : 'status'}
        >
          {t(importStatus.key, importStatus.params)}
        </div>
      ) : error ? (
        <div className={clsx(styles.status, styles.statusError)} role="alert">
          {Object.hasOwn(importErrorKeys, error)
            ? t(importErrorKeys[error as StylePackErrorCode])
            : t('stylePackFailed')}
        </div>
      ) : null}
      {!ready ? (
        <div className={styles.status} role="status">
          {t('stylePackLoading')}
        </div>
      ) : packs.length === 0 ? (
        <div className={styles.empty}>
          <div className={styles.emptyTitle}>{t('stylePackEmpty')}</div>
          <div className={styles.emptyHint}>{t('stylePackEmptyHint')}</div>
        </div>
      ) : (
        <ul className={settingsStyles.stylePackList}>
          {packs.map((pack) => {
            const isActive = pack.id === activeId
            const activating = pendingId === pack.id
            const meta = [
              pack.author ? `${t('stylePackAuthor')} ${pack.author}` : '',
              pack.version ? `${t('stylePackVersion')} ${pack.version}` : '',
            ]
              .filter(Boolean)
              .join(' · ')
            return (
              <li
                key={pack.id}
                className={clsx(
                  settingsStyles.stylePackCard,
                  isActive && settingsStyles.stylePackCardActive
                )}
              >
                <span className={settingsStyles.stylePackIcon}>
                  {pack.iconUrl ? (
                    <img className={settingsStyles.stylePackIconImage} src={pack.iconUrl} alt="" />
                  ) : (
                    <span className={settingsStyles.stylePackIconLetter} aria-hidden="true">
                      {pack.name.slice(0, 1)}
                    </span>
                  )}
                </span>
                <div className={settingsStyles.stylePackInfo}>
                  <div className={settingsStyles.stylePackName}>{pack.name}</div>
                  {meta ? <div className={settingsStyles.stylePackMeta}>{meta}</div> : null}
                  {pack.description ? (
                    <div className={settingsStyles.stylePackDescription}>{pack.description}</div>
                  ) : null}
                </div>
                <div className={settingsStyles.stylePackActions}>
                  {isActive ? (
                    <span className={settingsStyles.stylePackBadge}>{t('stylePackActive')}</span>
                  ) : (
                    <Button
                      variant="outlined"
                      size="m"
                      disabled={pendingId !== null || importing}
                      onClick={() => void activate(pack.id)}
                    >
                      {t(activating ? 'stylePackActivating' : 'stylePackActivate')}
                    </Button>
                  )}
                  <Button
                    variant="dangerOutlined"
                    size="m"
                    disabled={pendingId !== null || importing}
                    onClick={() => setDeleteTarget(pack)}
                  >
                    {t('stylePackDelete')}
                  </Button>
                </div>
              </li>
            )
          })}
        </ul>
      )}
      {active?.license ? (
        <details className={styles.license}>
          <summary className={styles.licenseSummary}>
            {t('stylePackLicenseSummary', {
              name: activePack?.name ?? active.manifest.name,
            })}
          </summary>
          <pre className={styles.licenseText}>{active.license}</pre>
        </details>
      ) : null}
      {deleteTarget ? (
        <Modal
          title={t('stylePackDeleteConfirmTitle')}
          className={settingsStyles.deleteConfirm}
          onClose={() => {
            if (!deleting) {
              setDeleteTarget(null)
            }
          }}
          footer={
            <div className={settingsStyles.deleteActions} aria-busy={deleting}>
              <Button
                variant="outlined"
                size="m"
                autoFocus
                disabled={deleting}
                onClick={() => setDeleteTarget(null)}
              >
                {t('cancel')}
              </Button>
              <Button
                variant="danger"
                size="m"
                disabled={deleting}
                onClick={() => void confirmDelete()}
              >
                {t(deleting ? 'stylePackDeleting' : 'stylePackDelete')}
              </Button>
            </div>
          }
        >
          <div>{t('stylePackDeleteConfirm')}</div>
          <div className={styles.deleteName}>{deleteTarget.name}</div>
        </Modal>
      ) : null}
    </div>
  )
}
