/**
 * 样式包记录的完整性校验：IndexedDB 里可能留下「资产为空 / 零字节 Blob」的损坏记录
 * （备份恢复、异常写入、旧版本迁移），这类记录不能直接拿来启用，否则界面会静默失去样式。
 *
 * 同样用于启动恢复与激活前校验：坏记录在列表里标记并提示重新导入，启动时回退到内置包。
 */
import type { ThemedBlobs } from './types.js'

/** 完整性校验只需要关心这些字段；StoredStylePack 与列表摘要都能结构性传入 */
export type StylePackIntegrityView = {
  assets?: Record<string, Blob>
  icon?: ThemedBlobs
  cover?: ThemedBlobs
}

/** 资产必须全部是非空 Blob，且至少有一个资源；主题图标 / 封面要么缺省，要么是非空 Blob */
export const storedPackLooksIntact = (pack: StylePackIntegrityView): boolean => {
  const assets = Object.values(pack.assets ?? {})
  if (assets.length === 0 || assets.some((blob) => !(blob instanceof Blob) || blob.size === 0)) {
    return false
  }
  const extra = [pack.icon?.light, pack.icon?.dark, pack.cover?.light, pack.cover?.dark]
  return extra.every((blob) => blob === undefined || (blob instanceof Blob && blob.size > 0))
}

/** 列表 / 启动恢复用的最小包信息 */
export type StylePackAvailability = {
  id: string
  builtin?: boolean
  /** 记录是否完整（摘要上的 `broken` 取反） */
  broken?: boolean
}

/**
 * 启动时要恢复哪个样式包：
 * - 上次启用的包存在且完整 → 它；
 * - 否则回退到可用的内置包（内置包也损坏 / 缺失时 → null，即应用默认外观）。
 * 损坏的 saved 记录不会被恢复，避免带着不完整样式启动。
 */
export const resolveInitialStylePackId = (
  savedId: string | null,
  packs: readonly StylePackAvailability[],
  builtinId: string | null
): string | null => {
  const saved = savedId === null ? undefined : packs.find((pack) => pack.id === savedId)
  if (saved && saved.broken !== true) {
    return saved.id
  }
  const builtin = builtinId === null ? undefined : packs.find((pack) => pack.id === builtinId)
  if (builtin && builtin.broken !== true) {
    return builtin.id
  }
  return null
}
