/**
 * Files API 附件的共享常量与判断。
 *
 * 不支持 Files 的预设（Chat / Responses / 非 DeepSeek 的 Anthropic）不会真的上传，
 * 而是返回一个以 `skipped-` 开头的本地占位 file_id。占位 id 只存在于本地，
 * 任何进入请求的路径都必须把它当作「没有附件」处理，否则服务端会收到不存在的 file_id。
 */

/** 不支持 Files 的预设上传时返回的占位 file_id 前缀（见 api/client.ts 的 uploadFile） */
export const SKIPPED_FILE_PREFIX = 'skipped-'

/** 本地占位 file_id：不能进入请求，也不能当作用户可见的真实附件 */
export const isSkippedFileId = (fileId: string): boolean =>
  fileId.startsWith(SKIPPED_FILE_PREFIX)
