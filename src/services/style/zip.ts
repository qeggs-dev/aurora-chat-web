/** 样式包 zip 的解析与校验：路径、大小、扩展名与清单字段都在这里把关。 */
import { unzipSync } from 'fflate'
import type { StyleAssetEntry, StyleManifest } from './types.js'

export type StylePackErrorCode =
  | 'tooLarge'
  | 'tooManyFiles'
  | 'notZip'
  | 'noIndex'
  | 'badIndex'
  | 'badPath'
  | 'missingFile'
  | 'badFileType'

export class StylePackError extends Error {
  constructor(
    public code: StylePackErrorCode,
    public detail?: string
  ) {
    super(detail ?? code)
    this.name = 'StylePackError'
  }
}

const MAX_ZIP_BYTES = 20 * 1024 * 1024
const MAX_TOTAL_BYTES = 60 * 1024 * 1024
const MAX_ENTRIES = 300
const MAX_LICENSE_BYTES = 200 * 1024

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'avif'])
const FONT_EXT = new Set(['ttf', 'otf', 'woff', 'woff2'])
const TEXT_EXT = new Set(['txt', 'md', 'license'])

const extensionOf = (name: string): string => {
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase()
}

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  ttf: 'font/ttf',
  otf: 'font/otf',
  woff: 'font/woff',
  woff2: 'font/woff2',
}

/** 只接受包内相对路径：不允许绝对路径、`.`/`..` 与空段。 */
export const normalizeEntryPath = (path: string): string | null => {
  const normalized = path.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!normalized) {
    return null
  }
  const parts = normalized.split('/')
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    return null
  }
  return parts.join('/')
}

export type ParsedStylePack = {
  manifest: StyleManifest
  /** assetId → 文件（已按主题后缀的完整 ID 建键） */
  assets: Record<string, { blob: Blob; alpha: number; exposure: number; kind: 'image' | 'font' }>
  icon?: Blob
  license?: string
  ignored: string[]
}

const readManifest = (text: string): StyleManifest => {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new StylePackError('badIndex', 'index.json is not valid JSON')
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new StylePackError('badIndex', 'index.json must be an object')
  }
  const record = raw as Record<string, unknown>
  if (record.schema !== 1) {
    throw new StylePackError('badIndex', 'schema must be 1')
  }
  if (typeof record.id !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(record.id)) {
    throw new StylePackError('badIndex', 'id must be 1-64 chars of [a-z0-9._-]')
  }
  if (typeof record.name !== 'string' || !record.name.trim() || record.name.length > 80) {
    throw new StylePackError('badIndex', 'name must be 1-80 chars')
  }
  if (record.assets === null || typeof record.assets !== 'object' || Array.isArray(record.assets)) {
    throw new StylePackError('badIndex', 'assets must be an object')
  }
  const optionalString = (value: unknown) => value === undefined || (typeof value === 'string' && value.length <= 400)
  if (!optionalString(record.description) || !optionalString(record.author) || !optionalString(record.version)) {
    throw new StylePackError('badIndex', 'description/author/version must be short strings')
  }
  if (record.sidebarTitle !== undefined && (typeof record.sidebarTitle !== 'string' || record.sidebarTitle.length > 40)) {
    throw new StylePackError('badIndex', 'sidebarTitle must be a string of at most 40 chars')
  }
  const ref = (value: unknown, field: string): string | undefined => {
    if (value === undefined) {
      return undefined
    }
    const file = typeof value === 'string' ? value : (value as { file?: unknown } | null)?.file
    if (typeof file !== 'string' || !file) {
      throw new StylePackError('badIndex', `${field}.file must be a string`)
    }
    return file
  }
  return {
    schema: 1,
    id: record.id,
    name: record.name.trim(),
    description: typeof record.description === 'string' ? record.description : undefined,
    author: typeof record.author === 'string' ? record.author : undefined,
    version: typeof record.version === 'string' ? record.version : undefined,
    sidebarTitle: typeof record.sidebarTitle === 'string' && record.sidebarTitle.trim() ? record.sidebarTitle.trim() : undefined,
    icon: ref(record.icon, 'icon') ? { file: ref(record.icon, 'icon') as string } : undefined,
    license: ref(record.license, 'license') ? { file: ref(record.license, 'license') as string } : undefined,
    assets: record.assets as Record<string, StyleAssetEntry>,
  }
}

