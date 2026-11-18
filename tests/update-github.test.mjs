// GitHub Release 解析与请求策略（src/services/update/github.ts）：
// 规范化资产地址、镜像兜底（只匿名 GET）、错误分类（限流 / 404 / 网络 / 错误页）。
import assert from 'node:assert/strict'
import { test } from 'node:test'

const github = await import('../.test-build/services/update/github.js')

const CANONICAL_ASSET_URL =
  'https://github.com/qeggs-dev/aurora-chat-app/releases/download/v0.3.18/aurora-chat-0.3.18-win-x64.exe'

const makePayload = (overrides = {}) => ({
  tag_name: 'v0.3.18',
  name: 'Aurora Chat v0.3.18',
  published_at: '2026-11-18T08:48:48Z',
  html_url: 'https://github.com/qeggs-dev/aurora-chat-app/releases/tag/v0.3.18',
  body: '## 更新内容\n\n- 修复若干问题',
  assets: [
    {
      name: 'aurora-chat-0.3.18-win-x64.exe',
      size: 125494895,
      content_type: 'application/x-msdos-program',
      browser_download_url: CANONICAL_ASSET_URL,
    },
  ],
  ...overrides,
})

test('parseReleasePayload：保留规范 github.com 下载地址并重建 Release 页面', () => {
  const release = github.parseReleasePayload(makePayload())
  assert.equal(release.version, '0.3.18')
  assert.equal(release.tagName, 'v0.3.18')
  assert.equal(
    release.htmlUrl,
    'https://github.com/qeggs-dev/aurora-chat-app/releases/tag/v0.3.18'
  )
  assert.equal(release.assets[0].downloadUrl, CANONICAL_ASSET_URL)
  assert.equal(release.assets[0].size, 125494895)
  assert.equal(release.notes, '## 更新内容\n\n- 修复若干问题')
  assert.equal(release.publishedAt, '2026-11-18T08:48:48Z')
})

test('parseReleasePayload：镜像改写的下载地址一律重建为 GitHub 官方地址', () => {
  const release = github.parseReleasePayload(
    makePayload({
      assets: [
        {
          name: 'aurora-chat-0.3.18-debug.apk',
          size: 9468616,
          content_type: 'application/vnd.android.package-archive',
          browser_download_url: 'https://github.gohj99.site/qeggs-dev/aurora-chat-app/releases/download/v0.3.18/aurora-chat-0.3.18-debug.apk',
        },
      ],
    })
  )
  assert.equal(
    release.assets[0].downloadUrl,
    'https://github.com/qeggs-dev/aurora-chat-app/releases/download/v0.3.18/aurora-chat-0.3.18-debug.apk'
  )
})

test('parseReleasePayload：过滤不安全资产名 / 非正大小，非法 tag 与空资产会抛错', () => {
  const release = github.parseReleasePayload(
    makePayload({
      assets: [
        { name: '../../evil.exe', size: 100, content_type: '', browser_download_url: CANONICAL_ASSET_URL },
        { name: 'ok.exe', size: -1, content_type: '', browser_download_url: CANONICAL_ASSET_URL },
        { name: 'ok.zip', size: 12, content_type: '', browser_download_url: CANONICAL_ASSET_URL },
      ],
    })
  )
  assert.deepEqual(release.assets.map((asset) => asset.name), ['ok.zip'])

  assert.throws(
    () => github.parseReleasePayload(makePayload({ assets: [] })),
    (error) => error.code === 'no-asset'
  )
  assert.throws(
    () => github.parseReleasePayload(makePayload({ tag_name: '../x' })),
    (error) => error.code === 'invalid-response'
  )
  assert.throws(
    () => github.parseReleasePayload(null),
    (error) => error.code === 'invalid-response'
  )
  // 非法 published_at 归为 null；notes 截断到上限
  const release2 = github.parseReleasePayload(
    makePayload({ published_at: 'not-a-date', body: 'x'.repeat(github.MAX_NOTES_LENGTH + 10) })
  )
  assert.equal(release2.publishedAt, null)
  assert.equal(release2.notes.length, github.MAX_NOTES_LENGTH)
})

test('isAllowedGithubContentUrl：只放行 https 的 GitHub 官方域名', () => {
  assert.equal(github.isAllowedGithubContentUrl(CANONICAL_ASSET_URL), true)
  assert.equal(github.isAllowedGithubContentUrl(github.GITHUB_LATEST_RELEASE_URL), true)
  assert.equal(github.isAllowedGithubContentUrl('http://github.com/a/b'), false)
  assert.equal(github.isAllowedGithubContentUrl('https://evil.com/github.com/a'), false)
  assert.equal(github.isAllowedGithubContentUrl('https://user:pass@github.com/a'), false)
  assert.equal(github.isAllowedGithubContentUrl('https://github.com:8443/a'), false)
  assert.equal(github.isAllowedGithubContentUrl('not a url'), false)
})

