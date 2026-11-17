/**
 * sql.js 的懒加载，以及数据库的打开 / 校验 / 迁移 / 快照回退。
 *
 * 浏览器侧固定用 browser 构建（`import initSqlJs from 'sql.js'` 在 rspack 的 web target 下
 * 走 package.json 的 `browser` 条件 → `dist/sql-wasm-browser.js`），它配套的 wasm 是
 * `dist/sql-wasm-browser.wasm`（已在 web/node_modules/sql.js/dist 下核对过文件名与体积）。
 * rspack 用 `asset/resource` 把 wasm 输出成带哈希的静态资源，`import wasmUrl from '...'`
 * 拿到的就是该资源的 URL；sql.js 用 `locateFile` 把它交给 Emscripten（先试
 * `instantiateStreaming`，MIME 不对或协议不支持 fetch 时自动退回 ArrayBuffer 实例化）。
 *
 * 加载顺序：main 快照 → main-prev 快照 → 新建空库；每个候选先跑 `PRAGMA quick_check`，
 * 校验或迁移失败就换下一个，绝不静默接受坏库。
 */
import initSqlJs from 'sql.js'
import type { Database, SqlJsStatic } from 'sql.js'
import wasmUrl from 'sql.js/dist/sql-wasm-browser.wasm'
import { MIGRATIONS, SCHEMA_VERSION } from './schema.js'

/** 数据库来源：main / main-prev 快照，或全新库 */
export type DatabaseLoadSource = 'main' | 'main-prev' | 'new'

export type OpenDatabaseResult = {
  db: Database
  /** 本次打开是否执行过迁移（迁移后需要尽快把新结构写回快照） */
  migrated: boolean
}

export type RestoredDatabase = {
  db: Database
  /** 实际从哪个快照恢复；'new' 表示没有可用快照 */
  source: DatabaseLoadSource
  /** 恢复来源的字节数（新建库为 0） */
  bytes: number
  /** 是否执行过 schema 迁移 */
  migrated: boolean
}

/** 快照候选；缺省或空字节表示该槽没有可用快照 */
export type SnapshotCandidates = {
  main?: Uint8Array | null
  previous?: Uint8Array | null
}

let sqlPromise: Promise<SqlJsStatic> | null = null

/** 懒加载 sql.js（只在第一次初始化时加载 wasm） */
export const loadSqlJs = (): Promise<SqlJsStatic> => {
  sqlPromise ??= initSqlJs({ locateFile: () => wasmUrl })
  return sqlPromise
}

/** 读 schema 版本（PRAGMA user_version） */
export const readSchemaVersion = (db: Database): number => {
  const result = db.exec('PRAGMA user_version;')
  const value = result[0]?.values[0]?.[0]
  return typeof value === 'number' ? value : Number(value ?? 0)
}

/** 完整性体检：返回 PRAGMA quick_check 的首个结果（正常为 'ok'） */
export const quickCheck = (db: Database): string => {
  const result = db.exec('PRAGMA quick_check;')
  const value = result[0]?.values[0]?.[0]
  return typeof value === 'string' ? value : String(value ?? '')
}

/** 执行待应用的迁移；每个版本一个事务，失败回滚并抛出 */
export const migrate = (db: Database): number => {
  const from = readSchemaVersion(db)
  for (let version = from; version < MIGRATIONS.length; version += 1) {
    const migration = MIGRATIONS[version]
    if (migration === undefined) {
      throw new Error(`缺少 schema 迁移：v${version + 1}`)
    }
    db.exec('BEGIN')
    try {
      db.exec(migration)
      db.exec(`PRAGMA user_version = ${version + 1};`)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  return SCHEMA_VERSION
}

/**
 * 打开（或按字节恢复）记忆库并迁移到当前版本。
 * 传入字节时先做 quick_check；校验或迁移失败会关闭库并抛出，由调用方回退到下一个快照。
 */
export const openMemoryDatabase = (
  SQL: SqlJsStatic,
  bytes?: Uint8Array | null
): OpenDatabaseResult => {
  const db = new SQL.Database(bytes ?? undefined)
  try {
    if (bytes && bytes.byteLength > 0) {
      const check = quickCheck(db)
      if (check !== 'ok') {
        throw new Error(`quick_check 未通过：${check}`)
      }
    }
    const versionBefore = readSchemaVersion(db)
    migrate(db)
    return { db, migrated: versionBefore < SCHEMA_VERSION }
  } catch (error) {
    db.close()
    throw error
  }
}

/**
 * 按优先级恢复数据库：main → main-prev → 新建。
 * 交给 store 判断是否允许把旧 main 轮换进 main-prev（只有 main 本身可用时才轮换，
 * 避免坏 main 覆盖掉好的 main-prev）。
 */
export const openMemoryDatabaseFromSnapshots = (
  SQL: SqlJsStatic,
  candidates: SnapshotCandidates
): RestoredDatabase => {
  const { main, previous } = candidates
  if (main && main.byteLength > 0) {
    try {
      const opened = openMemoryDatabase(SQL, main)
      return { db: opened.db, source: 'main', bytes: main.byteLength, migrated: opened.migrated }
    } catch {
      // main 不可用，继续尝试 main-prev；坏快照保持原样，等下一次成功保存再覆盖
    }
  }
  if (previous && previous.byteLength > 0) {
    try {
      const opened = openMemoryDatabase(SQL, previous)
      return {
        db: opened.db,
        source: 'main-prev',
        bytes: previous.byteLength,
        migrated: opened.migrated,
      }
    } catch {
      // main-prev 也不可用，只能新建库
    }
  }
  const opened = openMemoryDatabase(SQL)
  return { db: opened.db, source: 'new', bytes: 0, migrated: opened.migrated }
}
