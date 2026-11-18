import clsx from 'clsx'
import { useRef, useState, type CSSProperties, type ReactNode } from 'react'
import {
  IconDarkOutline16,
  IconDataOutline16,
  IconDownloadOutline16,
  IconFollowsystemOutline16,
  IconLightOutline16,
  IconSettingsOutline16,
  IconUploadOutline14,
} from '../base/icons.js'
import {
  BackupError,
  clearHistory,
  exportHistory,
  importHistory,
} from '../../services/chat/backup.js'
import { useIsMobile } from '../../app/viewport.js'
import { useChatStore } from '../../services/chat/store.js'
import { regionCodes, getRegionName, provinces } from '../../services/location.js'
import {
  isChineseBrowser,
  setLocale,
  setLocation,
  setThemePreference,
  setTtsVoice,
  useSettings,
  type ThemePreference,
} from '../../services/settings.js'
import { useTranslate, type TranslationKey, type TranslationMessage } from '../../i18n/index.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { PackIcon } from '../base/PackIcon.js'
import { Select } from '../base/Select.js'
import { STYLE_SLOTS } from '../../services/style/types.js'
import { showToast } from '../base/toastState.js'
import { ApiKeyConfirm, ApiKeyField, useApiKeyEditor } from './ApiKeyField.js'
import { closeSettings, useSettingsDialog, type SettingsSection } from './settingsDialogState.js'
import { PresetIcon, PresetSection } from './PresetSection.js'
import { StyleIcon, StyleSection } from './StyleSection.js'
import { UsageIcon, UsageSection } from './UsageSection.js'
import styles from './Settings.module.css'

/**
 * 设置弹窗：分「通用设置」（主题、语言、朗读音色、位置）、「数据管理」（API Key、导入、导出、删除）、
 * 「用量统计」（请求与 token 统计、最近请求、余额查询、清空统计）、「样式」（导入、启用、删除自定义样式包）、
 * 「Preset」（导入、手写 JSON 编辑、启用、删除 API 配置预设）与「关于」（非官方声明与上游许可）。
 * 桌面端为居中弹窗、左侧导航；移动端为底部弹层、导航横排在内容上方
 */
export const SettingsDialog = () => {
  const open = useSettingsDialog((state) => state.open)
  return open ? <SettingsContent /> : null
}

const sections: { value: SettingsSection; label: TranslationKey; icon: ReactNode }[] = [
  {
    value: 'general',
    label: 'settingDialogAsideGeneralOptionLabel',
    icon: (
      <PackIcon
        slot={STYLE_SLOTS.iconSettingSetting}
        size={16}
        fallback={<IconSettingsOutline16 />}
      />
    ),
  },
  {
    value: 'data',
    label: 'settingDialogAsideDataOptionLabel',
    icon: <PackIcon slot={STYLE_SLOTS.iconSettingDatas} size={16} fallback={<IconDataOutline16 />} />,
  },
  {
    value: 'usage',
    label: 'usageSectionTitle',
    icon: <PackIcon slot={STYLE_SLOTS.iconSettingUsage} size={16} fallback={<UsageIcon />} />,
  },
  {
    value: 'style',
    label: 'stylePackSectionTitle',
    icon: <PackIcon slot={STYLE_SLOTS.iconSettingStyle} size={16} fallback={<StyleIcon />} />,
  },
  {
    value: 'preset',
    label: 'presetSectionTitle',
    icon: <PackIcon slot={STYLE_SLOTS.iconSettingPreset} size={16} fallback={<PresetIcon />} />,
  },
  {
    value: 'about',
    label: 'aboutTitle',
    icon: <PackIcon slot={STYLE_SLOTS.iconSettingAbout} size={16} fallback={<InfoIcon />} />,
  },
]

/** 内容区按分组叠加背景图；样式页本身不需要背景图，只用基础内容类 */
/**
 * 把某个背景槽位的全部变量映射到整卡背景上；没有样式包时变量为空，等同于无背景。
 * 专属槽位缺失时回退到 setting.generic：旧样式包只提供了通用设置背景，
 * 新增的「样式 / 预设 / 用量统计」页也能跟着有背景，而不是白底。
 */
