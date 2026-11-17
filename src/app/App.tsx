import { useEffect } from 'react'
import { useTranslate } from '../i18n/index.js'
import { useSettings } from '../services/settings.js'
import { useIsMobile, useMobileViewport, usePreventPageScroll } from './viewport.js'
import {
  bindChatPersistence,
  initChat,
  retrySaveSessions,
  selectSession,
  useChatStore,
} from '../services/chat/store.js'
import { SearchPanel } from '../components/search/SearchPanel.js'
import { closeSearchPanel } from '../components/search/searchPanelState.js'
import { SessionView } from '../components/session/SessionView.js'
import { MobileHeader } from '../components/session/MobileHeader.js'
import { Welcome } from '../components/session/Welcome.js'
import { ensureApiKey } from '../components/settings/settingsDialogState.js'
import { SettingsDialog } from '../components/settings/SettingsDialog.js'
import { DisclaimerGate } from '../components/settings/DisclaimerGate.js'
import { Toast } from '../components/base/Toast.js'
import { showToast } from '../components/base/toastState.js'
import { onUploadNotice } from '../services/attachments.js'
import { Button } from '../components/base/Button.js'
import { stopReadAloud } from '../services/speech/readAloud.js'
import { CollapsedSider } from '../components/sider/CollapsedSider.js'
import { closeMobileSider } from '../components/sider/mobileSiderState.js'
import { MobileSider, Sider } from '../components/sider/Sider.js'
import styles from './App.module.css'
import { AppServicesProvider } from './AppServices.js'
import { getAppContext } from './context.js'

/** 应用级 Cordis 容器：模块加载时创建并注册六个内置服务，start 在启动 effect 里执行 */
const appContext = getAppContext()

export const App = () => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const locale = useSettings((state) => state.locale)
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
  useEffect(bindChatPersistence, [])

  // 搜索结果面板只属于当前会话
  useEffect(closeSearchPanel, [activeId])
  // 切换会话时停止朗读
  useEffect(stopReadAloud, [activeId])
  // 移动端选中会话、切换布局后收起抽屉
  useEffect(closeMobileSider, [activeId, isMobile])

  // 应用级 Cordis 容器：启动六个内置服务，再经各服务调用 init（顺序与 Cordis 化之前一致）
  useEffect(() => {
    let cancelled = false
    let memoryReady = false
    let unsubscribePreset = () => {}
    const boot = async () => {
      try {
        await appContext.start()
      } catch {
        // start() 已把「哪个服务、缺什么依赖」输出到控制台；Phase 1 界面仍按直连 store 工作
        return
      }
      if (cancelled) {
        return
      }
      const services = appContext.services()
      void initChat()
      // 自定义样式包：读取已安装的包并应用当前启用的一套
      void services.style.init()
      // 记忆：预设恢复后才初始化（按当前预设的 memory.enabled 决定是否给模型挂记忆工具）
      // 之后切换预设（activatePreset）时同步记忆开关，关闭记忆时请求里不出现任何工具。
      const presetsReady = services.presets.init()
      // 用量：恢复最近请求记录（统计面板用）
      void services.usage.init()
      void presetsReady.then(() => {
        // 预设解析后的记忆开关：默认预设留空 = 系统默认（关闭）
        void services.memory.init(services.presets.getActiveResolved()?.memory.enabled ?? false)
        memoryReady = true
      })
      unsubscribePreset = services.presets.subscribe((state, previous) => {
        if (!memoryReady || state.active === previous.active) {
          return
        }
        void services.memory.setEnabled(
          services.presets.getActiveResolved()?.memory.enabled ?? false
        )
      })
      // 首次使用先确认非官方声明；确认后再要求 API Key
      if (useSettings.getState().disclaimerAccepted) {
        ensureApiKey()
      }
    }
    void boot()
    return () => {
      cancelled = true
      unsubscribePreset()
    }
  }, [])

  return (
    <AppServicesProvider context={appContext}>
      <>
        <div ref={frameRef} className={styles.frame}>
          {isMobile ? <MobileSider /> : siderCollapsed ? null : <Sider />}
          <main className={styles.main}>
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
                <SessionView
                  session={session}
                  streaming={streaming}
                  siderCollapsed={siderCollapsed}
                />
              ) : (
                <Welcome />
              )}
            </div>
          </main>
          <SearchPanel />
        </div>
        <SettingsDialog />
        <DisclaimerGate />
        <Toast />
      </>
    </AppServicesProvider>
  )
}
