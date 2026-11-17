/**
 * 记忆库快照的 IndexedDB 持久化。
 *
 * 设计（与方案报告一致）：
 * - 整个库以 `db.export()` 的字节快照保存，而不是逐行写 IDB；写入必须防抖/批量。
 * - 双槽轮换：`main` 是最近一次成功保存，`main-prev` 是上一次的 `main`。
 *   两个 key 在**同一个 readwrite 事务**里更新，要么都成功、要么都不变。
 * - 启动时先校验 `main`，坏库（quick_check 失败 / 迁移失败）回退 `main-prev`，
 *   再不行才新建空库；坏快照不会在恢复过程中被静默覆盖。
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb'

export const SNAPSHOT_DB_NAME = 'dslike-memory'
export const SNAPSHOT_STORE_NAME = 'snapshots'
export const SNAPSHOT_KEY_MAIN = 'main'
export const SNAPSHOT_KEY_PREVIOUS = 'main-prev'
export const SNAPSHOT_FORMAT_VERSION = 1

/** 一条整库快照 */
export type MemorySnapshot = {
  /** 快照格式版本（与 SQLite 的 user_version 无关） */
  v: typeof SNAPSHOT_FORMAT_VERSION
  /** db.export() 的整库字节 */
  bytes: Uint8Array
  /** 写入时间（Unix 毫秒） */
  savedAt: number
}

export type SnapshotPair = {
  main?: MemorySnapshot
  previous?: MemorySnapshot
}

interface MemorySnapshotDB extends DBSchema {
  snapshots: { key: string; value: MemorySnapshot }
}

let dbPromise: Promise<IDBPDatabase<MemorySnapshotDB>> | null = null

const getSnapshotDB = (): Promise<IDBPDatabase<MemorySnapshotDB>> =>
  (dbPromise ??= openDB<MemorySnapshotDB>(SNAPSHOT_DB_NAME, 1, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(SNAPSHOT_STORE_NAME)) {
        // out-of-line key：key 用 'main' / 'main-prev'
        db.createObjectStore(SNAPSHOT_STORE_NAME)
      }
    },
  }))

const isUsableSnapshot = (value: unknown): value is MemorySnapshot => {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const snapshot = value as { v?: unknown; bytes?: unknown; savedAt?: unknown }
  return (
    snapshot.v === SNAPSHOT_FORMAT_VERSION &&
    snapshot.bytes instanceof Uint8Array &&
    snapshot.bytes.byteLength > 0
  )
}

/** 读取 main / main-prev 两槽；缺失或结构不对的槽当没有 */
export const loadSnapshotPair = async (): Promise<SnapshotPair> => {
  const db = await getSnapshotDB()
  const [main, previous] = await Promise.all([
    db.get(SNAPSHOT_STORE_NAME, SNAPSHOT_KEY_MAIN),
    db.get(SNAPSHOT_STORE_NAME, SNAPSHOT_KEY_PREVIOUS),
  ])
  return {
    main: isUsableSnapshot(main) ? main : undefined,
    previous: isUsableSnapshot(previous) ? previous : undefined,
  }
}

/**
 * 单事务写入 new main，并把上一份已知可用的 main 轮换到 main-prev。
 * `previous` 为 null 时删除 main-prev，避免恢复失败后残留坏槽。
 */
export const saveSnapshotPair = async (
  next: MemorySnapshot,
  previous: MemorySnapshot | null
): Promise<void> => {
  const db = await getSnapshotDB()
  const tx = db.transaction(SNAPSHOT_STORE_NAME, 'readwrite')
  tx.store.put(next, SNAPSHOT_KEY_MAIN)
  if (previous) {
    tx.store.put(previous, SNAPSHOT_KEY_PREVIOUS)
  } else {
    tx.store.delete(SNAPSHOT_KEY_PREVIOUS)
  }
  await tx.done
}
