import clsx from 'clsx'
import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
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
  setAutoCheckUpdates,
  setCompatibilityMode,
  setLocation,
  setThemePreference,
  setTtsVoice,
  useSettings,
  type ThemePreference,
} from '../../services/settings.js'
import { useTranslate, type TranslationKey, type TranslationMessage } from '../../i18n/index.js'
import { builtinLocaleOf } from '../../i18n/messages.js'
import { setAutoReadEnabled } from '../../services/speech/autoReadRuntime.js'
import { shouldShowUpdateBadge, useUpdateStore } from '../../services/update/store.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { PackIcon } from '../base/PackIcon.js'
import { Select } from '../base/Select.js'
import { STYLE_SLOTS } from '../../services/style/types.js'
import { showToast } from '../base/toastState.js'
import { ApiKeyConfirm, ApiKeyField, useApiKeyEditor } from './ApiKeyField.js'
import { closeSettings, useSettingsDialog, type SettingsSection } from './settingsDialogState.js'
import { LocaleSection } from './LocaleSection.js'
import {
  getDirtyPresetDraftsSnapshot,
  resetPresetDrafts,
  subscribePresetDrafts,
} from './presetDraftStore.js'
import { PresetIcon, PresetSection } from './PresetSection.js'
import { StyleIcon, StyleSection } from './StyleSection.js'
import { UsageIcon, UsageSection } from './UsageSection.js'
import { AboutSection } from './AboutSection.js'
import { usePrefersReducedMotion } from '../motion/usePrefersReducedMotion.js'
import { usePresence, type PresenceStage } from '../motion/usePresence.js'
import { useTimers } from '../motion/useTimers.js'
import { useTabHighlight } from '../motion/useTabHighlight.js'
import {
  dialogExpand,
  dialogExitMs,
  resolveMotionTokens,
  swipeDirection,
  type DialogExpand,
  type MotionTokens,
  type SwipeDirection,
} from '../motion/motionMath.js'
import styles from './Settings.module.css'

/**
 * 设置弹窗：分「通用设置」（主题、语言、兼容模式、朗读音色、位置）、「数据管理」（API Key、导入、导出、删除）、
 * 「用量统计」（请求与 token 统计、最近请求、余额查询、清空统计）、「样式」（导入、启用、删除自定义样式包）、
 * 「Preset」（导入、手写 JSON 编辑、启用、删除 API 配置预设）与「关于」（非官方声明与上游许可）。
 * 桌面端与移动端都是顶部标签栏；桌面端弹窗从触发按钮放大 / 缩回按钮，移动端从底部上滑进入 / 下滑退出。
 */
