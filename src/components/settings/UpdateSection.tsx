import { Button } from '../base/Button.js'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { formatBytes } from '../../services/update/assets.js'
import { updateErrorMessageKey } from '../../services/update/messages.js'
import { canAutoInstall, type InstallOutcome } from '../../services/update/platform.js'
import {
  shouldShowUpdateBadge,
  useUpdateStore,
  type UpdateErrorInfo,
} from '../../services/update/store.js'
import settingsStyles from './Settings.module.css'
import styles from './UpdateSection.module.css'

const formatPublishedAt = (value: string | null): string | null => {
  if (!value) {
    return null
  }
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString()
}

const installMessageKey = (install: InstallOutcome): TranslationKey => {
  switch (install.kind) {
    case 'installer-launched':
      return 'aboutUpdateInstallerLaunched'
    case 'appimage-ready':
      return 'aboutUpdateAppImageReady'
    case 'apk-installer-opened':
      return 'aboutUpdateApkInstallerOpened'
    case 'release-page':
      return 'aboutUpdateReleasePageOpened'
  }
}

/** 「设置 → 关于」里的检查更新区块：状态展示、下载进度、取消与安装提示 */
export const UpdateSection = () => {
  const t = useTranslate()
  const status = useUpdateStore((state) => state.status)
  const runtime = useUpdateStore((state) => state.runtime)
  const currentVersion = useUpdateStore((state) => state.currentVersion)
  const release = useUpdateStore((state) => state.release)
  const asset = useUpdateStore((state) => state.asset)
  const channel = useUpdateStore((state) => state.channel)
  const fromCache = useUpdateStore((state) => state.fromCache)
  const lastCheckedAt = useUpdateStore((state) => state.lastCheckedAt)
  const error = useUpdateStore((state) => state.error)
  const download = useUpdateStore((state) => state.download)
  const install = useUpdateStore((state) => state.install)
  const showBadge = useUpdateStore(shouldShowUpdateBadge)
  const check = useUpdateStore((state) => state.check)
  const downloadAndInstall = useUpdateStore((state) => state.downloadAndInstall)
  const cancelDownload = useUpdateStore((state) => state.cancelDownload)
  const openReleasePage = useUpdateStore((state) => state.openReleasePage)
  const dismissAvailable = useUpdateStore((state) => state.dismissAvailable)

  const checking = status === 'checking'
  const downloading = status === 'downloading'
  const checkError: UpdateErrorInfo | null = error && error.phase === 'check' ? error : null
  const transferError: UpdateErrorInfo | null = error && error.phase !== 'check' ? error : null
  const publishedAt = release ? formatPublishedAt(release.publishedAt) : null
  const percent = download?.percent ?? 0
  const received = formatBytes(download?.received ?? 0)
  const total = formatBytes(download?.total ?? asset?.size ?? 0)
  const canInstall = canAutoInstall(runtime) && asset !== null
  const showCard =
    release !== null &&
    status !== 'checking' &&
    (status === 'available' ||
      status === 'downloading' ||
      status === 'ready' ||
      (status === 'error' && transferError !== null))

  return (
    <div className={settingsStyles.aboutBlock}>
      <div className={styles.heading}>
        <span className={settingsStyles.aboutLabel}>{t('aboutUpdateTitle')}</span>
        {showBadge ? <span className={styles.badge} aria-hidden="true" /> : null}
      </div>
      <div className={styles.versionRow}>
        <span className={styles.version}>
          {t('aboutUpdateCurrentVersionLabel')} · {currentVersion || '—'}
        </span>
        {fromCache && lastCheckedAt ? (
          <span className={styles.hint}>
            {t('aboutUpdateCachedHint', { time: new Date(lastCheckedAt).toLocaleString() })}
          </span>
        ) : null}
        <Button
          variant="outlined"
          size="s"
          disabled={checking || downloading}
          onClick={() => void check({ manual: true })}
        >
          {checking ? t('aboutCheckingUpdate') : t('aboutCheckUpdate')}
        </Button>
      </div>
      {checking ? <p className={settingsStyles.aboutText}>{t('aboutCheckingUpdate')}</p> : null}
      {status === 'up-to-date' ? (
        <p className={settingsStyles.aboutText}>{t('aboutUpdateUpToDate')}</p>
      ) : null}
      {checkError ? (
        <div className={styles.errorRow} role="alert">
          <span className={styles.errorText}>
            {t('aboutUpdateFailed')}: {t(updateErrorMessageKey(checkError.code))}
          </span>
          <Button variant="outlined" size="s" onClick={() => void check({ manual: true })}>
            {t('aboutUpdateRetry')}
          </Button>
        </div>
      ) : null}
      {showCard && release ? (
        <div className={styles.card}>
          <div className={styles.cardTitle}>
            {t('aboutUpdateAvailableTitle', { version: release.version })}
          </div>
          {publishedAt ? (
            <div className={styles.meta}>{t('aboutUpdatePublishedAt', { date: publishedAt })}</div>
          ) : null}
          {channel ? (
            <div className={styles.meta}>
              {t('aboutUpdateChannelLabel')}: {channel}
            </div>
          ) : null}
          {release.notes ? (
            <>
              <div className={styles.notesLabel}>{t('aboutUpdateNotesTitle')}</div>
              <div className={styles.notes}>{release.notes}</div>
            </>
          ) : null}
          {canAutoInstall(runtime) ? (
            asset ? (
              <div className={styles.asset}>
                {t('aboutUpdateAssetLabel')}:{' '}
                {t('aboutUpdateAssetSummary', {
                  name: asset.name,
                  size: formatBytes(asset.size),
                })}
              </div>
            ) : (
              <div className={styles.warn}>{t('aboutUpdateNoAsset')}</div>
            )
          ) : (
            <div className={styles.meta}>{t('aboutUpdateWebHint')}</div>
          )}
          {downloading ? (
            <div className={styles.progress} role="status" aria-live="polite">
              <span className={styles.progressLabel}>
                {download && download.percent !== null
                  ? t('aboutUpdateDownloading', { percent, received, total })
                  : t('aboutUpdateDownloadUnknown', { received })}
              </span>
              <div
                className={styles.progressTrack}
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
              >
                <div className={styles.progressBar} style={{ width: `${percent}%` }} />
              </div>
              <Button variant="outlined" size="s" onClick={() => void cancelDownload()}>
                {t('aboutUpdateCancel')}
              </Button>
            </div>
          ) : null}
          {transferError && !downloading ? (
            <div className={styles.errorText} role="alert">
              {t(updateErrorMessageKey(transferError.code))}
            </div>
          ) : null}
          {install ? (
            <div className={styles.notice}>
              {t(installMessageKey(install), { path: install.path ?? '' })}
            </div>
          ) : null}
          <div className={styles.actions}>
            {canInstall ? (
              <Button
                variant="primary"
                size="m"
                disabled={downloading}
                onClick={() => void downloadAndInstall()}
              >
                {status === 'ready' || transferError
                  ? t('aboutUpdateRetryDownload')
                  : t('aboutUpdateDownloadAndInstall')}
              </Button>
            ) : (
              <Button variant="primary" size="m" disabled={downloading} onClick={openReleasePage}>
                {t('aboutUpdateOpenReleasePage')}
              </Button>
            )}
            {canInstall ? (
              <Button variant="outlined" size="m" onClick={openReleasePage}>
                {t('aboutUpdateOpenReleasePage')}
              </Button>
            ) : null}
            {status === 'available' ? (
              <button type="button" className={styles.dismiss} onClick={dismissAvailable}>
                {t('aboutUpdateDismiss')}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}