const settingBackground = (suffix: string, fallback = 'setting-generic'): CSSProperties =>
  ({
    '--dslike-setting-image': `var(--dslike-bg-${suffix}-image, var(--dslike-bg-${fallback}-image, none))`,
    '--dslike-setting-alpha': `var(--dslike-bg-${suffix}-alpha, var(--dslike-bg-${fallback}-alpha, 1))`,
    '--dslike-setting-brightness': `var(--dslike-bg-${suffix}-brightness, var(--dslike-bg-${fallback}-brightness, 1))`,
    '--dslike-setting-size': `var(--dslike-bg-${suffix}-size, var(--dslike-bg-${fallback}-size, cover))`,
    '--dslike-setting-position': `var(--dslike-bg-${suffix}-position, var(--dslike-bg-${fallback}-position, center))`,
    '--dslike-setting-repeat': `var(--dslike-bg-${suffix}-repeat, var(--dslike-bg-${fallback}-repeat, no-repeat))`,
    '--dslike-setting-rendering': `var(--dslike-bg-${suffix}-rendering, var(--dslike-bg-${fallback}-rendering, auto))`,
  }) as CSSProperties

const settingBackgrounds: Record<SettingsSection, CSSProperties> = {
  general: settingBackground('setting-generic'),
  data: settingBackground('setting-datas'),
  usage: settingBackground('setting-usage'),
  style: settingBackground('setting-style'),
  preset: settingBackground('setting-preset'),
  about: settingBackground('setting-about'),
}

const SettingsContent = () => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  // 打开时按调用方指定的分组选中，之后在弹窗内切换
  const [section, setSection] = useState(() => useSettingsDialog.getState().section)
  // 切换分组不丢失正在输入的 API Key 与导入状态
  const apiKeyEditor = useApiKeyEditor()
  const historyImport = useHistoryImport()
  const historyDelete = useHistoryDelete()
  const replacingHistory = useChatStore((state) => state.importingHistory)
  const historyBusy = historyImport.busy || historyDelete.busy || replacingHistory
  return (
    <>
      <Modal
        title={t('settings')}
        closable
        className={styles.dialog}
        mainClassName={styles.dialogMain}
        style={settingBackgrounds[section]}
        onClose={() => {
          if (!historyDelete.busy) {
            closeSettings()
          }
        }}
      >
        <div role="tablist" className={styles.navigation}>
          {sections.map((item) => (
            <button
              key={item.value}
              type="button"
              role="tab"
              aria-selected={section === item.value}
              className={clsx(styles.navItem, section === item.value && styles.navItemActive)}
              onClick={() => setSection(item.value)}
            >
              {item.icon}
              {t(item.label)}
            </button>
          ))}
        </div>
        <div role="tabpanel" className={styles.content}>
          {section === 'general' ? (
            <>
              <ThemeSetting />
              <LocaleSetting />
              <TtsVoiceSetting />
              <LocationSetting />
            </>
          ) : section === 'usage' ? (
            <UsageSection onOpenData={() => setSection('data')} />
          ) : section === 'style' ? (
            <StyleSection />
          ) : section === 'preset' ? (
            <PresetSection />
          ) : section === 'about' ? (
            <AboutSection />
          ) : (
            <>
              <ApiKeyField editor={apiKeyEditor} />
              <ImportHistory historyImport={historyImport} disabled={historyBusy} />
              <ExportHistory disabled={historyBusy} />
              <SettingCell
                label={t('deleteAllSessions')}
                status={null}
                action={
                  <Button
                    variant="dangerOutlined"
                    size="m"
                    className={styles.cellButton}
                    disabled={historyBusy}
                    onClick={historyDelete.open}
                  >
                    {t('delete')}
                  </Button>
                }
              />
              {isMobile ? <ApiKeyConfirm editor={apiKeyEditor} /> : null}
            </>
          )}
        </div>
      </Modal>
      {historyImport.file ? <ImportConfirm historyImport={historyImport} /> : null}
      {historyDelete.opened ? <DeleteAllConfirm historyDelete={historyDelete} /> : null}
    </>
  )
}

/** 删除确认保留在设置之上；失败可重试，成功只关闭确认弹窗。 */
const DeleteAllConfirm = ({
  historyDelete,
}: {
  historyDelete: ReturnType<typeof useHistoryDelete>
}) => {
  const t = useTranslate()
  return (
    <Modal
      title={t('deleteAllSessionsModalTitle')}
      className={styles.deleteConfirm}
      onClose={historyDelete.cancel}
      footer={
        <div className={styles.deleteActions} aria-busy={historyDelete.busy}>
          <Button
            variant="outlined"
            autoFocus
            disabled={historyDelete.busy}
            onClick={historyDelete.cancel}
          >
            {t('cancel')}
          </Button>
          <Button
            variant="danger"
            disabled={historyDelete.busy}
            onClick={() => void historyDelete.confirm()}
          >
            {t(historyDelete.busy ? 'historyDeleting' : 'deleteAllSessions')}
          </Button>
        </div>
      }
    >
      {t('deleteAllSessionsModalDescription')}
    </Modal>
  )
}

