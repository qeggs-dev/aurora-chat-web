import clsx from 'clsx'
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { useSettings } from '../../services/settings.js'
import { applyStyleVars, type ActiveStyle } from '../../services/style/apply.js'
import {
  closeStyleEditor,
  exportStyleEditDraft,
  saveStyleEditDraft,
  selectStyleEditSlot,
  setStyleEditPanelView,
  styleEditIsDirty,
  useStyleEditStore,
} from '../../services/style/editStore.js'
import { compileStyleDraft } from '../../services/style/editor.js'
import { setStylePreview, useStylePackStore } from '../../services/style/store.js'
import type { ThemedBlobs, ThemedUrls, Theme } from '../../services/style/types.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import settingsStyles from '../settings/Settings.module.css'
import { StyleEditPanel, type StyleEditPanelDragHandlers } from './StyleEditPanel.js'
import { clampPanelPosition } from './panelPosition.js'
import { useStyleSlotLabel } from './slotLabels.js'
import {
  detectPlatform,
  findStyleEditTarget,
  getStyleLongPressAction,
  styleEditTargetOf,
  type StyleLongPressAction,
} from './targets.js'
import styles from './StyleEditMode.module.css'

/** 长按触发阈值（毫秒）；松手时把实际按住时长传给控件的原长按操作 */
const LONG_PRESS_MS = 500
/** 手指移动超过这个距离视为滚动 / 拖拽，取消长按 */
const LONG_PRESS_MOVE_PX = 10
/** 长按松手后，只吞掉「同一个控件上」紧随其后的 click，避免误触发控件原本的点击 */
const LONG_PRESS_CLICK_GUARD_MS = 600

type StyleEditMenuState = {
  x: number
  y: number
  target: string
  /** 长按来源、且控件注册了原长按操作时才有该字段 */
  longPress?: { durationMs: number; action: StyleLongPressAction }
}

/** 拖动后的面板位置 + 固定尺寸（null = 使用 CSS 默认位置；进入 / 退出编辑模式时重置） */
type PanelRect = {
  left: number
  top: number
  width: number
  height: number
  /** 标题栏高度：面板高于视口时用它保证拖动手柄仍可抓取 */
  titleHeight: number
}

/** 退出时恢复样式用的主题：编辑期间主题被固定成具体亮/暗值 */
const resolveThemeNow = (): Theme => {
  const preference = useSettings.getState().themePreference
  if (preference !== 'system') {
    return preference
  }
  return typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light'
}

/** 菜单定位：夹在视口内，避免贴边被裁掉 */
const clampMenuPosition = (state: StyleEditMenuState): { left: number; top: number } => {
  const width = 240
  const height = state.longPress ? 104 : 60
  return {
    left: Math.min(Math.max(8, state.x), Math.max(8, window.innerWidth - width - 8)),
    top: Math.min(Math.max(8, state.y), Math.max(8, window.innerHeight - height - 8)),
  }
}

