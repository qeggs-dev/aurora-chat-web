// Shared streaming ZIP reader (src/services/zip/reader.ts): preset / style importers both rely on
// it to decompress entry by entry and abort before a declared oversized entry is inflated.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { strToU8, zipSync } from 'fflate'

const { ZipReadError, readZipEntries } = await import('../.test-build/services/zip/reader.js')

const LIMITS = { maxEntries: 10, maxEntryBytes: 1024, maxTotalBytes: 4096 }

const stats = () => ({ discovered: [], decompressed: [], totalBytes: 0 })

const expectZipError = (fn, code) => {
  assert.throws(
    fn,
    (error) => {
      assert.ok(error instanceof ZipReadError, `expected ZipReadError, got ${error?.name}`)
      assert.equal(error.code, code)
      return true
    },
    `expected ZipReadError code ${code}`
  )
}

test('正常解压：返回每个文件条目的字节，目录条目被跳过', () => {
  const result = readZipEntries(
    zipSync({
      'a.txt': strToU8('hello'),
      'dir/': new Uint8Array(0),
      'dir/b.txt': strToU8('world'),
    }),
    LIMITS
  )
  assert.deepEqual([...result.keys()], ['a.txt', 'dir/b.txt'])
  assert.equal(new TextDecoder().decode(result.get('a.txt')), 'hello')
  assert.equal(new TextDecoder().decode(result.get('dir/b.txt')), 'world')
})

test('stored（level 0）条目与 deflate 条目都能读', () => {
  const stored = zipSync({ 'a.txt': strToU8('plain') }, { level: 0 })
  assert.equal(new TextDecoder().decode(readZipEntries(stored, LIMITS).get('a.txt')), 'plain')
  const deflated = zipSync({ 'a.txt': strToU8('x'.repeat(500)) })
  assert.equal(readZipEntries(deflated, LIMITS).get('a.txt').length, 500)
})

test('声明大小超限的 zip 被拒，且超限条目没有被解压', () => {
  // 第二个条目声明 5000 字节：超过单条目上限，解压器必须在 start() 之前拒绝它
  const data = zipSync({
    'ok.txt': strToU8('hi'),
    'bomb.bin': new Uint8Array(5000),
  })
  const seen = stats()
  expectZipError(
    () =>
      readZipEntries(
        data,
        { maxEntries: 10, maxEntryBytes: 4096, maxTotalBytes: 1024 * 1024 },
        seen
      ),
    'tooLarge'
  )
  // 发现到 bomb.bin，但没有解压它；前面的 ok.txt 已经正常解压
  assert.deepEqual(seen.discovered, ['ok.txt', 'bomb.bin'])
  assert.deepEqual(seen.decompressed, ['ok.txt'])
  assert.equal(seen.totalBytes, 2)
})

test('声明总量超限时同样在解压前中止', () => {
  const data = zipSync({
    'a.bin': new Uint8Array(3000),
    'b.bin': new Uint8Array(3000),
  })
  const seen = stats()
  expectZipError(
    () => readZipEntries(data, { maxEntries: 10, maxEntryBytes: 4096, maxTotalBytes: 4096 }, seen),
    'tooLarge'
  )
  // 第一个条目解压后已累计 3000；第二个条目声明后总量将超限 → 没有解压第二个
  assert.deepEqual(seen.decompressed, ['a.bin'])
})

test('解压过程中实际字节超过单条目上限也立即中止', () => {
  const data = zipSync({ 'a.txt': strToU8('abcdefgh') })
  const seen = stats()
  // 声明大小 8 未超限（限额写成 3 时由 ondata 累计触发）
  expectZipError(
    () => readZipEntries(data, { maxEntries: 10, maxEntryBytes: 3, maxTotalBytes: 4096 }, seen),
    'tooLarge'
  )
  assert.deepEqual(seen.decompressed, [])
})

test('文件条目数超限 → tooManyFiles（目录条目不计数）', () => {
  const entries = { 'dir/': new Uint8Array(0) }
  for (let index = 0; index < 4; index += 1) {
    entries[`f${index}.txt`] = strToU8('x')
  }
  expectZipError(() => readZipEntries(zipSync(entries), { ...LIMITS, maxEntries: 3 }), 'tooManyFiles')
})

test('非 zip / 空数据 → notZip', () => {
  expectZipError(() => readZipEntries(strToU8('not a zip'), LIMITS), 'notZip')
  expectZipError(() => readZipEntries(new Uint8Array(0), LIMITS), 'notZip')
  expectZipError(() => readZipEntries(new Uint8Array([0x50, 0x4b, 3, 4]), LIMITS), 'notZip')
})
