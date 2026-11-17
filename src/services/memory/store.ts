/**
 * 记忆服务（sql.js SQLite 实现）。
 *
 * 设计约束：
 * - 面向 C 端用户：界面与模型都只能通过固定参数读写，不暴露 SQL。
 * - 表结构对齐工作区记忆库：sections / entries / entry_tags（子集）。
 * - 模型侧只暴露 MEMORY_TOOLS 里声明的函数，执行时由 runMemoryTool 严格校验参数后映射到参数化 SQL。
 * - 持久化：写操作只标 dirty，400ms 防抖后 `db.export()` 写 IndexedDB 的 main / main-prev 双槽；
 *   flushMemory() 立即落盘，pagehide / visibilitychange 时尽力 flush。
 *
 * 对外导出的类型与函数签名与骨架版本保持一致（新增 runMemoryTool）。
 */
import type { Database, SqlValue } from 'sql.js'
import { MEMORY_SECTION_LABELS } from './schema.js'
import {
  loadSqlJs,
  openMemoryDatabaseFromSnapshots,
  type DatabaseLoadSource,
} from './sqlite.js'
import {
  SNAPSHOT_FORMAT_VERSION,
  loadSnapshotPair,
  saveSnapshotPair,
  type MemorySnapshot,
} from './persistence.js'

export type MemoryEntry = {
  id: string
  section: string
  content: string
  tags: string[]
  createdAt: number
}

export type MemoryState = {
  ready: boolean
  /** 是否允许模型读写记忆（来自当前预设的 memory.enabled） */
  enabled: boolean
  entries: MemoryEntry[]
  error: string | null
}

/** 记忆分区；与工作区 MEMORY.db 的 section_key 对齐 */
export const MEMORY_SECTIONS = {
  core: 'SEC:00',
  preference: 'SEC:01',
  project: 'SEC:02',
  decision: 'SEC:03',
  todo: 'SEC:04',
} as const

export { MEMORY_SECTION_LABELS }

export type MemoryWriteInput = {
  content: string
  tags?: string[]
  section?: string
}

export type MemorySearchInput = {
  query: string
  tags?: string[]
  section?: string
  limit?: number
}

/** 模型可调用的记忆工具（schema 由各协议适配层翻译） */
export const MEMORY_TOOLS = [
  {
    name: 'memory_write',
    description: '把一条值得长期记住的事实写入记忆库；content 必须自包含、可判定，tags 用 1-4 个短词。',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '自包含的事实，一句话' },
        tags: { type: 'array', items: { type: 'string' }, description: '1-4 个短标签' },
        section: { type: 'string', description: '可选分区，默认 SEC:00 核心事实' },
      },
      required: ['content'],
    },
  },
  {
    name: 'memory_search',
    description: '按关键词或标签检索记忆，返回最相关的若干条。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索词；空字符串表示不按正文过滤' },
        tags: { type: 'array', items: { type: 'string' } },
        section: { type: 'string' },
        limit: { type: 'number', description: '1-20，默认 8' },
      },
      required: ['query'],
    },
  },
] as const

// ------------------------------------------------------------------ 常量

const SAVE_DEBOUNCE_MS = 400
const DEFAULT_SEARCH_LIMIT = 8
const MAX_SEARCH_LIMIT = 20
const DEFAULT_LIST_LIMIT = 50
const MAX_LIST_LIMIT = 500
const MEMORY_ENABLED_STORAGE_KEY = 'chat-demo:memory-enabled'

/** 工具参数上限（与 MEMORY_TOOLS 的 schema 约束保持一致） */
const TOOL_CONTENT_MAX_CHARS = 2048
const TOOL_TAG_MAX_ITEMS = 4
const TOOL_TAG_MAX_CHARS = 32
const TOOL_QUERY_MAX_CHARS = 200

const KNOWN_SECTIONS: ReadonlySet<string> = new Set(Object.keys(MEMORY_SECTION_LABELS))

// ------------------------------------------------------------------ 状态与订阅

let state: MemoryState = { ready: false, enabled: false, entries: [], error: null }
const listeners = new Set<() => void>()

const emit = () => {
  for (const listener of listeners) {
    listener()
  }
}

export const subscribeMemory = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export const getMemoryState = (): MemoryState => state

export const setMemoryState = (patch: Partial<MemoryState>): void => {
  state = { ...state, ...patch }
  emit()
}

