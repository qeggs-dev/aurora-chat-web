/**
 * 预设编辑草稿的模块级会话状态：离开「预设」分组（组件卸载）后草稿仍然保留，
 * 重新进入时不会丢；关闭设置弹窗前由 SettingsContent 检查 dirty 并确认后重置。
 *
 * 不依赖 React / DOM，PresetSection 通过 useSyncExternalStore 订阅，
 * 单测可以直接驱动这里的纯更新函数。
 */
import type { Draft } from '../../services/preset/draft.js'

export type PresetDraftMap = Record<string, Draft>

let drafts: PresetDraftMap = {}
const listeners = new Set<() => void>()

const notify = (): void => {
  for (const listener of [...listeners]) {
    listener()
  }
}

/** useSyncExternalStore 的 getSnapshot：引用只在更新时变化 */
export const getPresetDrafts = (): PresetDraftMap => drafts

export const subscribePresetDrafts = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 函数式更新草稿表；返回同一个对象时视为无变化 */
export const updatePresetDrafts = (
  updater: (previous: PresetDraftMap) => PresetDraftMap
): void => {
  const next = updater(drafts)
  if (next === drafts) {
    return
  }
  drafts = next
  notify()
}

export const putPresetDraft = (id: string, draft: Draft): void => {
  updatePresetDrafts((previous) => ({ ...previous, [id]: draft }))
}

/** 删除一份草稿（删除预设 / 丢弃修改时用） */
export const removePresetDraft = (id: string): void => {
  updatePresetDrafts((previous) => {
    if (!Object.hasOwn(previous, id)) {
      return previous
    }
    const next: PresetDraftMap = {}
    for (const [key, value] of Object.entries(previous)) {
      if (key !== id) {
        next[key] = value
      }
    }
    return next
  })
}

/**
 * 使一份草稿失效：同 id 的预设被导入 / 保存覆盖后调用。下次选中该预设时
 * 加载 effect 会因为 drafts[id] 不存在而重新读取存储内容，旧草稿无法再写回去。
 */
export const invalidatePresetDraft = removePresetDraft

/** 清空全部草稿（用户确认丢弃未保存修改 / 关闭设置弹窗后） */
export const resetPresetDrafts = (): void => {
  if (Object.keys(drafts).length === 0) {
    return
  }
  drafts = {}
  notify()
}

/** 是否存在未保存的草稿（关闭 / 切分组前的确认条件） */
export const hasDirtyPresetDrafts = (map: PresetDraftMap = drafts): boolean =>
  Object.values(map).some((draft) => draft.dirty)

/** useSyncExternalStore 快照：布尔值，未变化时不会触发额外渲染 */
export const getDirtyPresetDraftsSnapshot = (): boolean => hasDirtyPresetDrafts()

/** 未保存草稿的数量（UI 提示用） */
export const countDirtyPresetDrafts = (map: PresetDraftMap = drafts): number =>
  Object.values(map).filter((draft) => draft.dirty).length