const useHistoryDelete = () => {
  const [opened, setOpened] = useState(false)
  const [busy, setBusy] = useState(false)
  const deleting = useRef(false)

  const confirm = async () => {
    if (deleting.current) {
      return
    }
    deleting.current = true
    setBusy(true)
    try {
      await clearHistory()
      setOpened(false)
      showToast({ key: 'historyDeleted' })
    } catch {
      showToast({ key: 'historyDeleteFailed', type: 'error' })
    } finally {
      deleting.current = false
      setBusy(false)
    }
  }

  return {
    opened,
    busy,
    open: () => setOpened(true),
    cancel: () => {
      if (!deleting.current) {
        setOpened(false)
      }
    },
    confirm,
  }
}

const LocationSetting = () => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  const location = useSettings((state) => state.location)
  const province =
    location?.region === 'CN'
      ? provinces.find((item) => item.code === location.province)
      : undefined

  return (
    <SettingCell
      label={t('settingsLocation')}
      status={null}
      className={styles.locationCell}
      action={
        <div className={styles.locationSelectors}>
          {isChineseBrowser() ? (
            <>
              <Select
                ariaLabel={t('settingsLocationProvince')}
                className={styles.provinceSelect}
                value={province?.code ?? ''}
                placeholder={t('settingsLocationProvince')}
                options={provinces.map((item) => ({ value: item.code, label: item.name }))}
                onChange={(value) => {
                  if (value !== province?.code) {
                    setLocation({ region: 'CN', province: value })
                  }
                }}
              />
              <Select
                ariaLabel={t('settingsLocationCity')}
                className={styles.citySelect}
                value={province ? (location?.city ?? '') : ''}
                disabled={!province?.cities.length}
                placeholder={t('settingsLocationCity')}
                options={
                  province?.cities.map((item) => ({ value: item.code, label: item.name })) ?? []
                }
                onChange={(value) => {
                  if (province) {
                    setLocation({ region: 'CN', province: province.code, city: value })
                  }
                }}
              />
            </>
          ) : (
            <Select
              ariaLabel={t('settingsLocationRegion')}
              className={styles.regionSelect}
              value={location?.region ?? ''}
              placeholder={t('settingsLocationRegion')}
              options={regionCodes
                .map((code) => ({ value: code, label: getRegionName(code, locale) }))
                .sort((a, b) => a.label.localeCompare(b.label, locale))}
              onChange={(value) => setLocation({ region: value })}
            />
          )}
        </div>
      }
    />
  )
}

const LocaleSetting = () => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  return (
    <SettingCell
      label={t('settingsLocalePreference')}
      status={null}
      action={
        <Select
          ariaLabel={t('settingsLocalePreference')}
          value={locale}
          options={[
            { value: 'zh-CN', label: t('settingsLocaleZhCN'), lang: 'zh-CN' },
            { value: 'en-US', label: t('settingsLocaleEnUS'), lang: 'en' },
          ]}
          onChange={setLocale}
        />
      }
    />
  )
}

/** 朗读音色：stella（海星，女声）/ tide（暗潮，男声） */
const TtsVoiceSetting = () => {
  const t = useTranslate()
  const ttsVoice = useSettings((state) => state.ttsVoice)
  return (
    <SettingCell
      label={t('settingsTtsVoice')}
      status={null}
      action={
        <Select
          ariaLabel={t('settingsTtsVoice')}
          value={ttsVoice}
          options={[
            { value: 'stella', label: t('settingsTtsVoiceStella') },
            { value: 'tide', label: t('settingsTtsVoiceTide') },
          ]}
          onChange={setTtsVoice}
        />
      }
    />
  )
}

/** 覆盖导入的二次确认，叠在设置弹窗上 */
const ImportConfirm = ({
  historyImport,
}: {
  historyImport: ReturnType<typeof useHistoryImport>
}) => {
  const t = useTranslate()
  return (
    <Modal
      title={t('historyImportConfirmTitle')}
      className={styles.importConfirm}
      onClose={historyImport.cancel}
      footer={
        <>
          <Button variant="outlined" size="m" autoFocus onClick={historyImport.cancel}>
            {t('cancel')}
          </Button>
          <Button variant="dangerOutlined" size="m" onClick={() => void historyImport.confirm()}>
            {t('historyImportConfirm')}
          </Button>
        </>
      }
    >
      <div className={styles.importConfirmText}>{t('historyImportConfirmDescription')}</div>
    </Modal>
  )
}

