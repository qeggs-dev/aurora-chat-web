/**
 * 样式包「就地编辑模式」的控件注册约定：
 *
 * - 可自定义元素在 DOM 上带 `data-style-slot="<资源槽位>"` 标记（未标记的元素不会被拦截）；
 * - 资源槽位是 `STYLE_SLOTS` 里的语义槽位（不带 `.light` / `.dark` 后缀），
 *   编辑模式按当前编辑主题拼成完整资源 ID；
 * - `sidebarTitle` 不是资源，用 `STYLE_EDIT_SIDEBAR_TITLE` 这个专用标记；
 * - 控件可以注册「原长按操作」：移动端长按弹出菜单时，可以把实际按住时长传回给该控件。
 *
 * 这个模块不依赖 React，纯 DOM 约定 + WeakMap 注册表。
 */
import { STYLE_PREFIX, type StyleSlot } from '../../services/style/types.js'

/** 侧边栏标题的专用标记（对应 index.json 的顶层 sidebarTitle，不是 assets 资源） */
export const STYLE_EDIT_SIDEBAR_TITLE = 'dslike_chat.style_pkg.sidebarTitle'

/** 元素上 `data-style-slot` 的取值：资源槽位或 sidebarTitle 标记 */
export type StyleEditTargetId = StyleSlot | typeof STYLE_EDIT_SIDEBAR_TITLE

/** 原长按操作：参数是实际按住时长（毫秒），由编辑模式在松开时测得 */
export type StyleLongPressAction = (durationMs: number) => void

const longPressActions = new WeakMap<Element, StyleLongPressAction>()

/** 给可自定义元素注册「原长按操作」；没有注册的控件菜单里隐藏该项 */
export const registerStyleLongPressAction = (
  element: Element | null | undefined,
  action: StyleLongPressAction
): void => {
  if (!element) {
    return
  }
  longPressActions.set(element, action)
}

export const unregisterStyleLongPressAction = (element: Element | null | undefined): void => {
  if (element) {
    longPressActions.delete(element)
  }
}

export const getStyleLongPressAction = (element: Element): StyleLongPressAction | undefined =>
  longPressActions.get(element)

/** 元素 → 最近的已注册编辑目标（没有则 undefined，调用方不做任何拦截） */
export const findStyleEditTarget = (target: EventTarget | null): Element | undefined => {
  if (!(target instanceof Element)) {
    return undefined
  }
  return target.closest<HTMLElement>('[data-style-slot]') ?? undefined
}

/** 读取元素的编辑目标标记 */
export const styleEditTargetOf = (element: Element): string | undefined => {
  const value = element.getAttribute('data-style-slot')
  return value ? value : undefined
}

/** 资源槽位 → 类别（供校验 / 面板选择编辑器） */
export type StyleEditTargetKind = 'background' | 'icon' | 'sidebarTitle' | 'other'

export const styleEditTargetKind = (target: string): StyleEditTargetKind => {
  if (target === STYLE_EDIT_SIDEBAR_TITLE) {
    return 'sidebarTitle'
  }
  if (target.startsWith(`${STYLE_PREFIX}.background.`)) {
    return 'background'
  }
  if (target.startsWith(`${STYLE_PREFIX}.icon.`)) {
    return 'icon'
  }
  return 'other'
}

/** 槽位的展示名：去掉统一前缀（`icon.setting.style` / `background.main` / `sidebarTitle`） */
export const styleEditTargetLabel = (target: string): string => {
  if (target === STYLE_EDIT_SIDEBAR_TITLE) {
    return 'sidebarTitle'
  }
  return target.startsWith(`${STYLE_PREFIX}.`)
    ? target.slice(STYLE_PREFIX.length + 1)
    : target
}

/**
 * 编辑模式的输入平台：只有 PC 端（桌面宿主）用右键，**所有移动 / 触屏宿主**用长按。
 * 用「主指针是否 coarse」判断：触屏笔记本接鼠标时主指针是 fine，仍按 PC 右键处理。
 */
export type StyleEditPlatform = 'desktop' | 'mobile'

export const detectPlatform = (): StyleEditPlatform => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return 'desktop'
  }
  return window.matchMedia('(pointer: coarse)').matches ? 'mobile' : 'desktop'
}

/** 是否是「移动端长按」分支（等价于 detectPlatform() !== 'desktop'） */
export const usesTouchLongPress = (): boolean => detectPlatform() !== 'desktop'
