// 资产选择（src/services/update/assets.ts）：按平台/渠道挑选安装包，含 debug/release APK 与体积上限。
import assert from 'node:assert/strict'
import { test } from 'node:test'

const assets = await import('../.test-build/services/update/assets.js')

const download = (name) =>
  `https://github.com/qeggs-dev/aurora-chat-app/releases/download/v0.3.18/${name}`

const RELEASE_ASSETS = [
  {
    name: 'aurora-chat-0.3.18-win-x64.zip',
    size: 157821999,
    contentType: 'application/zip',
    downloadUrl: download('aurora-chat-0.3.18-win-x64.zip'),
  },
  {
    name: 'aurora-chat-0.3.18-win-x64.exe',
    size: 125494895,
    contentType: 'application/x-msdos-program',
    downloadUrl: download('aurora-chat-0.3.18-win-x64.exe'),
  },
  {
    name: 'aurora-chat-0.3.18-linux-x86_64.AppImage',
    size: 130492989,
    contentType: 'application/octet-stream',
    downloadUrl: download('aurora-chat-0.3.18-linux-x86_64.AppImage'),
  },
  {
    name: 'aurora-chat-0.3.18-linux-amd64.deb',
    size: 105678296,
    contentType: 'application/x-debian-package',
    downloadUrl: download('aurora-chat-0.3.18-linux-amd64.deb'),
  },
  {
    name: 'aurora-chat-0.3.18-release.apk',
    size: 8232691,
    contentType: 'application/vnd.android.package-archive',
    downloadUrl: download('aurora-chat-0.3.18-release.apk'),
  },
  {
    name: 'aurora-chat-0.3.18-debug.apk',
    size: 9468616,
    contentType: 'application/vnd.android.package-archive',
    downloadUrl: download('aurora-chat-0.3.18-debug.apk'),
  },
]

test('pickAsset：桌面按平台挑安装包（Windows 选 NSIS exe，Linux 选 AppImage）', () => {
  const win = assets.pickAsset(RELEASE_ASSETS, { platform: 'windows', channel: 'release' })
  assert.equal(win.name, 'aurora-chat-0.3.18-win-x64.exe')
  const linux = assets.pickAsset(RELEASE_ASSETS, { platform: 'linux', channel: 'release' })
  assert.equal(linux.name, 'aurora-chat-0.3.18-linux-x86_64.AppImage')
  // 没有 dmg 时 macOS 不硬凑 zip
  assert.equal(assets.pickAsset(RELEASE_ASSETS, { platform: 'macos', channel: 'release' }), null)
  // web 端不下载安装包
  assert.equal(assets.pickAsset(RELEASE_ASSETS, { platform: 'web', channel: 'release' }), null)
})

test('pickAsset：Android 严格按渠道选 debug / release APK', () => {
  const debug = assets.pickAsset(RELEASE_ASSETS, { platform: 'android', channel: 'debug' })
  assert.equal(debug.name, 'aurora-chat-0.3.18-debug.apk')
  const release = assets.pickAsset(RELEASE_ASSETS, { platform: 'android', channel: 'release' })
  assert.equal(release.name, 'aurora-chat-0.3.18-release.apk')
  // dev 渠道按 debug 包处理
  const dev = assets.pickAsset(RELEASE_ASSETS, { platform: 'android', channel: 'dev' })
  assert.equal(dev.name, 'aurora-chat-0.3.18-debug.apk')

  // 只有 release 包时，debug 渠道不能拿 release 包顶替（签名不同，安装器会拒绝）
  const releaseOnly = RELEASE_ASSETS.filter((asset) => !asset.name.endsWith('-debug.apk'))
  assert.equal(assets.pickAsset(releaseOnly, { platform: 'android', channel: 'debug' }), null)
  // 只有 debug 包时，release 渠道同样不顶替
  const debugOnly = RELEASE_ASSETS.filter((asset) => !asset.name.endsWith('-release.apk'))
  assert.equal(assets.pickAsset(debugOnly, { platform: 'android', channel: 'release' }), null)
})

test('pickAsset：兼容本地构建产物名与备选命名', () => {
  const localDebug = [
    { name: 'aurora-chat-debug.apk', size: 9000, contentType: '', downloadUrl: download('aurora-chat-debug.apk') },
  ]
  assert.equal(
    assets.pickAsset(localDebug, { platform: 'android', channel: 'debug' }).name,
    'aurora-chat-debug.apk'
  )
  const linuxX64 = [
    {
      name: 'aurora-chat-0.3.18-linux-x64.AppImage',
      size: 1,
      contentType: '',
      downloadUrl: download('aurora-chat-0.3.18-linux-x64.AppImage'),
    },
  ]
  assert.equal(
    assets.pickAsset(linuxX64, { platform: 'linux', channel: 'release' }).name,
    'aurora-chat-0.3.18-linux-x64.AppImage'
  )
  const winArm = [
    { name: 'aurora-chat-0.3.18-win-arm64.exe', size: 1, contentType: '', downloadUrl: download('a.exe') },
  ]
  assert.equal(
    assets.pickAsset(winArm, { platform: 'windows', channel: 'release' }).name,
    'aurora-chat-0.3.18-win-arm64.exe'
  )
})

test('isWithinDownloadLimit / formatBytes：300MB 上限与人类可读大小', () => {
  assert.equal(assets.MAX_DOWNLOAD_BYTES, 300 * 1024 * 1024)
  assert.equal(assets.isWithinDownloadLimit(125494895), true)
  assert.equal(assets.isWithinDownloadLimit(assets.MAX_DOWNLOAD_BYTES), true)
  assert.equal(assets.isWithinDownloadLimit(assets.MAX_DOWNLOAD_BYTES + 1), false)
  assert.equal(assets.isWithinDownloadLimit(0), false)
  assert.equal(assets.formatBytes(125494895), '120 MB')
  assert.equal(assets.formatBytes(1024), '1.0 KB')
  assert.equal(assets.formatBytes(0), '—')
})
