import type { FileBlockParam } from '../api/types.js'
import { isSkippedFileId } from '../api/files.js'
import type { FileAttachment } from './types.js'

/**
 * 附件 → Files API 文件块：只保留真实的 serverId。
 * 占位 id（`skipped-`，不支持 Files 的预设上传时产生）与尚未补传的 null 一样不能进入请求，
 * 否则服务端会收到不存在的 file_id；全是这类附件时消息应退化成「只有正文」。
 */
export const toFileBlocks = (files: FileAttachment[]): FileBlockParam[] =>
  files.flatMap(({ serverId, isImage }) =>
    serverId && !isSkippedFileId(serverId)
      ? [
          {
            type: isImage ? 'image' : 'document',
            source: { type: 'file', file_id: serverId },
          },
        ]
      : []
  )

/** 提问是否还有可进入请求的内容：正文非空，或至少一个真实文件块 */
export const hasRequestContent = (content: string, files: FileAttachment[]): boolean =>
  content.trim() !== '' || toFileBlocks(files).length > 0
