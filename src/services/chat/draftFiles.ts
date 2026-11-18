import { isSkippedFileId } from '../api/files.js'
import type { UploadTask } from '../attachments.js'

/**
 * 草稿里的附件只在本页面内存中；从草稿移除或清空时，已经上传到 Files API 的文件
 * 若没有任何会话引用（发送成功后 id 会进入 sessionSummaries 的 fileIds 索引），就应删除，
 * 否则会在服务端持续占用文件数 / 存储配额。
 *
 * 占位 file_id（不支持 Files 的预设）没有远端对象，不能删；上传中 / 失败的附件也还没有可删对象。
 */
export const remoteFileCleanupTarget = (
  attachmentId: string,
  task: UploadTask | undefined,
  referencedFileIds: ReadonlySet<string>
): string | null => {
  if (task?.status !== 'done' || !task.serverId || isSkippedFileId(task.serverId)) {
    return null
  }
  return referencedFileIds.has(attachmentId) ? null : task.serverId
}

export type RemoteFileCleanupDeps = {
  /** 读取全部仍被会话引用的附件 id（sessionSummaries 的 fileIds 索引） */
  loadReferencedFileIds(): Promise<ReadonlySet<string>>
  /** 删除远端文件；失败由调用方静默 */
  deleteRemoteFile(serverId: string): Promise<void>
}

/**
 * 判断并清理一个被移除的草稿附件的远端文件。
 * 返回是否真的发起了删除。被引用时保留、上传未完成时不删、任何读取 / 删除失败都静默：
 * 泄漏一个远端文件不应打断输入框操作。
 */
export const cleanupDraftRemoteFile = async (
  attachmentId: string,
  task: UploadTask | undefined,
  deps: RemoteFileCleanupDeps
): Promise<boolean> => {
  if (task?.status !== 'done' || !task.serverId || isSkippedFileId(task.serverId)) {
    return false
  }
  try {
    const referencedFileIds = await deps.loadReferencedFileIds()
    const serverId = remoteFileCleanupTarget(attachmentId, task, referencedFileIds)
    if (!serverId) {
      return false
    }
    await deps.deleteRemoteFile(serverId)
    return true
  } catch {
    return false
  }
}
