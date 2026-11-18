/** 错误码 → i18n key。UI 与全局 toast 共用，避免两处各写一份映射。 */

import type { TranslationKey } from '../../i18n/index.js'
import type { UpdateErrorCode } from './github.js'

export const UPDATE_ERROR_MESSAGE_KEYS: Record<UpdateErrorCode, TranslationKey> = {
  network: 'updateErrorNetwork',
  timeout: 'updateErrorTimeout',
  'rate-limit': 'updateErrorRateLimit',
  forbidden: 'updateErrorForbidden',
  'no-release': 'updateErrorNoRelease',
  server: 'updateErrorServer',
  'invalid-response': 'updateErrorInvalidResponse',
  'no-asset': 'updateErrorNoAsset',
  'too-large': 'updateErrorTooLarge',
  'size-mismatch': 'updateErrorSizeMismatch',
  cancelled: 'updateErrorCancelled',
  permission: 'updateErrorPermission',
  unsupported: 'updateErrorUnsupported',
  'download-failed': 'updateErrorDownloadFailed',
}

export const updateErrorMessageKey = (code: UpdateErrorCode): TranslationKey =>
  UPDATE_ERROR_MESSAGE_KEYS[code] ?? 'updateErrorDownloadFailed'
