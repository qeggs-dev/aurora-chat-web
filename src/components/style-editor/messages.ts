/** 样式包编辑模式共用的校验文案映射：错误码 → i18n key，参数换算（字节 / 字符数）。 */
import type { TranslationKey, TranslationParams } from '../../i18n/index.js'
import type { StyleDraftIssue, StyleDraftIssueCode } from '../../services/style/editor.js'

export const STYLE_EDIT_ISSUE_KEYS: Record<StyleDraftIssueCode, TranslationKey> = {
  required: 'styleEditErrorRequired',
  tooLong: 'styleEditErrorTooLong',
  badId: 'styleEditErrorBadId',
  reservedId: 'styleEditErrorReservedId',
  unsafeText: 'styleEditErrorUnsafeText',
  badColor: 'styleEditErrorBadColor',
  badPosition: 'styleEditErrorBadPosition',
  badFileType: 'styleEditErrorBadFileType',
  tooLarge: 'styleEditErrorTooLarge',
  totalTooLarge: 'styleEditErrorTotalTooLarge',
  noAssets: 'styleEditErrorNoAssets',
  emptyFile: 'styleEditErrorEmptyFile',
  badEffect: 'styleEditErrorBadEffect',
}

/** 字节数 → 展示文案（只用整数 MB / KB） */
export const formatBytes = (bytes: number): string =>
  bytes >= 1024 * 1024 ? `${Math.round(bytes / (1024 * 1024))} MB` : `${Math.round(bytes / 1024)} KB`

export const styleEditIssueParams = (
  issue: StyleDraftIssue
): TranslationParams | undefined => {
  const { max, name, extensions, value } = issue.params ?? {}
  const params: TranslationParams = {}
  if (max !== undefined) {
    params.max = issue.code === 'tooLong' ? max : formatBytes(max)
  }
  if (name !== undefined) {
    params.name = name
  }
  if (extensions !== undefined) {
    params.extensions = extensions
  }
  if (value !== undefined) {
    params.id = value
  }
  return Object.keys(params).length > 0 ? params : undefined
}
