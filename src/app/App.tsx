import { useEffect, useState } from 'react'
import { useTranslate } from '../i18n/index.js'
import { useSettings } from '../services/settings.js'
import { useIsMobile, useMobileViewport, usePreventPageScroll } from './viewport.js'
import {
  bindChatPersistence,
  bindChatSync,
  initChat,
  newChat,
  retrySaveSessions,
  selectSession,
  useChatStore,
} from '../services/chat/store.js'
import { SearchPanel } from '../components/search/SearchPanel.js'
import { closeSearchPanel } from '../components/search/searchPanelState.js'
import { SessionView } from '../components/session/SessionView.js'
import { SessionErrorBoundary } from '../components/session/SessionErrorBoundary.js'
import { MobileHeader } from '../components/session/MobileHeader.js'
import { Welcome } from '../components/session/Welcome.js'
import { ensureApiKey } from '../components/settings/settingsDialogState.js'
import { SettingsDialog } from '../components/settings/SettingsDialog.js'
import { StyleEditMode } from '../components/style-editor/StyleEditMode.js'
import { DisclaimerGate } from '../components/settings/DisclaimerGate.js'
import { Toast } from '../components/base/Toast.js'
import { showToast } from '../components/base/toastState.js'
import { onChatNotice } from '../services/notices.js'
import { initStylePacks } from '../services/style/store.js'
import { getActiveResolvedPreset, initPresets, usePresetStore } from '../services/preset/store.js'
import { initUsage } from '../services/usage/store.js'
import { initMemory, setMemoryEnabled } from '../services/memory/store.js'
import { onUploadNotice } from '../services/attachments.js'
import { startAutoUpdateCheck } from '../services/update/autoCheck.js'
import { updateErrorMessageKey } from '../services/update/messages.js'
import { useUpdateStore } from '../services/update/store.js'
import { Button } from '../components/base/Button.js'
import { stopReadAloud } from '../services/speech/readAloud.js'
import { bindAutoReadRuntime } from '../services/speech/autoReadRuntime.js'
import { CollapsedSider } from '../components/sider/CollapsedSider.js'
import { closeMobileSider, useMobileSider } from '../components/sider/mobileSiderState.js'
import { MobileSider, Sider } from '../components/sider/Sider.js'
import { usePresence } from '../components/motion/usePresence.js'
import { usePrefersReducedMotion } from '../components/motion/usePrefersReducedMotion.js'
import { resolveMotionTokens, siderExitMs } from '../components/motion/motionMath.js'
import styles from './App.module.css'
import { bootstrapApp, type BootstrapServices } from './bootstrap.js'
import { AppServicesProvider } from './AppServices.js'
import { getAppContext, resetAppContext, type AppContext } from './context.js'

/** 装配成功：用 Cordis 容器里的六个服务初始化（顺序与 Cordis 化之前一致） */
const serviceBootstrap = (services: ReturnType<AppContext['services']>): BootstrapServices => ({
  initChat,
  style: services.style,
  presets: {
    init: services.presets.init,
    getMemoryEnabled: () => services.presets.getActiveResolved()?.memory.enabled ?? false,
    subscribe: (listener) =>
      services.presets.subscribe((state, previous) => {
        if (state.active !== previous.active) {
          listener()
        }
      }),
  },
  usage: services.usage,
  memory: services.memory,
  disclaimerAccepted: () => useSettings.getState().disclaimerAccepted,
  ensureApiKey,
})

/** 装配失败：直连模块初始化（Phase 1 的界面本来就直连 store，功能不受影响） */
const fallbackBootstrap = (): BootstrapServices => ({
  initChat,
  style: { init: initStylePacks },
  presets: {
    init: initPresets,
    getMemoryEnabled: () => getActiveResolvedPreset()?.memory.enabled ?? false,
    subscribe: (listener) =>
      usePresetStore.subscribe((state, previous) => {
        if (state.active !== previous.active) {
          listener()
        }
      }),
  },
  usage: { init: initUsage },
  memory: { init: initMemory, setEnabled: setMemoryEnabled },
  disclaimerAccepted: () => useSettings.getState().disclaimerAccepted,
  ensureApiKey,
})

