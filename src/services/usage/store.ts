/**
 * 用量数据的两份本地存储（IndexedDB `dslike-usage`，DB 版本 2）：
 * - `events`：append-only 的请求日志，一次请求一条 UsageRecord，只由「清理日志」删除；
 * - `stats`：单条累计统计（key 固定 `totals`），供设置页显示；记录用量时在同一事务里累加。
 *
 * 两份数据分开存的意义：清掉请求日志后累计统计仍然保留，统计也不再受内存 200 条上限影响。
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb'

export type UsageProtocol = 'anthropic' | 'openai' | 'responses'

export type UsageRecord = {
  id: string
  sessionId: string | null
  messageId: string
  protocol: UsageProtocol
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalTokens: number
  /** 推理（思考）token */
  reasoningTokens?: number
  /** 本轮服务端搜索次数 */
  searchCount?: number
  /** 安全审查消耗的 token（协议提供时才有） */
  safetyTokens?: number
  /** 本次请求耗时（毫秒），用于估算生成速率 */
  durationMs?: number
  createdAt: number
}

/** `stats/totals` 的累计统计结构，也是内存里 `state.totals` 的结构 */
export type UsageTotals = {
  requests: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  searchCount: number
  safetyTokens: number
  durationMs: number
  totalTokens: number
  updatedAt: number
}

export type UsageState = {
  ready: boolean
  /** 内存里只保留最近 MAX_MEMORY 条，供最近请求列表显示 */
  records: UsageRecord[]
  /** 累计统计：界面统计面板读它，不再从 records 求和 */
  totals: UsageTotals
}

interface UsageDB extends DBSchema {
  events: { key: string; value: UsageRecord; indexes: { createdAt: number } }
  stats: { key: string; value: UsageTotals }
}

const DB_NAME = 'dslike-usage'
/** v1：只有 events；v2：新增 stats（累计统计） */
const DB_VERSION = 2
/** stats 里唯一那条累计统计的 key */
const TOTALS_KEY = 'totals'

const MAX_MEMORY = 200

/** 全零的累计统计。updatedAt 也归零，可用于「全部置零」之后的比对。 */
export const emptyUsageTotals = (): UsageTotals => ({
  requests: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  searchCount: 0,
  safetyTokens: 0,
  durationMs: 0,
  totalTokens: 0,
  updatedAt: 0,
})

/** 累计统计是否全零（updatedAt 不参与判断） */
export const isUsageTotalsEmpty = (totals: UsageTotals): boolean =>
  totals.requests === 0 &&
  totals.inputTokens === 0 &&
  totals.outputTokens === 0 &&
  totals.cacheReadTokens === 0 &&
  totals.cacheWriteTokens === 0 &&
  totals.reasoningTokens === 0 &&
  totals.searchCount === 0 &&
  totals.safetyTokens === 0 &&
  totals.durationMs === 0 &&
  totals.totalTokens === 0

/** 把一条请求记录累加进累计统计 */
const addToTotals = (totals: UsageTotals, record: UsageRecord): UsageTotals => ({
  requests: totals.requests + 1,
  inputTokens: totals.inputTokens + record.inputTokens,
  outputTokens: totals.outputTokens + record.outputTokens,
  cacheReadTokens: totals.cacheReadTokens + record.cacheReadTokens,
  cacheWriteTokens: totals.cacheWriteTokens + record.cacheWriteTokens,
  reasoningTokens: totals.reasoningTokens + (record.reasoningTokens ?? 0),
  searchCount: totals.searchCount + (record.searchCount ?? 0),
  safetyTokens: totals.safetyTokens + (record.safetyTokens ?? 0),
  durationMs: totals.durationMs + (record.durationMs ?? 0),
  totalTokens: totals.totalTokens + record.totalTokens,
  updatedAt: Date.now(),
})

/**
 * 对一批记录求和（保留给 v1→v2 回填与测试用）。
 * 时间戳取这批记录里最晚的 createdAt，保证同一批记录得到确定结果。
 */
export const totalsOf = (records: UsageRecord[]): UsageTotals =>
  records.reduce<UsageTotals>(
    (sum, record) => ({
      requests: sum.requests + 1,
      inputTokens: sum.inputTokens + record.inputTokens,
      outputTokens: sum.outputTokens + record.outputTokens,
      cacheReadTokens: sum.cacheReadTokens + record.cacheReadTokens,
      cacheWriteTokens: sum.cacheWriteTokens + record.cacheWriteTokens,
      reasoningTokens: sum.reasoningTokens + (record.reasoningTokens ?? 0),
      searchCount: sum.searchCount + (record.searchCount ?? 0),
      safetyTokens: sum.safetyTokens + (record.safetyTokens ?? 0),
      durationMs: sum.durationMs + (record.durationMs ?? 0),
      totalTokens: sum.totalTokens + record.totalTokens,
      updatedAt: Math.max(sum.updatedAt, record.createdAt),
    }),
    emptyUsageTotals()
  )

let promise: Promise<IDBPDatabase<UsageDB>> | null = null

