/**
 * 预设分组的统一状态槽：导入成功 / 「已保存但未启用」/ 保存失败 / 启用前需保存等
 * 提示都写进同一个槽（{message, kind, at}），不会像 `importStatus ?? saveStatus` 那样
 * 让导入提示长期遮住后来的保存结果。
 *
 * `kind: 'info'` 的提示是持久提示（导入成功、已保存未启用），切换预设标签时保留；
 * `kind: 'error'` 是当前选中项的临时错误，切换标签时清掉。
 */
import type { TranslationKey, TranslationMessage } from '../../i18n/index.js'
import { PresetError } from '../../services/preset/types.js'

/** 每个 Preset 错误码对应的文案 key；未知错误退回带原始 message 的通用文案。 */
export const presetErrorKeys: Record<string, TranslationKey> = {
  tooLarge: 'presetErrorTooLarge',
  tooManyFiles: 'presetErrorTooManyFiles',
  notZip: 'presetErrorNotZip',
  noConfig: 'presetErrorNoConfig',
  badConfig: 'presetErrorBadConfig',
  badPath: 'presetErrorBadPath',
  missingFile: 'presetErrorMissingFile',
  badFileType: 'presetErrorBadFileType',
  reservedId: 'presetErrorReservedId',
  importedReadOnly: 'presetErrorImportedReadOnly',
  missingDescription: 'presetErrorMissingDescription',
  missingAuthor: 'presetErrorMissingAuthor',
  missingVersion: 'presetErrorMissingVersion',
  missingCopyright: 'presetErrorMissingCopyright',
  missingLicense: 'presetErrorMissingLicense',
  licenseFileMissing: 'presetErrorLicenseFileMissing',
}

export type PresetStatusKind = 'info' | 'error'

/** 统一状态槽：at 用于「后来的提示覆盖先前的」与测试断言 */
export type PresetStatus = {
  message: TranslationMessage
  kind: PresetStatusKind
  at: number
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/** 持久 / 临时提示：info 在切换标签时保留，error 会被清掉 */
export const infoStatus = (message: TranslationMessage, at: number): PresetStatus => ({
  message,
  kind: 'info',
  at,
})

export const errorStatus = (message: TranslationMessage, at: number): PresetStatus => ({
  message,
  kind: 'error',
  at,
})

/** 把任意错误翻译成状态槽：已知 PresetError 用错误码文案，其余带上原始 message */
export const presetErrorStatus = (
  error: unknown,
  fallback: TranslationKey,
  at: number
): PresetStatus =>
  error instanceof PresetError
    ? errorStatus(
        {
          key: Object.hasOwn(presetErrorKeys, error.code)
            ? presetErrorKeys[error.code]
            : fallback,
        },
        at
      )
    : errorStatus({ key: fallback, params: { message: errorText(error) } }, at)

/** store.error（错误码字符串）→ 状态槽；没有错误时为 null */
export const storeErrorStatus = (error: string | null, at: number): PresetStatus | null => {
  if (error === null) {
    return null
  }
  return errorStatus(
    {
      key: Object.hasOwn(presetErrorKeys, error) ? presetErrorKeys[error] : 'presetFailed',
    },
    at
  )
}

/** 切换预设标签：保留持久 info 提示，清掉当前选中项的临时错误 */
export const keepPersistentStatus = (status: PresetStatus | null): PresetStatus | null =>
  status?.kind === 'info' ? status : null

/** 新提示总是覆盖旧提示（导入提示不再遮蔽保存结果） */
export const nextStatus = (
  current: PresetStatus | null,
  incoming: PresetStatus | null
): PresetStatus | null => incoming ?? current
