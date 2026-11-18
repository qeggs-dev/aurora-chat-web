import clsx from 'clsx'
import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { IconPanelLeftOutline16, IconSettingsOutline16, NewChatIcon } from '../base/icons.js'
import { PackIcon } from '../base/PackIcon.js'
import { STYLE_SLOTS } from '../../services/style/types.js'
import { STYLE_EDIT_SIDEBAR_TITLE } from '../style-editor/targets.js'
import { useStyleSidebarTitle } from '../../services/style/store.js'
import { setSiderCollapsed } from '../../services/settings.js'
import { shouldShowUpdateBadge, useUpdateStore } from '../../services/update/store.js'
import { groupSessions } from '../../services/chat/sessionGroups.js'
import { newChat, removeSession, useChatStore } from '../../services/chat/store.js'
import type { SessionSummary } from '../../services/chat/types.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import { openSettings } from '../settings/settingsDialogState.js'
import { closeMobileSider, useMobileSider, type MobileSiderCloseReason } from './mobileSiderState.js'
import { SessionItem } from './SessionItem.js'
import { usePrefersReducedMotion } from '../motion/usePrefersReducedMotion.js'
import { useDelayedFlag, usePresence, type PresenceStage } from '../motion/usePresence.js'
import { useStaggeredList, type StaggerPhase } from '../motion/useStaggeredList.js'
import { useListHighlight } from '../motion/useListHighlight.js'
import { useTimers } from '../motion/useTimers.js'
import {
  listEnterMs,
  listExitMs,
  oneThirdDelay,
  resolveMotionTokens,
  siderExitMs,
} from '../motion/motionMath.js'
import styles from './Sider.module.css'

/**
 * 侧边栏退出编排：
 * - list：先列表逐项退出（bottom→top），再整体从右到左滑出（收起侧边栏 / 开启新对话）；
 * - selection：高亮滑到新项、走到 1/3 时整体退出，不播逐项退出；
 * - plain：点遮罩等普通关闭，只整体滑出。
 */
export type SiderExitMode = 'list' | 'selection' | 'plain'

const exitModeOf = (reason: MobileSiderCloseReason): SiderExitMode => {
  switch (reason) {
    case 'collapse':
    case 'newChat':
      return 'list'
    case 'selection':
      return 'selection'
    default:
      return 'plain'
  }
}

