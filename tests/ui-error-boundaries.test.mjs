// Error boundaries: the root boundary shows the crash message + reload, and the session boundary
// keeps single-conversation render errors from blanking the whole tree (返回会话列表).
import assert from 'node:assert/strict'
import { test } from 'node:test'

const rootBoundary = await import('../.test-build/components/base/ErrorBoundary.js')
const sessionBoundary = await import('../.test-build/components/session/SessionErrorBoundary.js')

test('根 ErrorBoundary：把渲染异常转成可展示的错误状态', () => {
  const fromError = rootBoundary.ErrorBoundary.getDerivedStateFromError(new Error('boom'))
  assert.equal(fromError.error.message, 'boom')

  const fromString = rootBoundary.ErrorBoundary.getDerivedStateFromError('crashed')
  assert.equal(fromString.error.message, 'crashed')
  assert.equal(fromString.error instanceof Error, true)
})

test('会话级 ErrorBoundary：单会话异常记录消息，并可清除状态返回列表', () => {
  const state = sessionBoundary.SessionErrorBoundary.getDerivedStateFromError(new Error('session boom'))
  assert.deepEqual(state, { message: 'session boom' })
  const fromString = sessionBoundary.SessionErrorBoundary.getDerivedStateFromError('bad render')
  assert.deepEqual(fromString, { message: 'bad render' })
})
