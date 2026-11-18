// Memory schema constants and migration SQL (src/services/memory/schema.ts):
// section anchors are stable, seeds cover SEC:00–04 in order, migrations are frozen.
import assert from 'node:assert/strict'
import { test } from 'node:test'

const schema = await import('../.test-build/services/memory/schema.js')

test('记忆分区标题与章节锚点稳定', () => {
  assert.deepEqual(schema.MEMORY_SECTION_LABELS, {
    'SEC:00': '核心事实',
    'SEC:01': '用户偏好',
    'SEC:02': '项目档案',
    'SEC:03': '长期决策',
    'SEC:04': '待办与跟进',
  })
})

test('默认分区种子按章节顺序展开，ord 与数组下标一致', () => {
  assert.deepEqual(schema.MEMORY_SECTION_SEEDS, [
    { key: 'SEC:00', title: '核心事实' },
    { key: 'SEC:01', title: '用户偏好' },
    { key: 'SEC:02', title: '项目档案' },
    { key: 'SEC:03', title: '长期决策' },
    { key: 'SEC:04', title: '待办与跟进' },
  ])
})

test('迁移数组冻结：只有 v1，schema 版本等于迁移数量', () => {
  assert.equal(schema.SCHEMA_VERSION, schema.MIGRATIONS.length)
  assert.equal(schema.SCHEMA_VERSION, 1)
  assert.equal(schema.MIGRATIONS.length, 1)
  assert.ok(schema.MIGRATIONS[0].includes('CREATE TABLE IF NOT EXISTS sections'))
  assert.ok(schema.MIGRATIONS[0].includes('CREATE TABLE IF NOT EXISTS entries'))
  assert.ok(schema.MIGRATIONS[0].includes('CREATE TABLE IF NOT EXISTS entry_tags'))
  assert.ok(schema.MIGRATIONS[0].includes('CREATE INDEX IF NOT EXISTS idx_entries_status_created'))
  assert.ok(schema.MIGRATIONS[0].includes('CREATE INDEX IF NOT EXISTS idx_entries_section_created'))
  assert.ok(schema.MIGRATIONS[0].includes('CREATE INDEX IF NOT EXISTS idx_entry_tags_tag'))
})

test('迁移 SQL 用 INSERT OR IGNORE 写入默认分区，不覆盖用户改过的标题', () => {
  const sql = schema.MIGRATIONS[0]
  assert.ok(sql.includes('INSERT OR IGNORE INTO sections(section_key, title, ord) VALUES'))
  for (const [index, section] of schema.MEMORY_SECTION_SEEDS.entries()) {
    assert.ok(sql.includes(`('${section.key}', '${section.title}', ${index})`), section.key)
  }
  // entries.status 默认 active 即软删除语义
  assert.ok(sql.includes("status TEXT DEFAULT 'active'"))
})
