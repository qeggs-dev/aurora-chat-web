/**
 * 预设编辑草稿的数据模型（不依赖 React / DOM）：PresetSection 的编辑器状态与
 * 模块级草稿会话（presetDraftStore）都用这里的类型。
 *
 * `importedAt` 是草稿加载时对应存储记录的 importedAt，保存时用它判断草稿是否已过期
 * （同 id 的预设被重新导入 / 被别的保存覆盖后，旧草稿不能反向覆盖新内容）。
 */
import type { PresetConfig } from './types.js'

export type NumericField =
  | 'temperature'
  | 'top_p'
  | 'max_tokens'
  | 'presence_penalty'
  | 'frequency_penalty'
  | 'seed'
  | 'trigger_tokens'
  | 'keep_recent_messages'
  | 'max_results'

export type TextField = NumericField | 'stop'

export type TextMap = Record<TextField, string>

export type Draft = {
  config: PresetConfig
  /** 数值字段的输入原文：保存时以它为准并做范围校验 */
  text: TextMap
  /** 与 store 里的配置不一致（新建预设初始为 true） */
  dirty: boolean
  /** 内置预设（默认预设 / 内置演示包）：字段留空 = 系统默认，不可删除 */
  builtin: boolean
  /** 草稿对应的存储记录 importedAt（新建草稿为 undefined）；用于过期草稿保护 */
  importedAt?: number
}
