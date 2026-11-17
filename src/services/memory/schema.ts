/**
 * 记忆库的表结构与迁移（对齐工作区 MEMORY.db 的子集）。
 *
 * - 迁移游标用 SQLite 自带的 `PRAGMA user_version`：它跟着数据库文件走，快照里也带着，
 *   不需要另存 JSON 版本号。
 * - 迁移数组一经发布就冻结：新增结构只能往后追加一项，不能改历史项。
 * - 默认分区（SEC:00–04）只在新库或迁移时用 `INSERT OR IGNORE` 补齐，不覆盖用户改过的标题。
 */

/** 记忆分区标题；章节锚点（section_key）一经分配永不改变，见工作区 MEMORY.db 规范。 */
export const MEMORY_SECTION_LABELS: Record<string, string> = {
  'SEC:00': '核心事实',
  'SEC:01': '用户偏好',
  'SEC:02': '项目档案',
  'SEC:03': '长期决策',
  'SEC:04': '待办与跟进',
}

/** sections 表的默认行；ord 决定展示顺序 */
export const MEMORY_SECTION_SEEDS: ReadonlyArray<{ key: string; title: string }> = Object.entries(
  MEMORY_SECTION_LABELS
).map(([key, title]) => ({ key, title }))

const seedSectionsSql = MEMORY_SECTION_SEEDS.map(
  (section, ord) => `  ('${section.key}', '${section.title}', ${ord})`
).join(',\n')

/** v1：建表 + 索引 + 默认分区；entries.status 的 'active' / 'archived' 即软删除语义。 */
const MIGRATION_V1 = `
CREATE TABLE IF NOT EXISTS sections (
  section_key TEXT PRIMARY KEY,
  title TEXT,
  ord INTEGER
);

CREATE TABLE IF NOT EXISTS entries (
  id TEXT PRIMARY KEY,
  section_key TEXT,
  content TEXT,
  status TEXT DEFAULT 'active',
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS entry_tags (
  entry_id TEXT,
  tag TEXT,
  PRIMARY KEY (entry_id, tag)
);

CREATE INDEX IF NOT EXISTS idx_entries_status_created ON entries(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_entries_section_created ON entries(section_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_entry_tags_tag ON entry_tags(tag, entry_id);

INSERT OR IGNORE INTO sections(section_key, title, ord) VALUES
${seedSectionsSql};
`

/** 迁移脚本，下标即目标 user_version - 1 */
export const MIGRATIONS: ReadonlyArray<string> = [MIGRATION_V1]

/** 当前 schema 版本，等于 PRAGMA user_version 的目标值 */
export const SCHEMA_VERSION = MIGRATIONS.length
