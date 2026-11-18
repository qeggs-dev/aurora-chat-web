/**
 * 样式包「就地编辑模式」的会话状态：打开 / 关闭、草稿、选中的控件、校验、保存、导出。
 *
 * 与旧的表单式编辑器不同，编辑模式里所有改动都直接写进草稿并实时预览（由
 * `StyleEditMode` 组件调用 applyStyleVars + setStylePreview 完成），本模块只负责状态与数据。
 */
import { create } from 'zustand'
import { setThemePreference, useSettings, type ThemePreference } from '../settings.js'
import { getStoredStylePack, listStoredStylePacks } from './db.js'
import {
  createStyleEditorDraft,
  createStylePackId,
  draftToStoredStylePack,
  storedPackToDraft,
  styleDraftSignature,
  validateStyleDraft,
  type StyleDraftIssue,
  type StyleEditorDraft,
} from './editor.js'
import { buildStylePackZip, type ExportedStylePack } from './export.js'
import { saveStylePack, useStylePackStore } from './store.js'
import type { Theme } from './types.js'

export type StyleEditEntryMode = 'create' | 'edit'

export type StyleEditState = {
  open: boolean
  /** 正在准备草稿（读取 IndexedDB / 内置包） */
  opening: boolean
  mode: StyleEditEntryMode
  draft: StyleEditorDraft | null
  /** 打开时的草稿指纹：退出时判断「有未保存修改」 */
  baseline: string
  /** 编辑的源包 id：新建 / 内置包派生副本时为 null */
  sourcePackId: string | null
  /** 保存时保留的 importedAt（编辑用户自己导入的包时） */
  importedAt?: number
  /** 当前选中的控件槽位（点「修改此控件样式」后设置） */
  selectedSlot: string | null
  issues: StyleDraftIssue[]
  saving: boolean
  exporting: boolean
  /** 打开前的主题偏好：编辑期间固定成具体亮/暗主题，退出时恢复 */
  previousThemePreference: ThemePreference | null
}

const initialState: StyleEditState = {
  open: false,
  opening: false,
  mode: 'create',
  draft: null,
  baseline: '',
  sourcePackId: null,
  importedAt: undefined,
  selectedSlot: null,
  issues: [],
  saving: false,
  exporting: false,
  previousThemePreference: null,
}

export const useStyleEditStore = create<StyleEditState>(() => ({ ...initialState }))

const { getState: get, setState: set } = useStyleEditStore