test('requestCandidates：直连优先，镜像只加在允许的 GitHub 公开地址前', () => {
  const candidates = github.requestCandidates(CANONICAL_ASSET_URL)
  assert.equal(candidates[0], CANONICAL_ASSET_URL)
  assert.equal(candidates.length, 1 + github.GITHUB_MIRRORS.length)
  for (const mirror of github.GITHUB_MIRRORS) {
    assert.ok(candidates.includes(`${mirror}/${CANONICAL_ASSET_URL}`))
  }
  assert.deepEqual(github.requestCandidates('https://evil.com/x'), [])
  assert.deepEqual(github.requestCandidates('http://github.com/x'), [])
  assert.deepEqual(github.downloadCandidates({ downloadUrl: CANONICAL_ASSET_URL }), candidates)
})

const jsonResponse = (payload, status = 200) => ({
  status,
  text: JSON.stringify(payload),
  contentType: 'application/json; charset=utf-8',
  headers: { rateLimitRemaining: '60', retryAfter: null },
})

const htmlResponse = (status = 200) => ({
  status,
  text: '<!DOCTYPE html><html><body>challenge</body></html>',
  contentType: 'text/html; charset=UTF-8',
  headers: {},
})

test('fetchLatestRelease：直连失败时按顺序落到镜像', async () => {
  const attempts = []
  const transport = async (url) => {
    attempts.push(url)
    if (attempts.length === 1) {
      throw new TypeError('Failed to fetch')
    }
    return jsonResponse(makePayload())
  }
  const release = await github.fetchLatestRelease({ transport })
  assert.equal(release.version, '0.3.18')
  assert.equal(attempts.length, 2)
  assert.equal(attempts[1], `${github.GITHUB_MIRRORS[0]}/${github.GITHUB_LATEST_RELEASE_URL}`)
})

test('fetchLatestRelease：403 限流 / 镜像 HTML 错误页都会继续换候选', async () => {
  const calls = []
  const transport = async (url) => {
    calls.push(url)
    if (calls.length === 1) {
      return { status: 403, text: 'rate limited', contentType: 'text/plain', headers: { rateLimitRemaining: '0' } }
    }
    if (calls.length === 2) {
      return htmlResponse(200)
    }
    return jsonResponse(makePayload())
  }
  const release = await github.fetchLatestRelease({ transport })
  assert.equal(release.version, '0.3.18')
  assert.equal(calls.length, 3)
})

test('fetchLatestRelease：404 立即判定没有 release，不浪费镜像请求', async () => {
  let calls = 0
  const transport = async () => {
    calls += 1
    return { status: 404, text: '{"message":"Not Found"}', contentType: 'application/json', headers: {} }
  }
  await assert.rejects(
    github.fetchLatestRelease({ transport }),
    (error) => error.code === 'no-release'
  )
  assert.equal(calls, 1)
})

test('fetchLatestRelease：全部失败时给出最有信息量的错误码', async () => {
  const allNetwork = async () => {
    throw new TypeError('Failed to fetch')
  }
  await assert.rejects(
    github.fetchLatestRelease({ transport: allNetwork, candidates: ['https://api.github.com/x'] }),
    (error) => error.code === 'network'
  )

  const allRateLimited = async () => ({
    status: 403,
    text: 'rate limited',
    contentType: 'text/plain',
    headers: { rateLimitRemaining: '0' },
  })
  await assert.rejects(
    github.fetchLatestRelease({ transport: allRateLimited, candidates: ['https://api.github.com/x'] }),
    (error) => error.code === 'rate-limit'
  )

  const badJson = async () => ({ status: 200, text: '{oops', contentType: 'application/json', headers: {} })
  await assert.rejects(
    github.fetchLatestRelease({ transport: badJson, candidates: ['https://api.github.com/x'] }),
    (error) => error.code === 'invalid-response'
  )
})

test('fetchLatestRelease：单次请求超时按 timeout 处理并换下一个候选', async () => {
  const calls = []
  const transport = (url, init) => {
    calls.push(url)
    if (calls.length === 1) {
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const error = new Error('aborted')
          error.name = 'AbortError'
          reject(error)
        })
      })
    }
    return Promise.resolve(jsonResponse(makePayload()))
  }
  const release = await github.fetchLatestRelease({
    transport,
    timeoutMs: 10,
    candidates: ['https://api.github.com/direct', 'https://mirror.test/fallback'],
  })
  assert.equal(release.version, '0.3.18')
  assert.equal(calls.length, 2)
})

test('toUpdateError：未知异常归一成 UpdateError', () => {
  assert.equal(github.toUpdateError(new github.UpdateError('cancelled')).code, 'cancelled')
  assert.equal(github.toUpdateError(new Error('boom')).code, 'network')
  const abort = new Error('aborted')
  abort.name = 'AbortError'
  assert.equal(github.toUpdateError(abort).code, 'timeout')
  assert.equal(github.toUpdateError('weird').code, 'network')
})
