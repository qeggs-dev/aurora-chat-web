// 版本比较（src/services/update/version.ts）：semver 解析、v 前缀、预发布排序与非法输入。
import assert from 'node:assert/strict'
import { test } from 'node:test'

const version = await import('../.test-build/services/update/version.js')

test('parseVersion：忽略 v/V 前缀，忽略 build metadata，解析预发布', () => {
  assert.deepEqual(version.parseVersion('v0.3.17'), { major: 0, minor: 3, patch: 17, prerelease: [] })
  assert.deepEqual(version.parseVersion('V1.2.3'), { major: 1, minor: 2, patch: 3, prerelease: [] })
  assert.deepEqual(version.parseVersion(' 2.0.0+build.5  '), {
    major: 2,
    minor: 0,
    patch: 0,
    prerelease: [],
  })
  assert.deepEqual(version.parseVersion('1.2.3-beta.1'), {
    major: 1,
    minor: 2,
    patch: 3,
    prerelease: ['beta', '1'],
  })
  assert.equal(version.parseVersion('1.2'), null)
  assert.equal(version.parseVersion('1.2.3.4'), null)
  assert.equal(version.parseVersion('abc'), null)
  assert.equal(version.parseVersion('1.2.3-'), null)
  assert.equal(version.parseVersion(''), null)
})

test('compareVersions：主次修订号与预发布语义', () => {
  assert.equal(version.compareVersions('v0.3.17', '0.3.17'), 0)
  assert.equal(version.compareVersions('0.3.18', 'v0.3.17'), 1)
  assert.equal(version.compareVersions('0.3.16', '0.3.17'), -1)
  assert.equal(version.compareVersions('0.10.0', '0.9.9'), 1)
  assert.equal(version.compareVersions('1.0.0', '1.0.0-beta'), 1)
  assert.equal(version.compareVersions('1.0.0-beta.2', '1.0.0-beta.10'), -1)
  assert.equal(version.compareVersions('1.0.0-beta.1', '1.0.0-alpha.9'), 1)
  // 非法版本不能静默当相等
  assert.equal(version.compareVersions('0.3.17', 'latest'), null)
  assert.equal(version.compareVersions('', '0.3.17'), null)
})

test('isNewerVersion / readApplicationVersion', () => {
  assert.equal(version.isNewerVersion('v0.3.18', '0.3.17'), true)
  assert.equal(version.isNewerVersion('0.3.17', 'v0.3.17'), false)
  assert.equal(version.isNewerVersion('0.3.16', '0.3.17'), false)
  assert.equal(version.isNewerVersion('nope', '0.3.17'), false)
  // node:test 里没有 document：读不到版本时返回空串而不是抛错
  assert.equal(version.readApplicationVersion(), '')
})