export const SettingsDialog = () => {
  const open = useSettingsDialog((state) => state.open)
  const reduced = usePrefersReducedMotion()
  const tokens = useMemo(() => resolveMotionTokens(reduced), [reduced])
  // 关闭时保持挂载到缩小动画播完，避免弹窗直接消失
  const { mounted, stage } = usePresence(open, dialogExitMs(tokens))
  if (!mounted) {
    return null
  }
  return <SettingsContent stage={stage} tokens={tokens} reduced={reduced} />
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

/** 标签栏顺序：切标签时按顺序判断内容区侧移方向（Index 越大越靠右） */
const sectionOrder = sections.map((item) => item.value)

const sectionIndexOf = (value: SettingsSection): number =>
  Math.max(0, sectionOrder.indexOf(value))

/** 内容区换页：先播旧内容侧移退出，再换内容播新内容侧移进入 */
type ContentMotion = { phase: 'out' | 'in'; direction: SwipeDirection }

const contentMotionClass = (motion: ContentMotion): string => {
  if (motion.phase === 'out') {
    return motion.direction === 'forward' ? styles.contentOutForward : styles.contentOutBackward
  }
  return motion.direction === 'forward' ? styles.contentInForward : styles.contentInBackward
}

const SettingsContent = ({
  stage,
  tokens,
  reduced,
}: {
  stage: PresenceStage
  tokens: MotionTokens
  reduced: boolean
}) => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  // 「关于」里有新版本时在顶部标签栏亮小红点
  const showAboutBadge = useUpdateStore(shouldShowUpdateBadge)
  // selected：标签栏立即响应（高亮滑过去）；rendered：内容区等旧内容侧移退完再换
  const [selected, setSelected] = useState(() => useSettingsDialog.getState().section)
  const [rendered, setRendered] = useState(() => useSettingsDialog.getState().section)
  const [contentMotion, setContentMotion] = useState<ContentMotion | null>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const navRef = useRef<HTMLDivElement>(null)
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([])
  // PC 端「从按钮放大」的起点：按钮中心相对弹窗的位置 + 两轴起始缩放
  const [expand, setExpand] = useState<DialogExpand | null>(null)
  const { schedule, clear } = useTimers()
  const navHighlight = useTabHighlight({
    navRef,
    activeIndex: sectionIndexOf(selected),
    revision: selected === rendered ? 0 : 1,
  })

  // 弹窗挂载后、首帧绘制前量出最终位置：拿触发按钮的 rect 计算 transform-origin 与起始缩放
  useLayoutEffect(() => {
    if (stage !== 'start' || isMobile || reduced) {
      return
    }
    const dialog = dialogRef.current
    if (!dialog) {
      return
    }
    // 起点 class 自带 scale，直接量会得到被缩小的矩形；先临时清掉 transform 拿真实布局矩形
    const previousTransform = dialog.style.transform
    dialog.style.transform = 'none'
    const rect = dialog.getBoundingClientRect()
    dialog.style.transform = previousTransform
    setExpand(
      dialogExpand(
        { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
        useSettingsDialog.getState().origin,
        tokens
      )
    )
  }, [stage, isMobile, reduced, tokens])

  // 预设草稿在「预设」分组外仍然保留；离开分组 / 关闭弹窗时若有未保存修改先确认
  const dirtyPresetDrafts = useSyncExternalStore(
    subscribePresetDrafts,
    getDirtyPresetDraftsSnapshot,
    getDirtyPresetDraftsSnapshot
  )
  const [discardPrompt, setDiscardPrompt] = useState<
    { kind: 'close' } | { kind: 'section'; section: SettingsSection } | null
  >(null)
  // 切换分组不丢失正在输入的 API Key 与导入状态
  const apiKeyEditor = useApiKeyEditor()
  const historyImport = useHistoryImport()
  const historyDelete = useHistoryDelete()
  const replacingHistory = useChatStore((state) => state.importingHistory)
  const historyBusy = historyImport.busy || historyDelete.busy || replacingHistory

  /** 真正关闭：丢弃预设草稿会话（未保存修改已确认或本来就没有） */
  const closeNow = () => {
    resetPresetDrafts()
    closeSettings()
  }

  const requestClose = () => {
    if (historyDelete.busy) {
      return
    }
    if (dirtyPresetDrafts) {
      setDiscardPrompt({ kind: 'close' })
      return
    }
    closeNow()
  }

  /**
   * 切分组：标签栏立即选中新项（高亮滑过去），内容区先侧移退出再换新内容侧移进入。
   * 快速重复切换时清掉上一次的定时器，取最新一次目标。
   */
  const switchSection = (next: SettingsSection) => {
    if (next === rendered) {
      setSelected(next)
      return
    }
    setSelected(next)
    if (reduced) {
      setRendered(next)
      return
    }
    const direction = swipeDirection(sectionIndexOf(rendered), sectionIndexOf(next))
    clear()
    setContentMotion({ phase: 'out', direction })
    schedule(() => {
      setRendered(next)
      setContentMotion({ phase: 'in', direction })
      schedule(() => setContentMotion(null), tokens.contentInMs + 40)
    }, tokens.contentOutMs)
  }

  const requestSection = (next: SettingsSection) => {
    if (next === selected) {
      return
    }
    // 离开「预设」分组时才需要确认；其它分组之间切换不受影响
    if (selected === 'preset' && dirtyPresetDrafts) {
      setDiscardPrompt({ kind: 'section', section: next })
      return
    }
    switchSection(next)
  }

  const confirmDiscard = () => {
    const prompt = discardPrompt
    if (!prompt) {
      return
    }
    setDiscardPrompt(null)
    resetPresetDrafts()
    if (prompt.kind === 'close') {
      closeSettings()
    } else {
      switchSection(prompt.section)
    }
  }

  /** 标签栏键盘左右切换（Home / End 跳到首尾），焦点跟随选中标签 */
  const onTablistKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = sectionIndexOf(selected)
    let next: number
    switch (event.key) {
      case 'ArrowRight':
        next = (current + 1) % sections.length
        break
      case 'ArrowLeft':
        next = (current - 1 + sections.length) % sections.length
        break
      case 'Home':
        next = 0
        break
      case 'End':
        next = sections.length - 1
        break
      default:
        return
    }
    const target = sections[next]
    if (!target) {
      return
    }
    event.preventDefault()
    requestSection(target.value)
    tabRefs.current[next]?.focus()
  }

  // 从按钮放大的变量只在 PC 端、非 reduced-motion 时写入；移动端走 translateY
  const expandStyle: CSSProperties =
    expand && !reduced && !isMobile
      ? ({
          '--motion-dialog-origin-x': `${expand.originX}px`,
          '--motion-dialog-origin-y': `${expand.originY}px`,
          '--motion-dialog-scale-x': String(expand.scaleX),
          '--motion-dialog-scale-y': String(expand.scaleY),
        } as CSSProperties)
      : {}

  return (
    <>
      <Modal
        title={t('settings')}
        closable
        className={clsx(
          styles.dialog,
          stage === 'start' && styles.dialogStart,
          stage === 'open' && styles.dialogOpen,
          stage === 'exit' && styles.dialogExit
        )}
        mainClassName={styles.dialogMain}
        contentRef={dialogRef}
        overlayClassName={clsx(
          stage === 'start' && styles.overlayEnter,
          stage === 'exit' && styles.overlayExit
        )}
        style={{ ...settingBackgrounds[rendered], ...expandStyle }}
        onClose={requestClose}
      >
        <div
          role="tablist"
          aria-label={t('settings')}
          className={styles.navigation}
          ref={navRef}
          onKeyDown={onTablistKeyDown}
        >
          {navHighlight ? (
            <div
              aria-hidden="true"
              data-motion-highlight="tabs"
              className={styles.navHighlight}
              style={{
                transform: navHighlight.transform,
                height: navHighlight.height,
                borderRadius: navHighlight.borderRadius,
              }}
            />
          ) : null}
          {sections.map((item, index) => {
            const active = selected === item.value
            return (
              <button
                key={item.value}
                ref={(element) => {
                  tabRefs.current[index] = element
                }}
                type="button"
                role="tab"
                id={`settings-tab-${item.value}`}
                aria-selected={active}
                aria-controls={`settings-panel-${item.value}`}
                tabIndex={active ? 0 : -1}
                className={clsx(styles.navItem, active && styles.navItemActive)}
                onClick={() => requestSection(item.value)}
              >
                {item.icon}
                {t(item.label)}
                {item.value === 'about' && showAboutBadge ? (
                  <span className={styles.navBadge} aria-hidden="true" />
                ) : null}
              </button>
            )
          })}
        </div>
        <div
          role="tabpanel"
          id={`settings-panel-${rendered}`}
          aria-labelledby={`settings-tab-${rendered}`}
          className={clsx(styles.content, contentMotion && contentMotionClass(contentMotion))}
          data-style-slot={
            rendered === 'data'
              ? STYLE_SLOTS.bgSettingDatas
              : rendered === 'about'
                ? STYLE_SLOTS.bgSettingAbout
                : STYLE_SLOTS.bgSettingGeneric
          }
        >
          {rendered === 'general' ? (
            <>
              <ThemeSetting />
              <LocaleSection />
              <CompatibilitySetting />
              <AutoCheckUpdatesSetting />
              <TtsVoiceSetting />
              <AutoReadAloudSetting />
              <LocationSetting />
            </>
          ) : rendered === 'usage' ? (
            <UsageSection onOpenData={() => requestSection('data')} />
          ) : rendered === 'style' ? (
            <StyleSection />
          ) : rendered === 'preset' ? (
            <PresetSection />
          ) : rendered === 'about' ? (
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
      {discardPrompt ? (
        <Modal
          title={t('presetUnsavedConfirmTitle')}
          className={styles.deleteConfirm}
          onClose={() => setDiscardPrompt(null)}
          footer={
            <div className={styles.deleteActions}>
              <Button variant="outlined" autoFocus onClick={() => setDiscardPrompt(null)}>
                {t('cancel')}
              </Button>
              <Button variant="danger" onClick={confirmDiscard}>
                {t(
                  discardPrompt.kind === 'close'
                    ? 'presetUnsavedDiscardAndClose'
                    : 'presetUnsavedDiscardAndSwitch'
                )}
              </Button>
            </div>
          }
        >
          {t('presetUnsavedConfirm')}
        </Modal>
      ) : null}
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
                .map((code) => ({ value: code, label: getRegionName(code, builtinLocaleOf(locale)) }))
                .sort((a, b) => a.label.localeCompare(b.label, locale))}
              onChange={(value) => setLocation({ region: value })}
            />
          )}
        </div>
      }
    />
  )
}