// ------------------------------------------------------------------ 运行时（数据库 / 快照）

let database: Database | null = null
let initPromise: Promise<void> | null = null
let loadedSource: DatabaseLoadSource | null = null
/** 下一次保存时轮换进 main-prev 的「上一份可用快照」 */
let rotationCandidate: MemorySnapshot | null = null
let dirty = false
let saveTimer: ReturnType<typeof setTimeout> | null = null
let saveChain: Promise<void> = Promise.resolve()
let lifecycleRegistered = false
let lastSave: { bytes: number; ms: number; at: number } | null = null
let lastLoad: { source: DatabaseLoadSource; bytes: number; ms: number } | null = null

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

// ------------------------------------------------------------------ SQL 辅助

type Row = Record<string, SqlValue>

const asString = (value: SqlValue | undefined): string => {
  if (typeof value === 'string') {
    return value
  }
  return value === null || value === undefined ? '' : String(value)
}

const asNumber = (value: SqlValue | undefined): number => {
  if (typeof value === 'number') {
    return value
  }
  return Number(value ?? 0)
}

const select = (db: Database, sql: string, params: SqlValue[] = []): Row[] => {
  const statement = db.prepare(sql)
  try {
    statement.bind(params)
    const rows: Row[] = []
    while (statement.step()) {
      rows.push(statement.getAsObject())
    }
    return rows
  } finally {
    statement.free()
  }
}

const selectOne = (db: Database, sql: string, params: SqlValue[] = []): Row | undefined =>
  select(db, sql, params)[0]

const runSql = (db: Database, sql: string, params: SqlValue[] = []): void => {
  db.run(sql, params)
}