export const App = () => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const locale = useSettings((state) => state.locale)
  // 应用级 Cordis 容器：启动失败后「重试」会换成新容器（resetAppContext），因此存在 state 里
  const [context, setContext] = useState<AppContext>(() => getAppContext())
  // 服务装配失败的可读原因；同时已经退回直连初始化，界面仍可用
  const [bootstrapError, setBootstrapError] = useState<string | null>(null)
  // 移动端侧边栏以独立抽屉管理开合状态
  const siderCollapsed = useSettings((state) => state.siderCollapsed) && !isMobile
  const ready = useChatStore((state) => state.ready)
  const initError = useChatStore((state) => state.initError)
  const saveError = useChatStore((state) => Object.values(state.sessionSaveErrors).some(Boolean))
  const importingHistory = useChatStore((state) => state.importingHistory)
  const session = useChatStore((state) =>
    state.activeId !== null && Object.hasOwn(state.sessionCache, state.activeId)
      ? state.sessionCache[state.activeId]
      : undefined
  )
  const sessionLoadError = useChatStore((state) =>
    state.activeId === null ? false : state.sessionLoadErrors[state.activeId] === true
  )
  const frameRef = useMobileViewport(isMobile)
  const streaming = useChatStore((state) =>
    state.activeId === null ? false : Object.hasOwn(state.streaming, state.activeId)
  )
  const activeId = useChatStore((state) => state.activeId)

  // 侧边栏进出动效：收起后先保持挂载到退出动画播完，再真正卸载
  const reducedMotion = usePrefersReducedMotion()
  const siderPresence = usePresence(
    !isMobile && !siderCollapsed,
    siderExitMs('list', resolveMotionTokens(reducedMotion))
  )
  // 退出动画播完前不切「已收起」布局，否则内容会先跳到左边再等侧边栏滑走
  const siderExiting = siderPresence.mounted && siderPresence.stage === 'exit'

  usePreventPageScroll(isMobile)

  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])

  // 文件数、存储空间达到上限时，附件上只显示「上传失败」，原因用 toast 说明
  useEffect(() => onUploadNotice(showToast), [])
  // 服务层需要 toast 的提示（如「预设不支持附件，不能只发附件」）
  useEffect(() => onChatNotice(showToast), [])
  // 启动 5s 后自动检查更新（设置可关）；只在有新版本时提示，结果缓存 24h
  useEffect(() => startAutoUpdateCheck(), [])
  // 检查结果：发现新版本 / 失败时轻提示，不打断使用
  useEffect(
    () =>
      useUpdateStore.subscribe((state, previous) => {
        if (state.status === 'available' && state.release) {
          if (state.notifiedVersion !== state.release.version) {
            state.markNotified(state.release.version)
            showToast({ key: 'updateAvailableToast', params: { version: state.release.version } })
          }
          return
        }
        if (state.status === 'error' && state.error && state.error !== previous.error) {
          showToast({ key: updateErrorMessageKey(state.error.code), type: 'error' })
        }
      }),
    []
  )
  useEffect(bindChatPersistence, [])
  // 多窗口同步：保存后广播、收到其他窗口的更新后失效 / 重载缓存
  useEffect(bindChatSync, [])

  // 搜索结果面板只属于当前会话
  useEffect(closeSearchPanel, [activeId])
  // 切换会话时停止朗读
  useEffect(stopReadAloud, [activeId])
  // 自动朗读：订阅会话「生成中 → 空闲」，开关开启时朗读刚完成的回复；关闭开关立即停止
  useEffect(bindAutoReadRuntime, [])
  // 移动端选中会话、切换布局后收起抽屉；选中会话的收起由侧边栏按高亮编排自己处理，
  // 这里只在抽屉仍打开时兜底（避免覆盖掉 selection 的退出编排）
  useEffect(() => {
    if (useMobileSider.getState().open) {
      closeMobileSider('plain')
    }
  }, [activeId, isMobile])

  // 应用级 Cordis 容器：先等六个服务装配，再按服务初始化；装配失败时退回直连模块初始化，
  // 并把原因显示在顶部（可重试），不会因为装配失败永远停在「会话加载中」。
  useEffect(() => {
    let cancelled = false
    let disposeBootstrap = () => {}
    const boot = async () => {
      const result = await bootstrapApp({
        start: () => context.start(),
        fromServices: () => serviceBootstrap(context.services()),
        fromFallback: fallbackBootstrap,
      })
      if (cancelled) {
        result.dispose()
        return
      }
      disposeBootstrap = result.dispose
      setBootstrapError(result.error)
    }
    void boot()
    return () => {
      cancelled = true
      disposeBootstrap()
    }
  }, [context])

  /** 装配失败后的重试：Cordis 的 start() 只尝试一次，必须换一个新容器再装配 */
  const retryBootstrap = () => {
    setBootstrapError(null)
    setContext(resetAppContext())
  }

  return (
    <AppServicesProvider context={context}>
      <>
        <div ref={frameRef} className={styles.frame}>
          {isMobile ? (
            <MobileSider />
          ) : siderPresence.mounted ? (
            <Sider stage={siderPresence.stage} />
          ) : null}
          <main className={styles.main}>
            {bootstrapError ? (
              <div className={styles.saveError} role="alert">
                <span>{t('bootstrapFailed')}</span>
                <span className={styles.bootstrapReason}>{bootstrapError}</span>
                <Button variant="outlined" size="s" onClick={retryBootstrap}>
                  {t('retry')}
                </Button>
              </div>
            ) : null}
            {saveError ? (
              <div className={styles.saveError} role="alert">
                <span>{t('sessionSaveFailed')}</span>
                <Button
                  variant="outlined"
                  size="s"
                  disabled={importingHistory}
                  onClick={retrySaveSessions}
                >
                  {t('retry')}
                </Button>
              </div>
            ) : null}
            <div className={styles.content}>
              {siderCollapsed && !siderExiting ? <CollapsedSider /> : null}
              {!ready || (activeId !== null && !session) ? (
                <div className={styles.loadingView}>
                  {isMobile ? <MobileHeader /> : null}
                  <div className={styles.loadingState} role="status" aria-live="polite">
                    <span>
                      {(!ready ? initError : sessionLoadError)
                        ? t(!ready ? 'sessionListLoadFailed' : 'sessionLoadFailed')
                        : t('sessionLoading')}
                    </span>
                    {(!ready ? initError : sessionLoadError) ? (
                      <Button
                        variant="outlined"
                        size="m"
                        onClick={() => {
                          if (!ready) {
                            void initChat()
                          } else if (activeId !== null) {
                            selectSession(activeId)
                          }
                        }}
                      >
                        {t('retry')}
                      </Button>
                    ) : null}
                  </div>
                </div>
              ) : session ? (
                <SessionErrorBoundary key={session.id} onBack={newChat}>
                  <SessionView
                    session={session}
                    streaming={streaming}
                    siderCollapsed={siderCollapsed && !siderExiting}
                  />
                </SessionErrorBoundary>
              ) : (
                <Welcome />
              )}
            </div>
          </main>
          <SearchPanel />
        </div>
        <SettingsDialog />
        <StyleEditMode />
        <DisclaimerGate />
        <Toast />
      </>
    </AppServicesProvider>
  )
}
