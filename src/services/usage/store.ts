/** 每次请求的用量记录：IndexedDB 追加 + 内存里的最近列表，供设置页统计。 */
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

export type UsageTotals = {
  requests: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  total: number
}

export type UsageState = {
  ready: boolean
  records: UsageRecord[]
}

interface UsageDB extends DBSchema {
  events: { key: string; value: UsageRecord; indexes: { createdAt: number } }
}

let promise: Promise<IDBPDatabase<UsageDB>> | null = null

const getDB = () =>
  (promise ??= openDB<UsageDB>('dslike-usage', 1, {
    upgrade(db) {
      if (!db.objectStoreNames.contains('events')) {
        const store = db.createObjectStore('events', { keyPath: 'id' })
        store.createIndex('createdAt', 'createdAt')
      }
    },
  }))

const MAX_MEMORY = 200

let state: UsageState = { ready: false, records: [] }
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

/** 恢复最近的记录（启动时调用一次） */
export const initUsage = async (): Promise<void> => {
  try {
    const db = await getDB()
    const all = await db.getAllFromIndex('events', 'createdAt')
    update({ ready: true, records: all.slice(-MAX_MEMORY).reverse() })
  } catch {
    update({ ready: true })
  }
}

const tid = () => `usage-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`

export const recordUsage = async (input: Omit<UsageRecord, 'id' | 'createdAt' | 'totalTokens'>): Promise<UsageRecord> => {
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
  update({ records: [record, ...state.records].slice(0, MAX_MEMORY) })
  try {
    const db = await getDB()
    await db.add('events', record)
  } catch {
    // 存储失败不影响界面上的本次统计
  }
  return record
}

export const totalsOf = (records: UsageRecord[]): UsageTotals =>
  records.reduce<UsageTotals>(
    (sum, record) => ({
      requests: sum.requests + 1,
      input: sum.input + record.inputTokens,
      output: sum.output + record.outputTokens,
      cacheRead: sum.cacheRead + record.cacheReadTokens,
      cacheWrite: sum.cacheWrite + record.cacheWriteTokens,
      total: sum.total + record.totalTokens,
    }),
    { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  )

export const useUsageState = (): UsageState => state

export const listUsage = async (limit = 20): Promise<UsageRecord[]> => {
  try {
    const db = await getDB()
    const all = await db.getAllFromIndex('events', 'createdAt')
    return all.slice(-limit).reverse()
  } catch {
    return state.records.slice(0, limit)
  }
}

export const clearUsage = async (): Promise<void> => {
  update({ records: [] })
  try {
    const db = await getDB()
    await db.clear('events')
  } catch {
    // 忽略
  }
}