/** 当前解析后的亮/暗主题（跟随系统时取系统值）；编辑模式把它固定成具体值 */
const resolveCurrentTheme = (): Theme => {
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

/**
 * 进入编辑模式：
 * - `create`：空白草稿（自动生成 `custom-<timestamp36>` id）；
 * - `edit`：以当前启用包为底稿；内置极光包会派生出一个新的自定义包 id（不允许覆盖 aurora）。
 */
export const openStyleEditor = async (mode: StyleEditEntryMode): Promise<void> => {
  if (get().open || get().opening) {
    return
  }
  set({ opening: true })
  try {
    const theme = resolveCurrentTheme()
    const taken = (await listStoredStylePacks()).map((pack) => pack.id)
    let draft: StyleEditorDraft
    let sourcePackId: string | null = null
    let importedAt: number | undefined

    if (mode === 'edit') {
      const activeId = useStylePackStore.getState().activeId
      const stored = activeId ? await getStoredStylePack(activeId) : undefined
      if (stored) {
        draft = storedPackToDraft(stored, { theme })
        if (stored.builtin === true) {
          // 内置包不能覆盖：编辑结果保存为新的自定义包
          draft.id = createStylePackId(Date.now(), taken)
        } else {
          sourcePackId = stored.id
          importedAt = stored.importedAt
        }
      } else {
        draft = createStyleEditorDraft({ theme, takenIds: taken })
      }
    } else {
      draft = createStyleEditorDraft({ theme, takenIds: taken })
    }

    draft.theme = theme
    const previousThemePreference = useSettings.getState().themePreference
    // 编辑期间固定亮/暗主题：预览、PackIcon 取图与侧面板编辑目标保持一致
    if (previousThemePreference === 'system') {
      setThemePreference(theme)
    }
    set({
      open: true,
      opening: false,
      mode,
      draft,
      baseline: styleDraftSignature(draft),
      sourcePackId,
      importedAt,
      selectedSlot: null,
      issues: [],
      saving: false,
      exporting: false,
      previousThemePreference,
    })
  } catch {
    set({ opening: false })
  }
}

/**
 * 退出编辑模式。恢复打开前的主题偏好放在微任务里：先让界面卸载并按编辑中的主题
 * 恢复当前启用的样式，再切回用户原来的偏好，避免两次 applyStyleVars 的先后顺序反掉。
 */
export const closeStyleEditor = (): void => {
  const state = get()
  if (!state.open) {
    return
  }
  const previous = state.previousThemePreference
  set({ ...initialState })
  if (previous !== null && useSettings.getState().themePreference !== previous) {
    queueMicrotask(() => setThemePreference(previous))
  }
}

/** 修改草稿（所有改动即时生效于预览）；同时清掉上一次的校验错误 */
export const updateStyleDraft = (
  mutator: (current: StyleEditorDraft) => StyleEditorDraft
): void => {
  const state = get()
  if (!state.draft) {
    return
  }
  set({ draft: mutator(state.draft), issues: [] })
}

/** 选中要修改的控件槽位（null = 回到「全部设置」） */
export const selectStyleEditSlot = (slot: string | null): void => {
  set({ selectedSlot: slot })
}

/**
 * 切换编辑目标主题：同时把界面主题切过去（预览与真实渲染一致），退出时恢复原偏好。
 */
export const setStyleEditTheme = (theme: Theme): void => {
  const state = get()
  if (!state.draft || state.draft.theme === theme) {
    return
  }
  set({ draft: { ...state.draft, theme } })
  if (useSettings.getState().themePreference !== theme) {
    setThemePreference(theme)
  }
}

export const validateStyleEditDraft = (): StyleDraftIssue[] => {
  const state = get()
  if (!state.draft) {
    return []
  }
  const issues = validateStyleDraft(state.draft)
  set({ issues })
  return issues
}

/** 有未保存修改（与打开时的草稿指纹比较） */
export const styleEditIsDirty = (): boolean => {
  const state = get()
  return state.draft !== null && styleDraftSignature(state.draft) !== state.baseline
}

/**
 * 保存为本地用户包（builtin: false；编辑已有用户包时保留 importedAt）。
 * 成功返回 true，并把指纹基线刷新为当前草稿。
 */
export const saveStyleEditDraft = async (): Promise<boolean> => {
  const state = get()
  if (!state.draft || state.saving) {
    return false
  }
  const issues = validateStyleDraft(state.draft)
  if (issues.length > 0) {
    set({ issues })
    return false
  }
  set({ saving: true, issues: [] })
  try {
    const draft = state.draft
    const pack = draftToStoredStylePack(draft, { importedAt: state.importedAt })
    await saveStylePack(pack)
    set({
      saving: false,
      sourcePackId: pack.id,
      importedAt: pack.importedAt,
      baseline: styleDraftSignature(draft),
    })
    return true
  } catch {
    set({ saving: false })
    return false
  }
}

/**
 * 把当前草稿导出成 zip（保存前同样先校验）；校验失败时 issues 已写入 state。
 * 返回 zip 与文件名，由界面负责触发下载。
 */
export const exportStyleEditDraft = async (): Promise<ExportedStylePack | null> => {
  const state = get()
  if (!state.draft || state.exporting) {
    return null
  }
  const issues = validateStyleDraft(state.draft)
  if (issues.length > 0) {
    set({ issues })
    return null
  }
  set({ exporting: true, issues: [] })
  try {
    const exported = await buildStylePackZip(state.draft)
    set({ exporting: false })
    return exported
  } catch {
    set({ exporting: false })
    return null
  }
}

export type StyleEditStateSnapshot = StyleEditState

/** 供非 React 代码读取当前编辑状态（主题固定 / 预览恢复等） */
export const getStyleEditState = (): StyleEditState => useStyleEditStore.getState()