export const parseStylePackZip = async (file: File): Promise<ParsedStylePack> => {
  if (file.size > MAX_ZIP_BYTES) {
    throw new StylePackError('tooLarge', `${file.size} bytes`)
  }
  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(new Uint8Array(await file.arrayBuffer()))
  } catch {
    throw new StylePackError('notZip')
  }

  const names = Object.keys(entries)
  if (names.length === 0) {
    throw new StylePackError('noIndex')
  }
  if (names.length > MAX_ENTRIES) {
    throw new StylePackError('tooManyFiles', String(names.length))
  }

  const paths = new Map<string, Uint8Array>()
  let total = 0
  for (const name of names) {
    const normalized = normalizeEntryPath(name)
    if (!normalized) {
      throw new StylePackError('badPath', name)
    }
    total += entries[name].length
    if (total > MAX_TOTAL_BYTES) {
      throw new StylePackError('tooLarge', 'uncompressed limit')
    }
    paths.set(normalized, entries[name])
  }

  const indexPath = [...paths.keys()].find((name) => name.toLowerCase() === 'index.json')
  if (!indexPath) {
    throw new StylePackError('noIndex')
  }
  const manifest = readManifest(new TextDecoder().decode(paths.get(indexPath) as Uint8Array))

  // TS 的 Uint8Array<ArrayBufferLike> 与 BlobPart 不兼容，这里复制一份有独立 ArrayBuffer 的副本
  const bytesOf = (name: string): Uint8Array<ArrayBuffer> => {
    const source = paths.get(name) as Uint8Array
    const copy = new Uint8Array(source.byteLength)
    copy.set(source)
    return copy
  }

  const blobOf = (name: string, mime: string) => new Blob([bytesOf(name)], { type: mime })

  const assets: ParsedStylePack['assets'] = {}
  const ignored: string[] = []
  for (const [assetId, entry] of Object.entries(manifest.assets)) {
    const path = normalizeEntryPath(entry?.file ?? '')
    if (!path || !paths.has(path)) {
      throw new StylePackError('missingFile', entry?.file ?? assetId)
    }
    const ext = extensionOf(path)
    if (IMAGE_EXT.has(ext)) {
      const alpha = typeof entry.alpha === 'number' && Number.isFinite(entry.alpha) ? Math.min(1, Math.max(0, entry.alpha)) : 1
      const exposure = typeof entry.exposure === 'number' && Number.isFinite(entry.exposure) ? Math.min(1, Math.max(-1, entry.exposure)) : 0
      assets[assetId] = { blob: blobOf(path, MIME[ext]), alpha, exposure, kind: 'image' }
    } else if (FONT_EXT.has(ext)) {
      assets[assetId] = { blob: blobOf(path, MIME[ext]), alpha: 1, exposure: 0, kind: 'font' }
    } else if (TEXT_EXT.has(ext)) {
      assets[assetId] = { blob: blobOf(path, 'text/plain; charset=utf-8'), alpha: 1, exposure: 0, kind: 'font' }
    } else {
      ignored.push(assetId)
    }
  }

  let icon: Blob | undefined
  if (manifest.icon) {
    const path = normalizeEntryPath(manifest.icon.file)
    if (!path || !paths.has(path)) {
      throw new StylePackError('missingFile', manifest.icon.file)
    }
    if (!IMAGE_EXT.has(extensionOf(path))) {
      throw new StylePackError('badFileType', manifest.icon.file)
    }
    icon = blobOf(path, MIME[extensionOf(path)])
  }

  let license: string | undefined
  if (manifest.license) {
    const path = normalizeEntryPath(manifest.license.file)
    if (!path || !paths.has(path)) {
      throw new StylePackError('missingFile', manifest.license.file)
    }
    const bytes = paths.get(path) as Uint8Array
    if (bytes.length <= MAX_LICENSE_BYTES) {
      license = new TextDecoder().decode(bytes)
    }
  }

  return { manifest, assets, icon, license, ignored }
}