const inTransaction = <T>(db: Database, work: () => T): T => {
  db.exec('BEGIN')
  try {
    const result = work()
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

const escapeLike = (value: string): string => value.replace(/[\\%_]/g, (char) => `\\${char}`)

const normalizeTags = (tags: readonly string[] | undefined): string[] => {
  if (!tags || tags.length === 0) {
    return []
  }
  const seen = new Set<string>()
  const normalized: string[] = []
  for (const raw of tags) {
    if (typeof raw !== 'string') {
      continue
    }
    const tag = raw.trim().toLowerCase()
    if (!tag || seen.has(tag)) {
      continue
    }
    seen.add(tag)
    normalized.push(tag)
  }
  return normalized
}

const resolveSection = (section: string | undefined): string => {
  const trimmed = section?.trim()
  if (!trimmed) {
    return MEMORY_SECTIONS.core
  }
  if (!KNOWN_SECTIONS.has(trimmed)) {
    throw new Error(`未知记忆分区：${trimmed}`)
  }
  return trimmed
}

const clampLimit = (value: number | undefined, fallback: number, max: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback
  }
  return Math.min(max, Math.max(1, Math.floor(value)))
}

const formatDateKey = (timestamp: number): string => {
  const date = new Date(timestamp)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}${month}${day}`
}

/** 按天递增的 YYYYMMDD-NNN；序号从 entries（含已归档）里取当前最大值 +1，永不复用。
 *  进程内缓存「当前日期 → 下一个序号」，避免每次写入都对当天所有行做一次 MAX 扫描；
 *  跨天或首次使用时从数据库读一次。 */
let idSequence: { dateKey: string; next: number } | null = null

const nextEntryId = (db: Database, createdAt: number): string => {
  const dateKey = formatDateKey(createdAt)
  if (idSequence && idSequence.dateKey === dateKey) {
    const sequence = idSequence.next
    idSequence.next = sequence + 1
    return `${dateKey}-${String(sequence).padStart(3, '0')}`
  }
  const row = selectOne(
    db,
    'SELECT MAX(CAST(substr(id, 10) AS INTEGER)) AS seq FROM entries WHERE id LIKE ?',
    [`${dateKey}-%`]
  )
  const current = row ? asNumber(row.seq) : 0
  const sequence = Number.isFinite(current) ? current + 1 : 1
  idSequence = { dateKey, next: sequence + 1 }
  return `${dateKey}-${String(sequence).padStart(3, '0')}`
}

const loadTags = (db: Database, entryIds: string[]): Map<string, string[]> => {
  const tagsByEntry = new Map<string, string[]>()
  if (entryIds.length === 0) {
    return tagsByEntry
  }
  const placeholders = entryIds.map(() => '?').join(', ')
  const rows = select(
    db,
    `SELECT entry_id, tag FROM entry_tags WHERE entry_id IN (${placeholders}) ORDER BY rowid`,
    entryIds
  )
  for (const row of rows) {
    const entryId = asString(row.entry_id)
    const tag = asString(row.tag)
    const tags = tagsByEntry.get(entryId)
    if (tags) {
      tags.push(tag)
    } else {
      tagsByEntry.set(entryId, [tag])
    }
  }
  return tagsByEntry
}

const rowToEntry = (row: Row, tags: string[]): MemoryEntry => ({
  id: asString(row.id),
  section: asString(row.section_key),
  content: asString(row.content),
  tags,
  createdAt: asNumber(row.created_at),
})

const selectEntries = (db: Database, sql: string, params: SqlValue[]): MemoryEntry[] => {
  const rows = select(db, sql, params)
  const tagsByEntry = loadTags(
    db,
    rows.map((row) => asString(row.id))
  )
  return rows.map((row) => rowToEntry(row, tagsByEntry.get(asString(row.id)) ?? []))
}

const selectRecentEntries = (db: Database, limit: number): MemoryEntry[] =>
  selectEntries(
    db,
    `SELECT id, section_key, content, created_at
       FROM entries
      WHERE status = 'active'
      ORDER BY created_at DESC, id DESC
      LIMIT ?`,
    [limit]
  )

// ------------------------------------------------------------------ 快照持久化

const persistSnapshot = async (): Promise<void> => {
  if (!database || !dirty) {
    return
  }
  const startedAt = performance.now()
  const bytes = database.export()
  const snapshot: MemorySnapshot = {
    v: SNAPSHOT_FORMAT_VERSION,
    bytes,
    savedAt: Date.now(),
  }
  await saveSnapshotPair(snapshot, rotationCandidate)
  rotationCandidate = snapshot
  dirty = false
  lastSave = {
    bytes: bytes.byteLength,
    ms: Math.round((performance.now() - startedAt) * 100) / 100,
    at: snapshot.savedAt,
  }
}

const scheduleSave = (): void => {
  dirty = true
  if (saveTimer !== null) {
    return
  }
  saveTimer = setTimeout(() => {
    saveTimer = null
    saveChain = saveChain
      .then(() => persistSnapshot())
      .catch((error: unknown) => {
        setMemoryState({ error: `记忆库保存失败：${errorMessage(error)}` })
      })
  }, SAVE_DEBOUNCE_MS)
}

/** 立即落盘：取消防抖计时器，把当前 dirty 的库导出写进 IndexedDB */
const flushInternal = async (): Promise<void> => {
  if (saveTimer !== null) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  saveChain = saveChain.then(() => persistSnapshot())
  try {
    await saveChain
  } catch (error) {
    saveChain = Promise.resolve()
    throw error
  }
}

const registerLifecycleFlush = (): void => {
  if (lifecycleRegistered) {
    return
  }
  lifecycleRegistered = true
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', () => {
      void flushInternal().catch(() => {
        // 关页时 IDB 不保证完成，尽力而为；关键写入应显式 await flushMemory()
      })
    })
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        void flushInternal().catch(() => {
          // 同上：切后台的尽力保存
        })
      }
    })
  }
}

// ------------------------------------------------------------------ 初始化

const openStore = async (): Promise<void> => {
  try {
    const SQL = await loadSqlJs()
    const startedAt = performance.now()
    const pair = await loadSnapshotPair()
    const restored = openMemoryDatabaseFromSnapshots(SQL, {
      main: pair.main?.bytes ?? null,
      previous: pair.previous?.bytes ?? null,
    })
    database = restored.db
    loadedSource = restored.source
    idSequence = null
    // 只有「main 本身可用」时，才在下次保存时把旧 main 轮换进 main-prev；
    // 从 main-prev 恢复时保留这份好快照，避免把手里的坏 main 轮换进去。
    rotationCandidate =
      restored.source === 'main' ? pair.main ?? null : restored.source === 'main-prev' ? pair.previous ?? null : null
    registerLifecycleFlush()
    const entries = selectRecentEntries(restored.db, DEFAULT_LIST_LIMIT)
    lastLoad = {
      source: restored.source,
      bytes: restored.bytes,
      ms: Math.round((performance.now() - startedAt) * 100) / 100,
    }
    setMemoryState({ ready: true, entries, error: null })
    if (restored.source === 'new' || restored.migrated) {
      // 新库或刚迁移过的库：尽快把初始结构写回快照
      dirty = true
      await flushInternal()
    }
  } catch (error) {
    database = null
    initPromise = null
    setMemoryState({ ready: false, error: `记忆库初始化失败：${errorMessage(error)}` })
  }
}

/** 保证数据库可用：未初始化时懒加载；初始化失败抛错（state.error 里也有原因） */
const ensureDatabase = async (): Promise<Database> => {
  if (database) {
    return database
  }
  if (!initPromise) {
    initPromise = openStore()
  }
  const pending = initPromise
  await pending
  if (!database) {
    throw new Error(state.error ?? '记忆库不可用')
  }
  return database
}

export const initMemory = async (enabled: boolean): Promise<void> => {
  setMemoryState({ enabled })
  try {
    await ensureDatabase()
  } catch {
    // openStore 已把错误写进 state.error；初始化失败不在这里抛出，交给 UI 显示
  }
}

export const setMemoryEnabled = async (enabled: boolean): Promise<void> => {
  setMemoryState({ enabled })
  if (typeof localStorage === 'undefined') {
    return
  }
  try {
    localStorage.setItem(MEMORY_ENABLED_STORAGE_KEY, String(enabled))
  } catch {
    // 存储不可用时只在内存中生效
  }
}

// ------------------------------------------------------------------ 读写 API

export const listMemories = async (limit = DEFAULT_LIST_LIMIT): Promise<MemoryEntry[]> => {
  const db = await ensureDatabase()
  const entries = selectRecentEntries(db, clampLimit(limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT))
  setMemoryState({ entries })
  return entries
}

export const searchMemories = async (input: MemorySearchInput): Promise<MemoryEntry[]> => {
  const db = await ensureDatabase()
  const limit = clampLimit(input.limit, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT)
  const query = typeof input.query === 'string' ? input.query.trim() : ''
  const terms = query
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 4)
  const tagFilters = normalizeTags(input.tags)
  const section = input.section?.trim()

  const where: string[] = ["e.status = 'active'"]
  const scoreParts: string[] = []
  const scoreParams: SqlValue[] = []
  const whereParams: SqlValue[] = []

  for (const term of terms) {
    const pattern = `%${escapeLike(term)}%`
    // SELECT 里的打分表达式先于 WHERE 出现，绑定参数顺序必须先 score 后 where
    scoreParts.push(
      `(CASE WHEN e.content LIKE ? ESCAPE '\\' THEN 2 ELSE 0 END` +
        ` + CASE WHEN EXISTS (SELECT 1 FROM entry_tags st` +
        ` WHERE st.entry_id = e.id AND st.tag LIKE ? ESCAPE '\\') THEN 1 ELSE 0 END)`
    )
    scoreParams.push(pattern, pattern)
    where.push(
      `(e.content LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM entry_tags wt` +
        ` WHERE wt.entry_id = e.id AND wt.tag LIKE ? ESCAPE '\\'))`
    )
    whereParams.push(pattern, pattern)
  }

  // tags 之间是 AND：每个 tag 都必须精确命中
  for (const tag of tagFilters) {
    where.push(`EXISTS (SELECT 1 FROM entry_tags ft WHERE ft.entry_id = e.id AND ft.tag = ?)`)
    whereParams.push(tag)
  }

  if (section) {
    where.push('e.section_key = ?')
    whereParams.push(section)
  }

  const scoreSql = scoreParts.length > 0 ? scoreParts.join(' + ') : '0'
  return selectEntries(
    db,
    `SELECT e.id AS id, e.section_key AS section_key, e.content AS content,
            e.created_at AS created_at, (${scoreSql}) AS score
       FROM entries e
      WHERE ${where.join(' AND ')}
      ORDER BY score DESC, e.created_at DESC, e.id DESC
      LIMIT ?`,
    [...scoreParams, ...whereParams, limit]
  )
}

export const writeMemory = async (input: MemoryWriteInput): Promise<MemoryEntry> => {
  const db = await ensureDatabase()
  const content = typeof input.content === 'string' ? input.content.trim() : ''
  if (!content) {
    throw new Error('记忆内容不能为空')
  }
  const section = resolveSection(input.section)
  const tags = normalizeTags(input.tags)
  const createdAt = Date.now()

  const entry = inTransaction(db, () => {
    const id = nextEntryId(db, createdAt)
    runSql(
      db,
      `INSERT INTO entries(id, section_key, content, status, created_at)
       VALUES (?, ?, ?, 'active', ?)`,
      [id, section, content, createdAt]
    )
    const statement = db.prepare('INSERT OR IGNORE INTO entry_tags(entry_id, tag) VALUES (?, ?)')
    try {
      for (const tag of tags) {
        statement.run([id, tag])
      }
    } finally {
      statement.free()
    }
    return { id, section, content, tags, createdAt }
  })

  scheduleSave()
  setMemoryState({ entries: [entry, ...state.entries].slice(0, MAX_LIST_LIMIT) })
  return entry
}

/** 软删除：只把 status 改成 archived，不 DELETE，保留可追溯性 */
export const removeMemory = async (id: string): Promise<void> => {
  const db = await ensureDatabase()
  runSql(db, `UPDATE entries SET status = 'archived' WHERE id = ? AND status = 'active'`, [id])
  scheduleSave()
  setMemoryState({ entries: state.entries.filter((entry) => entry.id !== id) })
}

export const flushMemory = async (): Promise<void> => {
  await flushInternal()
}

// ------------------------------------------------------------------ 统计（可选）

export type MemoryStats = {
  ready: boolean
  enabled: boolean
  source: DatabaseLoadSource | null
  entries: number
  archived: number
  tags: number
  dbBytes: number | null
  pendingDirty: boolean
  lastLoad: { source: DatabaseLoadSource; bytes: number; ms: number } | null
  lastSave: { bytes: number; ms: number; at: number } | null
}

/** 条数与库字节；`dbBytes` 为最近一次成功落盘的快照大小（未保存过为 null） */
export const getMemoryStats = async (): Promise<MemoryStats> => {
  if (!database) {
    return {
      ready: false,
      enabled: state.enabled,
      source: null,
      entries: 0,
      archived: 0,
      tags: 0,
      dbBytes: null,
      pendingDirty: false,
      lastLoad,
      lastSave,
    }
  }
  const db = database
  const activeRow = selectOne(db, `SELECT COUNT(*) AS n FROM entries WHERE status = 'active'`)
  const archivedRow = selectOne(db, `SELECT COUNT(*) AS n FROM entries WHERE status = 'archived'`)
  const tagRow = selectOne(db, 'SELECT COUNT(DISTINCT tag) AS n FROM entry_tags')
  return {
    ready: state.ready,
    enabled: state.enabled,
    source: loadedSource,
    entries: activeRow ? asNumber(activeRow.n) : 0,
    archived: archivedRow ? asNumber(archivedRow.n) : 0,
    tags: tagRow ? asNumber(tagRow.n) : 0,
    dbBytes: lastSave?.bytes ?? null,
    pendingDirty: dirty,
    lastLoad,
    lastSave,
  }
}

// ------------------------------------------------------------------ 模型工具执行

class ToolArgumentsError extends Error {
  field: string

  constructor(field: string, message: string) {
    super(message)
    this.name = 'ToolArgumentsError'
    this.field = field
  }
}

const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }
  return value as Record<string, unknown>
}

const readRequiredString = (record: Record<string, unknown>, field: string): string => {
  const value = record[field]
  if (typeof value !== 'string') {
    throw new ToolArgumentsError(field, `${field} 必须是字符串`)
  }
  return value
}

const readOptionalTags = (record: Record<string, unknown>): string[] => {
  const value = record.tags
  if (value === undefined || value === null) {
    return []
  }
  if (!Array.isArray(value)) {
    throw new ToolArgumentsError('tags', 'tags 必须是字符串数组')
  }
  if (value.length > TOOL_TAG_MAX_ITEMS) {
    throw new ToolArgumentsError('tags', `tags 最多 ${TOOL_TAG_MAX_ITEMS} 个`)
  }
  const tags: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') {
      throw new ToolArgumentsError('tags', 'tags 的每一项必须是字符串')
    }
    const tag = item.trim()
    if (!tag) {
      throw new ToolArgumentsError('tags', 'tags 的每一项不能为空')
    }
    if (tag.length > TOOL_TAG_MAX_CHARS) {
      throw new ToolArgumentsError('tags', `每个 tag 最多 ${TOOL_TAG_MAX_CHARS} 个字符`)
    }
    tags.push(tag)
  }
  return normalizeTags(tags)
}

const readOptionalSection = (record: Record<string, unknown>): string | undefined => {
  const value = record.section
  if (value === undefined || value === null) {
    return undefined
  }
  if (typeof value !== 'string') {
    throw new ToolArgumentsError('section', 'section 必须是字符串')
  }
  const section = value.trim()
  if (!section) {
    return undefined
  }
  if (!KNOWN_SECTIONS.has(section)) {
    throw new ToolArgumentsError('section', `未知记忆分区：${section}`)
  }
  return section
}

const readOptionalLimit = (record: Record<string, unknown>): number => {
  const value = record.limit
  if (value === undefined || value === null) {
    return DEFAULT_SEARCH_LIMIT
  }
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ToolArgumentsError('limit', 'limit 必须是整数')
  }
  if (value < 1 || value > MAX_SEARCH_LIMIT) {
    throw new ToolArgumentsError('limit', `limit 必须在 1-${MAX_SEARCH_LIMIT} 之间`)
  }
  return value
}

const toolError = (code: string, message: string, field?: string): string =>
  JSON.stringify({ ok: false, error: { code, message, ...(field ? { field } : {}) } })

const toolResult = (payload: Record<string, unknown>): string =>
  JSON.stringify({ ok: true, ...payload })

const ensureToolDatabase = async (): Promise<Database | null> => {
  try {
    return await ensureDatabase()
  } catch {
    return null
  }
}

const runWriteTool = async (args: unknown): Promise<string> => {
  const record = asRecord(args)
  if (!record) {
    throw new ToolArgumentsError('arguments', '参数必须是对象')
  }
  const content = readRequiredString(record, 'content').trim()
  if (!content) {
    throw new ToolArgumentsError('content', 'content 不能为空')
  }
  if (content.length > TOOL_CONTENT_MAX_CHARS) {
    throw new ToolArgumentsError('content', `content 最多 ${TOOL_CONTENT_MAX_CHARS} 个字符`)
  }
  const tags = readOptionalTags(record)
  const section = readOptionalSection(record)
  if (!state.enabled) {
    return toolError('memory_disabled', '记忆功能未启用')
  }
  const db = await ensureToolDatabase()
  if (!db) {
    return toolError('memory_unavailable', state.error ?? '记忆库不可用')
  }
  const entry = await writeMemory({ content, tags, section })
  return toolResult({ tool: 'memory_write', id: entry.id, entry })
}

const runSearchTool = async (args: unknown): Promise<string> => {
  const record = asRecord(args)
  if (!record) {
    throw new ToolArgumentsError('arguments', '参数必须是对象')
  }
  const query = readRequiredString(record, 'query')
  if (query.length > TOOL_QUERY_MAX_CHARS) {
    throw new ToolArgumentsError('query', `query 最多 ${TOOL_QUERY_MAX_CHARS} 个字符`)
  }
  const tags = readOptionalTags(record)
  const section = readOptionalSection(record)
  const limit = readOptionalLimit(record)
  if (!state.enabled) {
    return toolError('memory_disabled', '记忆功能未启用')
  }
  const db = await ensureToolDatabase()
  if (!db) {
    return toolError('memory_unavailable', state.error ?? '记忆库不可用')
  }
  const results = await searchMemories({ query, tags, section, limit })
  return toolResult({ tool: 'memory_search', count: results.length, results })
}

/**
 * 执行模型发起的记忆工具调用，返回 JSON 字符串。
 * - 未知工具 / 非法参数 / 记忆未启用 / 库不可用都返回结构化错误，不抛未捕获异常；
 * - 参数上限与 MEMORY_TOOLS 的 schema 一致：content ≤ 2KB、tags ≤ 4 个且每个 ≤ 32 字、
 *   query ≤ 200 字、limit 1-20。
 */
export const runMemoryTool = async (name: string, args: unknown = {}): Promise<string> => {
  try {
    if (name === 'memory_write') {
      return await runWriteTool(args)
    }
    if (name === 'memory_search') {
      return await runSearchTool(args)
    }
    return toolError('unknown_tool', `未知记忆工具：${name}`)
  } catch (error) {
    if (error instanceof ToolArgumentsError) {
      return toolError('invalid_args', error.message, error.field)
    }
    return toolError('internal', errorMessage(error))
  }
}
