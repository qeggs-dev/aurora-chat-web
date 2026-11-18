// 状态机与 24h 缓存（src/services/update/store.ts）：
// 用假 transport / 假下载器覆盖「检查 → 可更新 → 下载进度 → 安装 / 取消 / 错误」与缓存复用。
import assert from 'node:assert/strict'
import { test } from 'node:test'

const storeModule = await import('../.test-build/services/update/store.js')
const github = await import('../.test-build/services/update/github.js')

const CANONICAL_EXE =
  'https://github.com/qeggs-dev/aurora-chat-app/releases/download/v0.3.18/aurora-chat-0.3.18-win-x64.exe'
const CANONICAL_APK =
  'https://github.com/qeggs-dev/aurora-chat-app/releases/download/v0.3.18/aurora-chat-0.3.18-debug.apk'

const makePayload = (version = '0.3.18', assets) => ({
  tag_name: `v${version}`,
  name: `Aurora Chat v${version}`,
  published_at: '2026-11-18T08:48:48Z',
  body: 'release notes',
  assets:
    assets ??
    [
      {
        name: `aurora-chat-${version}-win-x64.exe`,
        size: 125494895,
        content_type: 'application/x-msdos-program',
        browser_download_url: CANONICAL_EXE,
      },
    ],
})

const jsonResponse = (payload) => ({
  status: 200,
  text: JSON.stringify(payload),
  contentType: 'application/json',
  headers: { rateLimitRemaining: '60', retryAfter: null },
})

const memoryStorage = () => {
  const map = new Map()
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => {
      map.set(key, String(value))
    },
    removeItem: (key) => {
      map.delete(key)
    },
  }
}

const makeEnv = (overrides = {}) => {
  let clock = 1_700_000_000_000
  let currentVersion = '0.3.17'
  let payload = makePayload()
  const calls = { transport: 0, download: 0, install: 0, opened: [], cancelled: 0 }
  const env = {
    runtime: 'desktop',
    assetPlatform: 'windows',
    now: () => clock,
    readCurrentVersion: () => currentVersion,
    resolveChannel: async () => 'release',
    transport: async () => {
      calls.transport += 1
      return jsonResponse(payload)
    },
    download: async (_asset, _candidates, onProgress) => {
      calls.download += 1
      onProgress({ received: 50, total: 100, percent: 50 })
      return { path: '/tmp/aurora-chat-0.3.18-win-x64.exe' }
    },
    install: async () => {
      calls.install += 1
      return { kind: 'installer-launched' }
    },
    cancelDownload: async () => {
      calls.cancelled += 1
    },
    openRelease: (url) => calls.opened.push(url),
    storage: memoryStorage(),
    ...overrides,
  }
  return {
    env,
    calls,
    setPayload: (next) => {
      payload = next
    },
    setVersion: (next) => {
      currentVersion = next
    },
    advance: (ms) => {
      clock += ms
    },
  }
}

test('check：有新版本 → available 且选中对应资产；同版本 → up-to-date', async () => {
  const { env } = makeEnv()
  const store = storeModule.createUpdateStore(env)
  await store.getState().check({ manual: true })
  let state = store.getState()
  assert.equal(state.status, 'available')
  assert.equal(state.release.version, '0.3.18')
  assert.equal(state.asset.name, 'aurora-chat-0.3.18-win-x64.exe')
  assert.equal(state.channel, 'release')
  assert.equal(state.fromCache, false)
  assert.equal(state.lastCheckedAt, env.now())

  const upToDate = makeEnv()
  upToDate.setPayload(makePayload('0.3.17'))
  const store2 = storeModule.createUpdateStore(upToDate.env)
  await store2.getState().check({ manual: true })
  state = store2.getState()
  assert.equal(state.status, 'up-to-date')
  assert.equal(state.asset, null)
})

test('缓存：自动检查命中 24h 缓存不再请求；手动检查忽略缓存', async () => {
  const { env, calls, advance } = makeEnv()
  const store = storeModule.createUpdateStore(env)
  await store.getState().check({ manual: true })
  assert.equal(calls.transport, 1)
  assert.ok(env.storage.getItem(storeModule.UPDATE_CACHE_KEY))

  advance(60 * 60 * 1000)
  await store.getState().check({ manual: false })
  assert.equal(store.getState().fromCache, true)
  assert.equal(store.getState().status, 'available')
  assert.equal(calls.transport, 1, '24h 内自动检查不应再请求网络')

  await store.getState().check({ manual: true })
  assert.equal(calls.transport, 2, '手动检查必须忽略缓存')
  assert.equal(store.getState().fromCache, false)
})

