/**
 * 逐条流式解压 ZIP 的公共实现：preset / style 两个导入器共用。
 *
 * 不调用 fflate 的 `unzipSync`（它会先把整包解压完再返回，解压炸弹会在校验大小之前
 * 占满内存）。这里用 `Unzip` 流按中央目录顺序逐条处理：
 * - 发现条目时先看中央目录声明的 `originalSize`，声明就超限的条目**根本不会开始解压**；
 * - 解压过程中逐块累计实际字节，单条目或总量超限立即抛错（抛错会中断 `push`，
 *   后续条目不会再被解压）；
 * - 目录条目与未知压缩方式按条目的实际内容拒绝 / 跳过，错误码与旧实现保持一致。
 */
import { Unzip, UnzipInflate, UnzipPassThrough } from 'fflate'

export type ZipReadLimits = {
  /** 单个文件条目解压后的字节上限 */
  maxEntryBytes: number
  /** 全部文件条目解压后的合计字节上限 */
  maxTotalBytes: number
  /** 文件条目数上限（不含目录条目） */
  maxEntries: number
}

export type ZipReadErrorCode = 'tooLarge' | 'tooManyFiles' | 'notZip'

export class ZipReadError extends Error {
  constructor(
    public code: ZipReadErrorCode,
    public detail?: string
  ) {
    super(detail ?? code)
    this.name = 'ZipReadError'
  }
}

/** 读取过程统计：测试用它证明「声明大小超限的条目没有被解压」 */
export type ZipReadStats = {
  /** 按顺序发现的文件条目名（目录条目不计） */
  discovered: string[]
  /** 真正解压完成的文件条目名 */
  decompressed: string[]
  /** 已解压的实际字节数 */
  totalBytes: number
}

const isDirectoryName = (name: string): boolean => name.endsWith('/') || name.endsWith('\\')

const ZIP_LOCAL_HEADER = 0x04034b50
const ZIP_EOCD = 0x06054b50
const MAX_COMMENT = 0xffff

/**
 * 结构校验：必须以本地文件头或 EOCD 开头，且末尾存在 EOCD。
 * fflate 的流式解压对「不是 zip」的输入经常静默结束（不抛错、也不产出条目），
 * 先做这个轻量检查才能保持旧实现「非 zip → notZip」的错误语义。
 */
const looksLikeZip = (data: Uint8Array): boolean => {
  if (data.length < 22) {
    return false
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const signature = view.getUint32(0, true)
  if (signature !== ZIP_LOCAL_HEADER && signature !== ZIP_EOCD) {
    return false
  }
  // EOCD 位于文件末尾 22 字节 + 最多 65535 字节注释之内
  const start = Math.max(0, data.length - 22 - MAX_COMMENT)
  for (let offset = data.length - 22; offset >= start; offset -= 1) {
    if (view.getUint32(offset, true) !== ZIP_EOCD) {
      continue
    }
    // 注释长度必须正好补齐到文件末尾
    if (offset + 22 + view.getUint16(offset + 20, true) === data.length) {
      return true
    }
  }
  return false
}

/**
 * 解压整个 ZIP，返回「条目名 → 解压后字节」。任何超限 / 结构错误都抛 ZipReadError，
 * 调用方再把 code 映射成自己的错误类型。
 */
export const readZipEntries = (
  data: Uint8Array,
  limits: ZipReadLimits,
  stats?: ZipReadStats
): Map<string, Uint8Array> => {
  if (!looksLikeZip(data)) {
    throw new ZipReadError('notZip')
  }
  const entries = new Map<string, Uint8Array>()
  const unzip = new Unzip()
  unzip.register(UnzipPassThrough)
  unzip.register(UnzipInflate)

  let totalBytes = 0
  let fileCount = 0
  let failure: ZipReadError | undefined

  /** 记住第一个超限原因并中断当前解压（throw 会从 fflate 的 push 里冒出来） */
  const abort = (error: ZipReadError): never => {
    failure = error
    throw error
  }

  unzip.onfile = (file) => {
    if (failure) {
      file.terminate()
      return
    }
    if (isDirectoryName(file.name)) {
      file.terminate()
      return
    }
    fileCount += 1
    if (fileCount > limits.maxEntries) {
      abort(new ZipReadError('tooManyFiles', String(fileCount)))
    }
    stats?.discovered.push(file.name)

    // 中央目录声明的未压缩大小：声明本身超限就直接中止，连 start() 都不调用。
    const declared = file.originalSize
    if (
      declared !== undefined &&
      (declared > limits.maxEntryBytes || totalBytes + declared > limits.maxTotalBytes)
    ) {
      abort(new ZipReadError('tooLarge', file.name))
    }
    // 只接受 stored / deflate；其它压缩方式与 fflate 的默认 unzipSync 一样按 notZip 处理。
    if (file.compression !== 0 && file.compression !== 8) {
      abort(new ZipReadError('notZip', file.name))
    }

    const chunks: Uint8Array[] = []
    let size = 0
    file.ondata = (error, chunk, final) => {
      if (failure) {
        return
      }
      if (error) {
        abort(new ZipReadError('notZip', file.name))
      }
      size += chunk.length
      totalBytes += chunk.length
      if (size > limits.maxEntryBytes || totalBytes > limits.maxTotalBytes) {
        abort(new ZipReadError('tooLarge', file.name))
      }
      if (chunk.length > 0) {
        chunks.push(chunk)
      }
      if (final) {
        const bytes = new Uint8Array(size)
        let offset = 0
        for (const part of chunks) {
          bytes.set(part, offset)
          offset += part.length
        }
        entries.set(file.name, bytes)
        stats?.decompressed.push(file.name)
        if (stats) {
          stats.totalBytes = totalBytes
        }
      }
    }
    file.start()
  }

  try {
    unzip.push(data, true)
  } catch (error) {
    if (failure) {
      throw failure
    }
    if (error instanceof ZipReadError) {
      throw error
    }
    throw new ZipReadError('notZip')
  }
  if (failure) {
    throw failure
  }
  return entries
}