/**
 * 打开数据库并在打开后回填一次 stats：
 * v1 → v2 升级时只建空的 stats store（升级事务里做异步读取不可靠），
 * 打开成功后若 `stats` 里没有 totals，就用现有 events 求和写入，升级不丢 events。
 */
const getDB = (): Promise<IDBPDatabase<UsageDB>> => {
  promise ??= openDB<UsageDB>(DB_NAME, DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains('events')) {
        const store = db.createObjectStore('events', { keyPath: 'id' })
        store.createIndex('createdAt', 'createdAt')
      }
      if (!db.objectStoreNames.contains('stats')) {
        db.createObjectStore('stats')
      }
    },
  }).then(async (db) => {
    try {
      const stored = await db.get('stats', TOTALS_KEY)
      if (!stored) {
        const all = await db.getAllFromIndex('events', 'createdAt')
        await db.put('stats', totalsOf(all), TOTALS_KEY)
      }
    } catch {
      // 回填失败不阻塞使用；initUsage 里还有一次兜底
    }
    return db
  })
  return promise
}

let state: UsageState = { ready: false, records: [], totals: emptyUsageTotals() }
const listeners = new Set<() => void>()
const emit = () => {
  for (const listener of listeners) {
    listener()
  }
}

export const subscribeUsage = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export const getUsageState = (): UsageState => state

const update = (patch: Partial<UsageState>) => {
  state = { ...state, ...patch }
  emit()
}

/** 恢复累计统计与最近的请求记录（启动时调用一次） */
export const initUsage = async (): Promise<void> => {
  try {
    const db = await getDB()
    const all = await db.getAllFromIndex('events', 'createdAt')
    let totals = await db.get('stats', TOTALS_KEY)
    if (!totals) {
      // 正常路径已在 getDB 打开时回填，这里兜底（例如回填失败后重启）
      totals = totalsOf(all)
      await db.put('stats', totals, TOTALS_KEY)
    }
    update({ ready: true, records: all.slice(-MAX_MEMORY).reverse(), totals })
  } catch {
    update({ ready: true })
  }
}

const tid = () => `usage-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`

/**
 * 记一条用量：单个读写事务里追加 events + 读改写 stats（事务内 get→put），
 * 同一事务保证两个 store 原子更新，readwrite 事务在同一 scope 上串行化，不会丢更新。
 * 签名保持不变（调用方仍是 `recordUsage({...})`）。
 */
export const recordUsage = async (
  input: Omit<UsageRecord, 'id' | 'createdAt' | 'totalTokens'>
): Promise<UsageRecord> => {
  const total = input.inputTokens + input.outputTokens
  const existing = state.records.find(
    (item) => item.messageId === input.messageId && item.totalTokens === total
  )
  if (existing) {
    return existing
  }
  const record: UsageRecord = {
    ...input,
    id: tid(),
    createdAt: Date.now(),
    totalTokens: total,
  }
  try {
    const db = await getDB()
    const tx = db.transaction(['events', 'stats'], 'readwrite')
    const stats = tx.objectStore('stats')
    const current = (await stats.get(TOTALS_KEY)) ?? emptyUsageTotals()
    const totals = addToTotals(current, record)
    await tx.objectStore('events').add(record)
    await stats.put(totals, TOTALS_KEY)
    await tx.done
    update({ records: [record, ...state.records].slice(0, MAX_MEMORY), totals })
  } catch {
    // 存储失败不影响界面上的本次统计
    update({
      records: [record, ...state.records].slice(0, MAX_MEMORY),
      totals: addToTotals(state.totals, record),
    })
  }
  return record
}

export const useUsageState = (): UsageState => state

/** 最近请求列表：仍直接读 events（按 createdAt 升序后取最后 limit 条） */
export const listUsage = async (limit = 20): Promise<UsageRecord[]> => {
  try {
    const db = await getDB()
    const all = await db.getAllFromIndex('events', 'createdAt')
    return all.slice(-limit).reverse()
  } catch {
    return state.records.slice(0, limit)
  }
}

/** 全部请求日志（按 createdAt 升序），供导出使用；不受内存 200 条限制 */
export const listAllUsage = async (): Promise<UsageRecord[]> => {
  const db = await getDB()
  return db.getAllFromIndex('events', 'createdAt')
}

/**
 * 只清理请求日志：删除全部 events（含内存 records），累计统计 stats/totals 原样保留。
 * 失败时抛错，由界面提示；内存状态只在成功后更新。
 */
export const clearUsageLog = async (): Promise<void> => {
  const db = await getDB()
  const tx = db.transaction('events', 'readwrite')
  await tx.store.clear()
  await tx.done
  update({ records: [] })
}

/**
 * 全部置零：删除全部 events，并把 stats/totals 写成全零（updatedAt 也归零）。
 * 不可恢复；失败时抛错，由界面提示。
 */
export const resetUsageStats = async (): Promise<void> => {
  const totals = emptyUsageTotals()
  const db = await getDB()
  const tx = db.transaction(['events', 'stats'], 'readwrite')
  await Promise.all([
    tx.objectStore('events').clear(),
    tx.objectStore('stats').put(totals, TOTALS_KEY),
  ])
  await tx.done
  update({ records: [], totals })
}