test('缓存：超过 24h 或应用版本变化后自动检查重新请求', async () => {
  const ttlEnv = makeEnv()
  const ttlStore = storeModule.createUpdateStore(ttlEnv.env)
  await ttlStore.getState().check({ manual: true })
  ttlEnv.advance(storeModule.UPDATE_CACHE_TTL_MS + 1)
  await ttlStore.getState().check({ manual: false })
  assert.equal(ttlEnv.calls.transport, 2, '缓存过期应重新请求')

  const bumped = makeEnv()
  const bumpedStore = storeModule.createUpdateStore(bumped.env)
  await bumpedStore.getState().check({ manual: true })
  // 应用升级到 0.3.18 后，旧的「0.3.17 时缓存的新版本」失效
  bumped.setVersion('0.3.18')
  await bumpedStore.getState().check({ manual: false })
  assert.equal(bumped.calls.transport, 2)
  assert.equal(bumpedStore.getState().status, 'up-to-date')
})

test('缓存纯函数：TTL 边界、损坏数据与恶意下载地址都被拒绝', () => {
  const now = 1_700_000_000_000
  const release = github.parseReleasePayload(makePayload())
  const cache = { checkedAt: now - 1000, currentVersion: '0.3.17', release }
  assert.equal(storeModule.isCacheFresh(cache, now), true)
  assert.equal(storeModule.isCacheFresh(cache, now + storeModule.UPDATE_CACHE_TTL_MS), false)
  // 未来时间戳（时钟回拨）视为过期
  assert.equal(storeModule.isCacheFresh({ ...cache, checkedAt: now + 10_000 }, now), false)

  const storage = memoryStorage()
  storage.setItem(storeModule.UPDATE_CACHE_KEY, JSON.stringify(cache))
  assert.equal(storeModule.readUpdateCache(storage, now).release.version, '0.3.18')
  assert.equal(storeModule.readUpdateCache(storage, now + storeModule.UPDATE_CACHE_TTL_MS), null)

  storage.setItem(storeModule.UPDATE_CACHE_KEY, '{broken')
  assert.equal(storeModule.readUpdateCache(storage, now), null)

  // 缓存里的下载地址必须仍是 https GitHub 官方域名
  const hostile = {
    ...cache,
    release: {
      ...release,
      assets: [{ ...release.assets[0], downloadUrl: 'http://evil.example/x.exe' }],
    },
  }
  storage.setItem(storeModule.UPDATE_CACHE_KEY, JSON.stringify(hostile))
  assert.equal(storeModule.readUpdateCache(storage, now), null)
  assert.equal(storeModule.parseCachedRelease(hostile.release), null)
})

test('下载并安装：进度写入状态，完成后 ready', async () => {
  const { env, calls } = makeEnv()
  const store = storeModule.createUpdateStore(env)
  await store.getState().check({ manual: true })
  const progress = []
  env.download = async (_asset, candidates, onProgress) => {
    assert.ok(candidates[0].startsWith('https://github.com/'))
    assert.ok(candidates.length > 1, '下载候选应包含镜像兜底')
    onProgress({ received: 25, total: 100, percent: 25 })
    progress.push(store.getState().download)
    onProgress({ received: 100, total: 100, percent: 100 })
    return { path: '/tmp/installer.exe' }
  }
  await store.getState().downloadAndInstall()
  const state = store.getState()
  assert.equal(progress[0].percent, 25)
  assert.equal(state.status, 'ready')
  assert.equal(state.install.kind, 'installer-launched')
  assert.equal(state.download.percent, 100)
  assert.equal(calls.install, 1)
})

