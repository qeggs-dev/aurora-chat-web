/**
 * 同 id 覆盖的判定（纯逻辑，store 与单测共用）：
 *
 * - 导入 zip：内置预设 id 被占用 → 直接拒绝；用户自建预设同 id → 需要二次确认；
 *   已导入的预设同 id → 允许直接覆盖（重新导入更新版本是正常操作）。
 * - 保存草稿：草稿加载后记录又被改过（importedAt 变化，例如被 zip 重新导入）→ 需要确认，
 *   避免旧草稿把新导入的内容反向覆盖。
 */
export type PresetOverwriteCandidate = {
  builtin?: boolean
  source?: 'imported' | 'created'
}

export type ImportOverwriteCheck = 'none' | 'confirm' | 'blocked'

export const importOverwriteCheck = (
  previous: PresetOverwriteCandidate | undefined
): ImportOverwriteCheck => {
  if (!previous) {
    return 'none'
  }
  if (previous.builtin === true) {
    return 'blocked'
  }
  // 兼容旧记录：source 缺省按 created 处理，覆盖用户手写的预设一律先确认
  return previous.source === 'imported' ? 'none' : 'confirm'
}

/** 草稿基于的 importedAt 与当前记录不一致 → 草稿已过期，保存前需要确认 */
export const saveNeedsStaleConfirm = (
  expectedImportedAt: number | undefined,
  storedImportedAt: number | undefined
): boolean =>
  expectedImportedAt !== undefined &&
  storedImportedAt !== undefined &&
  expectedImportedAt !== storedImportedAt