const StyleEditModeActive = () => {
  const t = useTranslate()
  // 工具栏是 fixed 覆盖层：把高度写进 CSS 变量，让应用内容整体下移，避免遮住顶部控件。
  const toolbarRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const toolbar = toolbarRef.current
    if (!toolbar) {
      return
    }
    const applyHeight = () => {
      const height = toolbar.getBoundingClientRect().height
      document.documentElement.style.setProperty('--style-edit-top', `${Math.ceil(height) + 20}px`)
    }
    applyHeight()
    const observer = new ResizeObserver(applyHeight)
    observer.observe(toolbar)
    return () => {
      observer.disconnect()
      document.documentElement.style.removeProperty('--style-edit-top')
    }
  }, [])
  const mode = useStyleEditStore((state) => state.mode)
  const draft = useStyleEditStore((state) => state.draft)
  const issues = useStyleEditStore((state) => state.issues)
  const saving = useStyleEditStore((state) => state.saving)
  const exporting = useStyleEditStore((state) => state.exporting)
  const panelView = useStyleEditStore((state) => state.panelView)
  const slotLabel = useStyleSlotLabel()
  // 进入编辑模式时面板默认关闭：只保留顶部工具栏，界面上的控件（含输入框右下角的发送按钮）
  // 不被面板遮挡，都能直接右键 / 长按编辑；点「显示面板」或从控件菜单进入时再打开。
  const [panelOpen, setPanelOpen] = useState(false)
  const [menu, setMenu] = useState<StyleEditMenuState | null>(null)
  const [exitOpen, setExitOpen] = useState(false)

  const assetUrls = useRef(new Map<string, { blob: Blob; url: string }>())
  const themedUrls = useRef(new Map<string, { blob: Blob; url: string }>())

  /* ===== 悬浮面板拖动：标题栏是唯一手柄，位置在进入 / 退出编辑模式时重置 ===== */
  const panelRef = useRef<HTMLElement | null>(null)
  const panelDrag = useRef<{
    pointerId: number
    offsetX: number
    offsetY: number
    width: number
    height: number
    titleHeight: number
  } | null>(null)
  const [panelRect, setPanelRect] = useState<PanelRect | null>(null)

  /** 面板空白处也能拖：鼠标从非交互区域按下即可；触屏保留标题栏手柄，避免抢走面板内滚动。 */
  const onPanelBlankPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.pointerType !== 'mouse' || event.button !== 0) {
      return
    }
    if (event.target instanceof Element && event.target.closest('[data-style-edit-drag-handle]')) {
      return
    }
    if (
      event.target instanceof Element &&
      event.target.closest(
        'input, textarea, select, button, a, label, [contenteditable="true"], [role="button"], [role="tab"], [role="menuitem"]'
      )
    ) {
      return
    }
    onPanelDragStart(event)
  }

  const onPanelDragStart = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.pointerType === 'mouse' && event.button !== 0) {
      return
    }
    const panel = panelRef.current
    if (!panel) {
      return
    }
    const rect = panel.getBoundingClientRect()
    const handle = panel.querySelector<HTMLElement>('[data-style-edit-drag-handle]')
    const titleHeight = handle?.getBoundingClientRect().height ?? 40
    panelDrag.current = {
      pointerId: event.pointerId,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      width: rect.width,
      height: rect.height,
      titleHeight,
    }
    setPanelRect({
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
      titleHeight,
    })
    event.currentTarget.setPointerCapture(event.pointerId)
    // 拖动期间不选中文字、不触发浏览器原生拖拽
    event.preventDefault()
  }

  const onPanelDragMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = panelDrag.current
    if (!drag || drag.pointerId !== event.pointerId) {
      return
    }
    const next = clampPanelPosition(
      { left: event.clientX - drag.offsetX, top: event.clientY - drag.offsetY },
      { width: drag.width, height: drag.height, titleHeight: drag.titleHeight },
      { width: window.innerWidth, height: window.innerHeight }
    )
    setPanelRect({
      left: next.left,
      top: next.top,
      width: drag.width,
      height: drag.height,
      titleHeight: drag.titleHeight,
    })
  }

  const onPanelDragEnd = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = panelDrag.current
    if (!drag || drag.pointerId !== event.pointerId) {
      return
    }
    panelDrag.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const panelDragHandlers: StyleEditPanelDragHandlers = {
    onPointerDown: onPanelDragStart,
    onPointerMove: onPanelDragMove,
    onPointerUp: onPanelDragEnd,
    onPointerCancel: onPanelDragEnd,
  }

  /** 窗口尺寸变化时把已拖动的面板重新夹回视口（标题栏始终可抓取） */
  const panelDragged = panelRect !== null
  useEffect(() => {
    if (!panelDragged) {
      return
    }
    const onResize = (): void => {
      setPanelRect((current) => {
        if (!current) {
          return current
        }
        const next = clampPanelPosition(
          { left: current.left, top: current.top },
          { width: current.width, height: current.height, titleHeight: current.titleHeight },
          { width: window.innerWidth, height: window.innerHeight }
        )
        return next.left === current.left && next.top === current.top
          ? current
          : { ...current, left: next.left, top: next.top }
      })
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [panelDragged])

  /**
   * 实时预览：草稿每次变化都编译成临时 ActiveStyle 并应用。
   * 资源 objectURL 按 Blob 身份增量复用，避免每敲一个字就把所有图重建一遍。
   * 图标 / 侧边栏标题这类组件内部渲染的资源通过 store 的 preview 通道生效；
   * 背景 / 字体 / 配色走 applyStyleVars 写 CSS 变量。
   */
  useEffect(() => {
    if (!draft) {
      return
    }
    const compiled = compileStyleDraft(draft)
    const nextAssets = new Map<string, { blob: Blob; url: string }>()
    const urls: Record<string, string> = {}
    for (const [assetId, blob] of Object.entries(compiled.assets)) {
      const cached = assetUrls.current.get(assetId)
      const entry =
        cached && cached.blob === blob ? cached : { blob, url: URL.createObjectURL(blob) }
      nextAssets.set(assetId, entry)
      urls[assetId] = entry.url
    }
    for (const [assetId, entry] of assetUrls.current) {
      if (!nextAssets.has(assetId)) {
        URL.revokeObjectURL(entry.url)
      }
    }
    assetUrls.current = nextAssets

    const nextThemed = new Map<string, { blob: Blob; url: string }>()
    const themed = (blobs: ThemedBlobs | undefined, prefix: string): ThemedUrls | undefined => {
      if (!blobs) {
        return undefined
      }
      const result: ThemedUrls = {}
      for (const theme of ['light', 'dark'] as const) {
        const blob = blobs[theme]
        if (!blob) {
          continue
        }
        const key = `${prefix}:${theme}`
        const cached = themedUrls.current.get(key)
        const entry =
          cached && cached.blob === blob ? cached : { blob, url: URL.createObjectURL(blob) }
        result[theme] = entry.url
        nextThemed.set(key, entry)
      }
      return result.light || result.dark ? result : undefined
    }
    const iconUrls = themed(compiled.icon, 'icon')
    const coverUrls = themed(compiled.cover, 'cover')
    for (const [key, entry] of themedUrls.current) {
      if (!nextThemed.has(key)) {
        URL.revokeObjectURL(entry.url)
      }
    }
    themedUrls.current = nextThemed

    const active: ActiveStyle = {
      id: compiled.manifest.id || 'style-editor-preview',
      manifest: compiled.manifest,
      urls,
      iconUrls,
      coverUrls,
      license: compiled.license,
    }
    setStylePreview(active)
    void applyStyleVars(active, draft.theme)
  }, [draft])

  /** 退出编辑模式：清理预览资源，恢复 store 当前启用样式（未保存的修改自然被丢弃） */
  useEffect(() => {
    const body = document.body
    body.classList.add('style-edit-mode')
    return () => {
      body.classList.remove('style-edit-mode')
      setStylePreview(null)
      for (const entry of assetUrls.current.values()) {
        URL.revokeObjectURL(entry.url)
      }
      for (const entry of themedUrls.current.values()) {
        URL.revokeObjectURL(entry.url)
      }
      assetUrls.current.clear()
      themedUrls.current.clear()
      // 恢复成打开编辑器前 / 保存后的启用样式；主题偏好稍后在关闭动作里恢复
      void applyStyleVars(useStylePackStore.getState().active, resolveThemeNow())
    }
  }, [])

  /**
   * 全局手势：PC 端（桌面宿主：Windows / Linux / macOS）右键，
   * 其余（所有移动 / 触屏宿主）长按。只拦截带 `data-style-slot` 标记的控件，
   * 未注册元素完全不受影响（点击 / 滚动 / 发送照常）。
   */
  useEffect(() => {
    const touchMode = detectPlatform() !== 'desktop'
    let pressTimer = 0
    let pressTarget: Element | null = null
    let pressX = 0
    let pressY = 0
    let pressStart = 0
    let pressFired = false
    /** 长按松手后要吞掉 click 的控件（只吞该控件内部的 click，不吞菜单点击） */
    let suppressClickTarget: Element | null = null
    let suppressClickTimer = 0

    const clearTimer = (): void => {
      if (pressTimer !== 0) {
        window.clearTimeout(pressTimer)
        pressTimer = 0
      }
    }

    const openMenu = (
      element: Element,
      x: number,
      y: number,
      longPress?: StyleEditMenuState['longPress']
    ): void => {
      const target = styleEditTargetOf(element)
      if (!target) {
        return
      }
      setMenu({ x, y, target, longPress })
    }

    const onContextMenu = (event: MouseEvent): void => {
      const element = findStyleEditTarget(event.target)
      if (!element) {
        return
      }
      event.preventDefault()
      // 移动端用长按菜单；这里只屏蔽浏览器原生菜单
      if (touchMode) {
        return
      }
      openMenu(element, event.clientX, event.clientY)
    }

    const onTouchStart = (event: TouchEvent): void => {
      if (!touchMode || event.touches.length !== 1) {
        return
      }
      const element = findStyleEditTarget(event.target)
      const touch = event.touches[0]
      if (!element || !touch) {
        return
      }
      clearTimer()
      pressTarget = element
      pressX = touch.clientX
      pressY = touch.clientY
      pressStart = Date.now()
      pressFired = false
      pressTimer = window.setTimeout(() => {
        pressTimer = 0
        if (!pressTarget) {
          return
        }
        pressFired = true
        const action = getStyleLongPressAction(pressTarget)
        openMenu(
          pressTarget,
          pressX,
          pressY,
          action ? { durationMs: Date.now() - pressStart, action } : undefined
        )
      }, LONG_PRESS_MS)
    }

    const onTouchMove = (event: TouchEvent): void => {
      if (!pressTarget || pressTimer === 0) {
        return
      }
      const touch = event.touches[0]
      if (!touch) {
        return
      }
      if (
        Math.abs(touch.clientX - pressX) > LONG_PRESS_MOVE_PX ||
        Math.abs(touch.clientY - pressY) > LONG_PRESS_MOVE_PX
      ) {
        clearTimer()
      }
    }

    const finishPress = (): void => {
      clearTimer()
      if (!pressTarget) {
        return
      }
      if (pressFired) {
        const durationMs = Date.now() - pressStart
        // 只保护「长按的那个控件」：菜单渲染在 body 下，不受影响
        suppressClickTarget = pressTarget
        if (suppressClickTimer !== 0) {
          window.clearTimeout(suppressClickTimer)
        }
        suppressClickTimer = window.setTimeout(() => {
          suppressClickTarget = null
          suppressClickTimer = 0
        }, LONG_PRESS_CLICK_GUARD_MS)
        setMenu((current) =>
          current?.longPress
            ? { ...current, longPress: { ...current.longPress, durationMs } }
            : current
        )
      }
      pressTarget = null
      pressFired = false
    }

    const onClickCapture = (event: MouseEvent): void => {
      if (
        suppressClickTarget &&
        event.target instanceof Node &&
        (suppressClickTarget === event.target || suppressClickTarget.contains(event.target))
      ) {
        suppressClickTarget = null
        event.preventDefault()
        event.stopPropagation()
      }
    }

    document.addEventListener('contextmenu', onContextMenu, true)
    document.addEventListener('touchstart', onTouchStart, { capture: true, passive: true })
    document.addEventListener('touchmove', onTouchMove, { capture: true, passive: true })
    document.addEventListener('touchend', finishPress, true)
    document.addEventListener('touchcancel', finishPress, true)
    document.addEventListener('click', onClickCapture, true)
    return () => {
      clearTimer()
      if (suppressClickTimer !== 0) {
        window.clearTimeout(suppressClickTimer)
      }
      document.removeEventListener('contextmenu', onContextMenu, true)
      document.removeEventListener('touchstart', onTouchStart, true)
      document.removeEventListener('touchmove', onTouchMove, true)
      document.removeEventListener('touchend', finishPress, true)
      document.removeEventListener('touchcancel', finishPress, true)
      document.removeEventListener('click', onClickCapture, true)
    }
  }, [])

  /** 菜单打开时点空白处关闭（点菜单内部不关闭） */
  useEffect(() => {
    if (!menu) {
      return
    }
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Element && event.target.closest('[data-style-edit-menu]')) {
        return
      }
      setMenu(null)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [menu])

  const requestExit = (): void => {
    if (saving || exporting) {
      return
    }
    if (styleEditIsDirty()) {
      setExitOpen(true)
      return
    }
    closeStyleEditor()
  }

  const save = async (): Promise<void> => {
    const ok = await saveStyleEditDraft()
    if (ok) {
      showToast({ key: 'styleEditSaved' })
      return
    }
    const nextIssues = useStyleEditStore.getState().issues
    showToast(
      nextIssues.length > 0
        ? {
            key: 'styleEditValidationFailed',
            params: { count: nextIssues.length },
            type: 'error',
          }
        : { key: 'styleEditSaveFailed', type: 'error' }
    )
  }

  const exportZip = async (): Promise<void> => {
    const exported = await exportStyleEditDraft()
    if (!exported) {
      const nextIssues = useStyleEditStore.getState().issues
      showToast(
        nextIssues.length > 0
          ? {
              key: 'styleEditValidationFailed',
              params: { count: nextIssues.length },
              type: 'error',
            }
          : { key: 'styleEditExportFailed', type: 'error' }
      )
      return
    }
    const url = URL.createObjectURL(exported.blob)
    const link = document.createElement('a')
    link.href = url
    link.download = exported.name
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
    showToast({ key: 'styleEditExported' })
  }

  if (!draft) {
    return null
  }

  const longPress = menu?.longPress
  const menuPosition = menu ? clampMenuPosition(menu) : null

  return (
    <>
      <div
        ref={toolbarRef}
        className={styles.toolbar}
        role="toolbar"
        aria-label={t('styleEditPanel')}
      >
        <div className={styles.toolbarText}>
          <span className={styles.toolbarTitle}>
            {t(mode === 'edit' ? 'styleEditTitleEdit' : 'styleEditTitleCreate')}
          </span>
          <span className={styles.toolbarHint}>{t('styleEditHint')}</span>
        </div>
        <div className={styles.toolbarActions}>
          <Button
            variant="outlined"
            size="m"
            data-style-edit-metadata-open
            onClick={() => {
              // 面板可能还没打开：同时打开面板并切到元数据视图
              setStyleEditPanelView('metadata')
              setPanelOpen(true)
            }}
          >
            {t('styleEditMetadataOpen')}
          </Button>
          <Button
            variant="outlined"
            size="m"
            aria-expanded={panelOpen}
            onClick={() => setPanelOpen((value) => !value)}
          >
            {t(panelOpen ? 'styleEditPanelHide' : 'styleEditPanelShow')}
          </Button>
          <Button
            variant="outlined"
            size="m"
            disabled={saving || exporting}
            onClick={() => void exportZip()}
          >
            {t(exporting ? 'styleEditExporting' : 'styleEditExport')}
          </Button>
          <Button size="m" disabled={saving || exporting} onClick={() => void save()}>
            {t(saving ? 'styleEditSaving' : 'styleEditSave')}
          </Button>
          <Button variant="outlined" size="m" onClick={requestExit}>
            {t('styleEditExit')}
          </Button>
        </div>
      </div>
      {issues.length > 0 ? (
        <div className={styles.statusBar} role="alert">
          {t('styleEditValidationFailed', { count: issues.length })}
        </div>
      ) : null}
      {panelOpen ? (
        <aside
          ref={panelRef}
          onPointerDown={onPanelBlankPointerDown}
          onPointerMove={panelDragHandlers.onPointerMove}
          onPointerUp={panelDragHandlers.onPointerUp}
          onPointerCancel={panelDragHandlers.onPointerCancel}
          className={clsx(styles.panel, panelView === 'metadata' && styles.panelMetadata)}
          style={
            panelRect
              ? {
                  left: panelRect.left,
                  top: panelRect.top,
                  width: panelRect.width,
                  height: panelRect.height,
                  right: 'auto',
                  bottom: 'auto',
                  boxSizing: 'border-box',
                }
              : undefined
          }
          aria-label={t('styleEditPanel')}
        >
          <StyleEditPanel dragHandlers={panelDragHandlers} />
        </aside>
      ) : null}
      {menu && menuPosition ? (
        <div
          className={styles.menu}
          style={{ left: menuPosition.left, top: menuPosition.top }}
          role="menu"
          data-style-edit-menu
        >
          <div className={styles.menuTitle}>{slotLabel(menu.target)}</div>
          {longPress ? (
            <button
              type="button"
              role="menuitem"
              className={styles.menuItem}
              onClick={() => {
                const { action, durationMs } = longPress
                setMenu(null)
                action(durationMs)
              }}
            >
              {t('styleEditMenuLongPress', { duration: longPress.durationMs })}
            </button>
          ) : null}
          <button
            type="button"
            role="menuitem"
            className={styles.menuItem}
            onClick={() => {
              selectStyleEditSlot(menu.target)
              setPanelOpen(true)
              setMenu(null)
            }}
          >
            {t('styleEditMenuEdit')}
          </button>
        </div>
      ) : null}
      {exitOpen ? (
        <Modal
          title={t('styleEditUnsavedTitle')}
          className={settingsStyles.deleteConfirm}
          onClose={() => setExitOpen(false)}
          footer={
            <div className={settingsStyles.deleteActions}>
              <Button variant="outlined" size="m" autoFocus onClick={() => setExitOpen(false)}>
                {t('styleEditKeepEditing')}
              </Button>
              <Button
                variant="danger"
                size="m"
                onClick={() => {
                  setExitOpen(false)
                  closeStyleEditor()
                }}
              >
                {t('styleEditDiscard')}
              </Button>
            </div>
          }
        >
          <div>{t('styleEditUnsavedText')}</div>
        </Modal>
      ) : null}
    </>
  )
}

/** 样式包就地编辑模式入口：未打开时不渲染任何内容 */
export const StyleEditMode = () => {
  const open = useStyleEditStore((state) => state.open)
  return open ? <StyleEditModeActive /> : null
}