const themeOptions: { value: ThemePreference; label: TranslationKey; icon: ReactNode }[] = [
  {
    value: 'light',
    label: 'avatarMenuSettingsDialogThemeSelectLightOption',
    icon: <PackIcon slot={STYLE_SLOTS.iconSettingLight} size={16} fallback={<IconLightOutline16 />} />,
  },
  {
    value: 'dark',
    label: 'avatarMenuSettingsDialogThemeSelectDarkOption',
    icon: <PackIcon slot={STYLE_SLOTS.iconSettingDark} size={16} fallback={<IconDarkOutline16 />} />,
  },
  {
    value: 'system',
    label: 'avatarMenuSettingsDialogThemeSelectSystemOption',
    icon: (
      <PackIcon
        slot={STYLE_SLOTS.iconSettingDevice}
        size={16}
        fallback={<IconFollowsystemOutline16 />}
      />
    ),
  },
]

/**
 * 主题项：标题下方浅色 / 深色 / 跟随系统三个选块。
 * 与下方语言选项连续排列。
 */
const ThemeSetting = () => {
  const t = useTranslate()
  const themePreference = useSettings((state) => state.themePreference)
  const label = t('avatarMenuSettingsDialogThemeItemLabel')
  return (
    <div className={styles.theme}>
      {label}
      <div role="radiogroup" aria-label={label} className={styles.themeOptions}>
        {themeOptions.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={themePreference === option.value}
            className={clsx(
              styles.themeOption,
              themePreference === option.value && styles.themeOptionSelected
            )}
            onClick={() => setThemePreference(option.value)}
          >
            {option.icon}
            {t(option.label)}
          </button>
        ))}
      </div>
    </div>
  )
}

/** `reason` 为失败原因的文案 key，展示时按当前语言翻译后填入 `message` 参数。 */
type Status = (TranslationMessage & { error?: boolean; reason?: TranslationKey }) | null

/** 导出失败附带原因：预期的错误用对应文案作原因，其他错误用错误信息。 */
const errorStatus = (key: TranslationKey, error: unknown): Status => ({
  key,
  ...(error instanceof BackupError
    ? { reason: error.key }
    : { params: { message: error instanceof Error ? error.message : String(error) } }),
  error: true,
})

const SettingCell = ({
  label,
  description,
  status,
  action,
  className,
}: {
  label: string
  description?: string
  status: Status
  action: ReactNode
  className?: string
}) => {
  const t = useTranslate()
  return (
    <div className={clsx(styles.cell, styles.row, className)}>
      <div className={styles.text}>
        <div className={styles.label}>{label}</div>
        {status || description ? (
          <div className={clsx(styles.description, status?.error && styles.error)}>
            {status
              ? t(status.key, status.reason ? { message: t(status.reason) } : status.params)
              : description}
          </div>
        ) : null}
      </div>
      {action}
    </div>
  )
}

/** 选文件后先提示覆盖；确认后才检查文件并执行导入，任何错误都提示导入失败。 */
const useHistoryImport = () => {
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<Status>(null)
  const importing = useRef(false)

  const confirm = async () => {
    if (!file || importing.current) {
      return
    }
    importing.current = true
    setFile(null)
    setBusy(true)
    setStatus(null)
    try {
      const count = await importHistory(file)
      setStatus({ key: count === 1 ? 'historyImportedOne' : 'historyImported', params: { count } })
    } catch {
      setStatus({ key: 'historyImportFailed', error: true })
    } finally {
      importing.current = false
      setBusy(false)
    }
  }

  return { file, busy, status, select: setFile, cancel: () => setFile(null), confirm }
}

/** 导入 = 覆盖：用选中文件替换本地全部会话与附件。 */
const ImportHistory = ({
  historyImport,
  disabled,
}: {
  historyImport: ReturnType<typeof useHistoryImport>
  disabled: boolean
}) => {
  const t = useTranslate()
  const inputRef = useRef<HTMLInputElement>(null)

  return (
    <SettingCell
      label={t('historyImport')}
      description={t('historyImportDescription')}
      status={historyImport.status}
      action={
        <>
          <Button
            variant="outlined"
            size="m"
            className={clsx(styles.cellButton, styles.uploadButton)}
            disabled={disabled}
            onClick={() => inputRef.current?.click()}
          >
            <PackIcon
              slot={STYLE_SLOTS.iconUpload}
              size={14}
              fallback={<IconUploadOutline14 />}
            />
            {t('upload')}
          </Button>
          <input
            ref={inputRef}
            type="file"
            accept=".zip,application/zip,application/x-zip-compressed"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file) {
                historyImport.select(file)
              }
            }}
          />
        </>
      }
    />
  )
}