/** 展开的侧边栏：名称与收起按钮、开启新对话、按时间分组的会话列表、底部设置；移动端放在抽屉里，收起按钮关闭抽屉 */
export const Sider = ({
  mobile = false,
  stage = 'open',
  exitMode = 'list',
}: {
  mobile?: boolean
  /** 进出场阶段（桌面端由 App 的挂载保持提供；移动端由抽屉透传） */
  stage?: PresenceStage
  /** 退出编排：只在「收起 / 开启新对话 / 选中会话」时区分 */
  exitMode?: SiderExitMode
}) => {
  const t = useTranslate()
  const styleTitle = useStyleSidebarTitle()
  const sessions = useChatStore((state) => state.sessions)
  const activeId = useChatStore((state) => state.activeId)
  const [now, setNow] = useState(Date.now)
  const groups = useMemo(() => groupSessions(sessions, now, t), [sessions, now, t])
  const [deleting, setDeleting] = useState<SessionSummary | null>(null)
  const [deletePending, setDeletePending] = useState(false)
  // 有新版本时在设置入口亮小红点（用户点「稍后」后不再显示）
  const showUpdateBadge = useUpdateStore(shouldShowUpdateBadge)

  // 动效：列表逐项 stagger、选中高亮、整体滑入滑出
  const reduced = usePrefersReducedMotion()
  const tokens = useMemo(() => resolveMotionTokens(reduced), [reduced])
  const listRef = useRef<HTMLDivElement>(null)
  const [listPhase, setListPhase] = useState<StaggerPhase>('enter')
  const [listRun, setListRun] = useState(0)
  const { schedule, clear } = useTimers()
  const exiting = stage === 'exit'
  const staggerItems = useStaggeredList({
    containerRef: listRef,
    phase: listPhase,
    run: listRun,
    reduced,
  })
  const highlight = useListHighlight({
    containerRef: listRef,
    activeId,
    revision: sessions.length,
    enabled: true,
  })

  // 进入动画播完后摘掉 class，下一次进入才能重新触发 keyframes
  useEffect(() => {
    if (listPhase !== 'enter') {
      return
    }
    const timer = setTimeout(() => setListPhase('idle'), listEnterMs(tokens))
    return () => clearTimeout(timer)
  }, [listPhase, listRun, tokens])

  // 退出时：list 模式逐项退出；其余模式不播逐项退出（selected 由高亮编排接管）
  const wasExiting = useRef(exiting)
  useEffect(() => {
    if (exiting) {
      if (exitMode === 'list') {
        setListPhase('exit')
        setListRun((run) => run + 1)
      } else {
        setListPhase('idle')
      }
    } else if (wasExiting.current) {
      // 退出途中被重新打开：列表重新逐项进入
      setListPhase((phase) => (phase === 'exit' ? 'enter' : phase))
      setListRun((run) => run + 1)
    }
    wasExiting.current = exiting
  }, [exiting, exitMode])

  // 桌面端整体滑动：list 模式等逐项退出播一会再滑出；移动端由抽屉自己滑
  const slideDelay = !mobile && exitMode === 'list' ? tokens.panelExitDelayMs : 0
  const delayedExit = useDelayedFlag(exiting && slideDelay > 0, slideDelay)
  const sliding = !mobile && exiting && (slideDelay === 0 || delayedExit)

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const refresh = () => {
      clearTimeout(timer)
      const time = Date.now()
      setNow(time)
      const midnight = new Date(time).setHours(24, 0, 0, 0)
      timer = setTimeout(refresh, midnight - time)
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        refresh()
      }
    }
    refresh()
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('focus', refresh)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('focus', refresh)
    }
  }, [])

  /** 收起侧边栏：移动端关抽屉（逐项退出），桌面端交给 App 的挂载保持播退出动画 */
  const collapseSider = () => {
    if (mobile) {
      closeMobileSider('collapse')
    } else {
      setSiderCollapsed(true)
    }
  }

  /** 开启新对话：列表逐项退出后再逐项进入（移动端直接关抽屉，桌面端侧边栏保留） */
  const startNewChat = () => {
    newChat()
    if (mobile) {
      closeMobileSider('newChat')
      return
    }
    clear()
    setListPhase('exit')
    setListRun((run) => run + 1)
    schedule(() => {
      setListPhase('enter')
      setListRun((run) => run + 1)
    }, listExitMs(tokens))
  }

  /**
   * 选中会话：移动端移动高亮 → 1/3 时抽屉整体退出（不播逐项退出）。
   * 桌面端交互不变（只切会话，不收起侧边栏），高亮由 activeId 变化驱动滑动。
   */
  const selectFromList = (sessionId: string) => {
    if (!mobile) {
      return
    }
    closeMobileSider(sessionId === activeId ? 'plain' : 'selection')
  }

  /** 设置入口：记下按钮矩形，PC 端弹窗从按钮放大、关闭时缩回按钮 */
  const openSettingsFrom = (event: MouseEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    openSettings('general', {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    })
  }

  return (
    <div
      className={clsx(
        styles.sider,
        mobile && styles.mobile,
        !mobile && stage === 'start' && styles.siderStart,
        sliding && styles.siderExit
      )}
      data-style-slot={STYLE_SLOTS.bgSidebar}
    >
      <div className={styles.top}>
        <div className={styles.appName} data-style-slot={STYLE_EDIT_SIDEBAR_TITLE}>
          {styleTitle ?? t('appName')}
        </div>
        <IconButton
          size="m"
          icon={
            <PackIcon
              slot={STYLE_SLOTS.iconExitSidebar}
              size={16}
              fallback={<IconPanelLeftOutline16 />}
            />
          }
          tooltip={t('collapseSiderbarButton')}
          tooltipPlacement="bottom"
          onClick={collapseSider}
        />
      </div>
      <button
        type="button"
        className={styles.newChat}
        data-style-slot={STYLE_SLOTS.bgNewSession}
        onClick={startNewChat}
      >
        <span className={styles.newChatIcon}>
          <PackIcon slot={STYLE_SLOTS.iconNewSession} size={16} fallback={<NewChatIcon />} />
        </span>
        <span>{t('newChat')}</span>
      </button>
      <div className={styles.listWrap}>
        <div className={styles.list} ref={listRef}>
          {highlight ? (
            <div
              aria-hidden="true"
              data-motion-highlight="session"
              className={clsx(
                styles.listHighlight,
                listPhase === 'exit' && styles.listHighlightExit
              )}
              style={{
                transform: `translate(${highlight.x}px, ${highlight.y}px)`,
                width: highlight.width,
                height: highlight.height,
              }}
            />
          ) : null}
          {groups.map((group) => (
            <div key={group.key} className={styles.section}>
              <div className={styles.sectionHeader}>{group.label}</div>
              {group.sessions.map((session) => (
                <SessionItem
                  key={session.id}
                  session={session}
                  active={session.id === activeId}
                  motion={staggerItems.get(session.id)}
                  onDelete={() => setDeleting(session)}
                  onSelect={() => selectFromList(session.id)}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
      <div className={styles.bottom}>
        <button type="button" className={styles.settings} onClick={openSettingsFrom}>
          <span className={styles.settingsIcon}>
            <PackIcon
              slot={STYLE_SLOTS.iconSettingSetting}
              size={16}
              fallback={<IconSettingsOutline16 />}
            />
          </span>
          <span className={styles.settingsLabel}>{t('settings')}</span>
          {showUpdateBadge ? <span className={styles.updateDot} aria-hidden="true" /> : null}
        </button>
      </div>
      {deleting ? (
        <Modal
          title={t('deleteSessionModalContentTitle')}
          onClose={() => {
            if (!deletePending) {
              setDeleting(null)
            }
          }}
          footer={
            <>
              <Button variant="outlined" disabled={deletePending} onClick={() => setDeleting(null)}>
                {t('cancel')}
              </Button>
              <Button
                variant="danger"
                disabled={deletePending}
                onClick={async () => {
                  setDeletePending(true)
                  try {
                    if (await removeSession(deleting.id)) {
                      setDeleting(null)
                    } else {
                      showToast({ key: 'sessionDeleteFailed', type: 'error' })
                    }
                  } finally {
                    setDeletePending(false)
                  }
                }}
              >
                {t('delete')}
              </Button>
            </>
          }
        >
          {t('deleteSessionWithFilesDescription')}
        </Modal>
      ) : null}
    </div>
  )
}

/** 移动端抽屉：浮在页面上方，点空白区域关闭；关闭时整体从右到左滑出 */
export const MobileSider = () => {
  const open = useMobileSider((state) => state.open)
  const reason = useMobileSider((state) => state.closeReason)
  const reduced = usePrefersReducedMotion()
  const tokens = useMemo(() => resolveMotionTokens(reduced), [reduced])
  const exitMode = exitModeOf(reason)
  const { mounted, stage } = usePresence(open, siderExitMs(exitMode, tokens))
  // 列表逐项退出播一会再整体滑出；选中会话时等高亮走到 1/3；普通关闭立即滑出
  const slideDelay =
    exitMode === 'list'
      ? tokens.panelExitDelayMs
      : exitMode === 'selection'
        ? oneThirdDelay(tokens.highlightMs)
        : 0
  const delayedExit = useDelayedFlag(stage === 'exit' && slideDelay > 0, slideDelay)

  if (!mounted) {
    return null
  }
  const exiting = stage === 'exit'
  const sliding = exiting && (slideDelay === 0 || delayedExit)

  return (
    <>
      <div
        className={clsx(styles.drawerMask, exiting && styles.drawerMaskExit)}
        onClick={() => closeMobileSider('plain')}
      />
      <div
        data-motion-drawer=""
        className={clsx(
          styles.drawer,
          stage === 'start' && styles.drawerStart,
          sliding && styles.drawerExit
        )}
      >
        <Sider mobile stage={stage} exitMode={exitMode} />
      </div>
    </>
  )
}
