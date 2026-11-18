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
import { Button } from '../components/base/Button.js'
import { stopReadAloud } from '../services/speech/readAloud.js'
import { CollapsedSider } from '../components/sider/CollapsedSider.js'
import { closeMobileSider } from '../components/sider/mobileSiderState.js'
import { MobileSider, Sider } from '../components/sider/Sider.js'
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

  usePreventPageScroll(isMobile)

  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])

  // 文件数、存储空间达到上限时，附件上只显示「上传失败」，原因用 toast 说明
  useEffect(() => onUploadNotice(showToast), [])
  // 服务层需要 toast 的提示（如「预设不支持附件，不能只发附件」）
  useEffect(() => onChatNotice(showToast), [])
  useEffect(bindChatPersistence, [])
  // 多窗口同步：保存后广播、收到其他窗口的更新后失效 / 重载缓存
  useEffect(bindChatSync, [])

  // 搜索结果面板只属于当前会话
  useEffect(closeSearchPanel, [activeId])
  // 切换会话时停止朗读
  useEffect(stopReadAloud, [activeId])
  // 移动端选中会话、切换布局后收起抽屉
  useEffect(closeMobileSider, [activeId, isMobile])

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
          {isMobile ? <MobileSider /> : siderCollapsed ? null : <Sider />}
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
              {siderCollapsed ? <CollapsedSider /> : null}
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
                    siderCollapsed={siderCollapsed}
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