/** 将全部会话及图片导出为 ZIP 文件并下载 */
const ExportHistory = ({ disabled }: { disabled: boolean }) => {
  const t = useTranslate()
  const empty = useChatStore((state) => state.sessions.length === 0)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<Status>(null)

  const onExport = async () => {
    setBusy(true)
    setStatus(null)
    try {
      const { name, blob } = await exportHistory()
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = name
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
    } catch (error) {
      setStatus(errorStatus('historyExportFailed', error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingCell
      label={t('exportAllLabel')}
      description={t('historyExportDescription')}
      status={status}
      action={
        <Button
          variant="outlined"
          size="m"
          className={styles.cellButton}
          disabled={disabled || busy || empty}
          onClick={() => void onExport()}
        >
          <PackIcon
            slot={STYLE_SLOTS.iconDownload}
            size={14}
            fallback={<IconDownloadOutline16 />}
          />
          {t('exportAllDownload')}
        </Button>
      }
    />
  )
}

/** 关于页：非官方声明、上游链接与上游 MIT 许可全文 */
function InfoIcon() {
  return (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
    <circle cx="8" cy="8" r="6.4" fill="none" stroke="currentColor" strokeWidth="1.4" />
    <circle cx="8" cy="5" r="0.9" fill="currentColor" />
    <path d="M8 7.2v4.1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
  )
}

const UPSTREAM_URL = 'https://github.com/deepseek-ai/chat-demo'
const OFFICIAL_DEMO_URL = 'https://cdn.deepseek.com/chat-demo'
const OFFICIAL_DEMO_LABEL = 'cdn.deepseek.com/chat-demo'
const MAINTAINER_URL = 'https://github.com/qeggs-dev'
const MAINTAINER_LABEL = 'github.com/qeggs-dev'

const UPSTREAM_REPO_LABEL = 'github.com/deepseek-ai/chat-demo'

const UPSTREAM_LICENSE = `MIT License

Copyright (c) 2026 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.`

const appVersion = () =>
  document.querySelector('meta[name="application-version"]')?.getAttribute('content') ?? ''

const AboutSection = () => {
  const t = useTranslate()
  const version = appVersion()
  return (
    <div className={styles.about}>
      <div className={styles.aboutHeader}>
        <span className={styles.aboutName}>{t('appName')}</span>
        <span className={styles.aboutBadge}>{t('aboutBadge')}</span>
        {version ? (
          <span className={styles.aboutVersion}>
            {t('aboutVersionLabel')} {version}
          </span>
        ) : null}
      </div>
      <div className={styles.aboutBlock}>
        <div className={styles.aboutLabel}>{t('aboutDisclaimerTitle')}</div>
        <p className={styles.aboutText}>{t('aboutDisclaimer')}</p>
      </div>
      <div className={styles.aboutBlock}>
        <div className={styles.aboutLabel}>{t('aboutUpstreamLabel')}</div>
        <a className={styles.aboutLink} href={UPSTREAM_URL} target="_blank" rel="noreferrer noopener">
          {UPSTREAM_REPO_LABEL}
        </a>
      </div>
      <div className={styles.aboutBlock}>
        <div className={styles.aboutLabel}>{t('aboutOfficialDemoLabel')}</div>
        <a
          className={styles.aboutLink}
          href={OFFICIAL_DEMO_URL}
          target="_blank"
          rel="noreferrer noopener"
        >
          {OFFICIAL_DEMO_LABEL}
        </a>
        <p className={styles.aboutText}>{t('aboutOfficialDemoNote')}</p>
      </div>
      <div className={styles.aboutBlock}>
        <div className={styles.aboutLabel}>{t('aboutMaintainerLabel')}</div>
        <a className={styles.aboutLink} href={MAINTAINER_URL} target="_blank" rel="noreferrer noopener">
          {MAINTAINER_LABEL}
        </a>
        <p className={styles.aboutText}>{t('aboutMaintainerNote')}</p>
      </div>
      <div className={styles.aboutBlock}>
        <div className={styles.aboutLabel}>{t('aboutLicenseLabel')}</div>
        <pre className={styles.aboutLicense}>{UPSTREAM_LICENSE}</pre>
      </div>
      <div className={styles.aboutBlock}>
        <div className={styles.aboutLabel}>{t('aboutIconsLabel')}</div>
        <p className={styles.aboutText}>{t('aboutIconsText')}</p>
      </div>
      <div className={styles.aboutBlock}>
        <div className={styles.aboutLabel}>{t('aboutThirdPartyLabel')}</div>
        <p className={styles.aboutText}>{t('aboutThirdPartyText')}</p>
      </div>
    </div>
  )
}