test('取消下载：回到 available，不保留错误', async () => {
  const { env } = makeEnv()
  const store = storeModule.createUpdateStore(env)
  await store.getState().check({ manual: true })
  let releaseDownload = () => {}
  const gate = new Promise((resolve) => {
    releaseDownload = resolve
  })
  env.download = async (_asset, _candidates, onProgress) => {
    onProgress({ received: 10, total: 100, percent: 10 })
    await gate
    throw new github.UpdateError('cancelled')
  }
  env.cancelDownload = async () => {
    releaseDownload()
  }
  const pending = store.getState().downloadAndInstall()
  assert.equal(store.getState().status, 'downloading')
  await store.getState().cancelDownload()
  await pending
  assert.equal(store.getState().status, 'available')
  assert.equal(store.getState().download, null)
  assert.equal(store.getState().error, null)
})

test('错误分支：无匹配资产 / 超过下载上限 / 下载失败', async () => {
  const apkOnly = makeEnv()
  apkOnly.setPayload(
    makePayload('0.3.18', [
      {
        name: 'aurora-chat-0.3.18-debug.apk',
        size: 9468616,
        content_type: 'application/vnd.android.package-archive',
        browser_download_url: CANONICAL_APK,
      },
    ])
  )
  const apkStore = storeModule.createUpdateStore(apkOnly.env)
  await apkStore.getState().check({ manual: true })
  assert.equal(apkStore.getState().status, 'available')
  assert.equal(apkStore.getState().asset, null)
  await apkStore.getState().downloadAndInstall()
  assert.equal(apkStore.getState().status, 'error')
  assert.equal(apkStore.getState().error.code, 'no-asset')

  const tooLarge = makeEnv()
  tooLarge.setPayload(
    makePayload('0.3.18', [
      {
        name: 'aurora-chat-0.3.18-win-x64.exe',
        size: 300 * 1024 * 1024 + 1,
        content_type: 'application/x-msdos-program',
        browser_download_url: CANONICAL_EXE,
      },
    ])
  )
  const largeStore = storeModule.createUpdateStore(tooLarge.env)
  await largeStore.getState().check({ manual: true })
  await largeStore.getState().downloadAndInstall()
  assert.equal(largeStore.getState().error.code, 'too-large')

  const failing = makeEnv()
  const failStore = storeModule.createUpdateStore(failing.env)
  await failStore.getState().check({ manual: true })
  failing.env.download = async () => {
    throw new github.UpdateError('size-mismatch', 'downloaded 10 of 100 bytes')
  }
  await failStore.getState().downloadAndInstall()
  const state = failStore.getState()
  assert.equal(state.status, 'error')
  assert.equal(state.error.code, 'size-mismatch')
  assert.equal(state.error.phase, 'download')
  assert.equal(state.release.version, '0.3.18', '下载失败要保留 release 供重试')
})

test('检查错误：网络失败进入 error（phase=check），可重试成功', async () => {
  const { env } = makeEnv()
  let fail = true
  env.transport = async () => {
    if (fail) {
      throw new TypeError('Failed to fetch')
    }
    return jsonResponse(makePayload())
  }
  const store = storeModule.createUpdateStore(env)
  await store.getState().check({ manual: true })
  assert.equal(store.getState().status, 'error')
  assert.equal(store.getState().error.phase, 'check')
  assert.equal(store.getState().error.code, 'network')

  fail = false
  await store.getState().check({ manual: true })
  assert.equal(store.getState().status, 'available')
  assert.equal(store.getState().error, null)
})

test('web 端：一键按钮退化为打开 Release 页面', async () => {
  const { env, calls } = makeEnv({ runtime: 'web', assetPlatform: 'web' })
  const store = storeModule.createUpdateStore(env)
  await store.getState().check({ manual: true })
  assert.equal(store.getState().status, 'available')
  await store.getState().downloadAndInstall()
  assert.equal(store.getState().status, 'ready')
  assert.equal(store.getState().install.kind, 'release-page')
  assert.equal(calls.opened.length, 1)
  assert.ok(calls.opened[0].startsWith('https://github.com/'))
})

test('小红点：仅 available 且未点稍后时显示，dismiss 后隐藏', async () => {
  const { env } = makeEnv()
  const store = storeModule.createUpdateStore(env)
  assert.equal(storeModule.shouldShowUpdateBadge(store.getState()), false)
  await store.getState().check({ manual: true })
  assert.equal(storeModule.shouldShowUpdateBadge(store.getState()), true)
  store.getState().dismissAvailable()
  assert.equal(storeModule.shouldShowUpdateBadge(store.getState()), false)
})