/** 开关：通用设置里与 Select 并列使用，样式与预设页的开关一致 */
const Switch = ({
  checked,
  label,
  onChange,
}: {
  checked: boolean
  label: string
  onChange: (checked: boolean) => void
}) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={label}
    className={clsx(styles.switch, checked && styles.switchOn)}
    onClick={() => onChange(!checked)}
  >
    <span className={styles.switchThumb} aria-hidden="true" />
  </button>
)

/**
 * 兼容模式：不发送 DeepSeek 私有扩展（safety_check / title / 服务端工具 / latest_reminder /
 * thinking.effort），标准采样参数不受影响。切换即时写入 localStorage。
 */
const CompatibilitySetting = () => {
  const t = useTranslate()
  const compatibilityMode = useSettings((state) => state.compatibilityMode)
  const label = t('settingsCompatibilityMode')
  return (
    <SettingCell
      label={label}
      description={t('settingsCompatibilityModeDescription')}
      status={null}
      action={<Switch checked={compatibilityMode} label={label} onChange={setCompatibilityMode} />}
    />
  )
}

/** 启动时自动检查更新：默认开启，只影响启动时的一次检查，结果缓存 24h */
const AutoCheckUpdatesSetting = () => {
  const t = useTranslate()
  const autoCheckUpdates = useSettings((state) => state.autoCheckUpdates)
  const label = t('settingsAutoCheckUpdates')
  return (
    <SettingCell
      label={label}
      description={t('settingsAutoCheckUpdatesDescription')}
      status={null}
      action={<Switch checked={autoCheckUpdates} label={label} onChange={setAutoCheckUpdates} />}
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

/** 自动朗读：与移动端顶栏喇叭按钮同步；打开时在点击手势里预热 AudioContext */
const AutoReadAloudSetting = () => {
  const t = useTranslate()
  const autoReadAloud = useSettings((state) => state.autoReadAloud)
  const label = t('settingsAutoReadAloud')
  return (
    <SettingCell
      label={label}
      description={t('settingsAutoReadAloudDescription')}
      status={null}
      action={<Switch checked={autoReadAloud} label={label} onChange={setAutoReadEnabled} />}
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

