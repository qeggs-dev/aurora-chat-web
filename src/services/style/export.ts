/**
 * 样式包导出：把编辑器草稿打包成符合 `docs/style-packs.md` 的 zip（fflate）。
 *
 * 清单与资源路径都由 `editor.ts` 的 `compileStyleDraft` 生成（与保存到 IndexedDB 的
 * 数据结构同源），因此导出的包一定能被现有 `parseStylePackZip` 重新解析；
 * 这里只负责把资源 Blob 读成字节、写 index.json 并压成 zip。
 */
import { strToU8, zipSync } from 'fflate'
import {
  STYLE_DRAFT_INDEX_FILE,
  compileStyleDraft,
  type StyleEditorDraft,
} from './editor.js'
import { MAX_ZIP_BYTES } from './zip.js'

export type StyleExportErrorCode = 'tooLarge'

/** 导出失败：`tooLarge` 表示压出的 zip 超过导入器的 20 MB 上限（导回去会被拒） */
export class StyleExportError extends Error {
  constructor(
    public code: StyleExportErrorCode,
    public detail?: string
  ) {
    super(detail ?? code)
    this.name = 'StyleExportError'
  }
}

export type ExportedStylePack = {
  /** 下载文件名：`<id>.zip` */
  name: string
  blob: Blob
  /** zip 字节数（用于提示与测试） */
  size: number
}

/**
 * 草稿 → zip。
 * - index.json：schema 1，资源 file 全部显式写出，包含 LICENSE 引用；
 * - LICENSE：版权声明 + 可选 License 全文；
 * - 资源文件按 `assets/<theme>/…` 等默认位置组织。
 *
 * 压缩后用导入器的 zip 大小上限复核：超限时抛 StyleExportError（该包无法再次导入）。
 */
export const buildStylePackZip = async (draft: StyleEditorDraft): Promise<ExportedStylePack> => {
  const compiled = compileStyleDraft(draft)
  const entries: Record<string, Uint8Array> = {
    [STYLE_DRAFT_INDEX_FILE]: strToU8(JSON.stringify(compiled.manifest, null, 2)),
  }
  for (const file of compiled.files) {
    entries[file.path] = new Uint8Array(await file.blob.arrayBuffer())
  }
  const zipped = zipSync(entries)
  if (zipped.byteLength > MAX_ZIP_BYTES) {
    throw new StyleExportError('tooLarge', `${zipped.byteLength} bytes`)
  }
  return {
    name: `${compiled.manifest.id}.zip`,
    blob: new Blob([zipped], { type: 'application/zip' }),
    size: zipped.byteLength,
  }
}
