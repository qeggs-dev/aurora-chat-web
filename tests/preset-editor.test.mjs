// Preset editor logic (src/components/settings/presetStatus.ts,
// src/components/settings/presetDraftStore.ts, src/services/preset/overwrite.ts):
// one unified status slot (no more importStatus ?? saveStatus shadowing), persistent draft
// storage across section switches, stale-draft / same-id overwrite confirmation rules and
// preset store error cleanup on remount.
import assert from 'node:assert/strict'
import { test } from 'node:test'

globalThis.__API_ORIGIN__ = 'https://api.deepseek.com'

const presetStatus = await import('../.test-build/components/settings/presetStatus.js')
const draftStore = await import('../.test-build/components/settings/presetDraftStore.js')
const overwrite = await import('../.test-build/services/preset/overwrite.js')
const presetTypes = await import('../.test-build/services/preset/types.js')
const presetStore = await import('../.test-build/services/preset/store.js')

const statusText = (slot) => (slot ? slot.message.key : null)

const makeDraft = (overrides = {}) => ({
  config: { schema: 1, id: 'demo', name: 'Demo' },
  text: {},
  dirty: false,
  builtin: false,
  ...overrides,
})

/* ============================ P1-2 统一状态槽 ============================ */

test('统一状态槽：后一条提示覆盖前一条，导入提示不会遮蔽「已保存但未启用」', () => {
  let slot = presetStatus.nextStatus(
    null,
    presetStatus.infoStatus({ key: 'presetImported' }, 1)
  )
  assert.equal(statusText(slot), 'presetImported')
  // 导入提示还在时保存了另一个预设：单槽位直接显示最新结果，而不是被导入提示压住
  slot = presetStatus.nextStatus(slot, presetStatus.infoStatus({ key: 'presetSavedNotActive' }, 2))
  assert.equal(statusText(slot), 'presetSavedNotActive')
  // 保存失败同样覆盖旧的持久提示
  slot = presetStatus.nextStatus(slot, presetStatus.errorStatus({ key: 'presetSaveFailed' }, 3))
  assert.equal(statusText(slot), 'presetSaveFailed')
  assert.equal(slot.kind, 'error')
  assert.equal(slot.at, 3)
})

test('切换预设标签：保留持久 info 提示，只清当前选中项的临时错误', () => {
  const persistent = presetStatus.infoStatus({ key: 'presetSavedNotActive' }, 1)
  assert.equal(presetStatus.keepPersistentStatus(persistent), persistent)
  const transient = presetStatus.errorStatus({ key: 'presetActivateUnsaved' }, 2)
  assert.equal(presetStatus.keepPersistentStatus(transient), null)
  assert.equal(presetStatus.keepPersistentStatus(null), null)
})

test('错误码 → 状态槽：已知 PresetError 用错误码文案，未知错误带原始 message', () => {
  const known = presetStatus.presetErrorStatus(
    new presetTypes.PresetError('tooLarge', 'x'),
    'presetImportFailed',
    1
  )
  assert.equal(statusText(known), 'presetErrorTooLarge')
  assert.equal(known.kind, 'error')

  const unknown = presetStatus.presetErrorStatus(new Error('boom'), 'presetSaveFailed', 2)
  assert.equal(statusText(unknown), 'presetSaveFailed')
  assert.equal(unknown.message.params.message, 'boom')
})

test('store.error → 状态槽：错误码映射，空错误返回 null', () => {
  assert.equal(presetStatus.storeErrorStatus(null, 1), null)
  assert.equal(statusText(presetStatus.storeErrorStatus('notZip', 1)), 'presetErrorNotZip')
  assert.equal(statusText(presetStatus.storeErrorStatus('unknownCode', 1)), 'presetFailed')
})

/* ============================ P1-3 草稿会话跨分组保留 ============================ */

test('草稿会话：跨组件挂载保留草稿，dirty 统计与快照', () => {
  draftStore.resetPresetDrafts()
  draftStore.putPresetDraft('a', makeDraft({ dirty: false }))
  draftStore.putPresetDraft('b', makeDraft({ dirty: true }))
  assert.equal(draftStore.getPresetDrafts().a.config.id, 'demo')
  assert.equal(draftStore.hasDirtyPresetDrafts(), true)
  assert.equal(draftStore.getDirtyPresetDraftsSnapshot(), true)
  assert.equal(draftStore.countDirtyPresetDrafts(), 1)

  // 模拟重新挂载：草稿表本身是模块级状态，读取到的仍是原对象
  const before = draftStore.getPresetDrafts()
  assert.equal(draftStore.getPresetDrafts(), before)

  draftStore.updatePresetDrafts((previous) => ({
    ...previous,
    b: { ...previous.b, dirty: false },
  }))
  assert.equal(draftStore.hasDirtyPresetDrafts(), false)
  assert.equal(draftStore.getDirtyPresetDraftsSnapshot(), false)
  draftStore.resetPresetDrafts()
})

test('invalidatePresetDraft：同 id 被导入覆盖后旧草稿作废，dirty 不再阻塞关闭', () => {
  draftStore.resetPresetDrafts()
  draftStore.putPresetDraft('demo', makeDraft({ dirty: true }))
  assert.equal(draftStore.hasDirtyPresetDrafts(), true)
  draftStore.invalidatePresetDraft('demo')
  assert.equal(draftStore.getPresetDrafts().demo, undefined)
  assert.equal(draftStore.hasDirtyPresetDrafts(), false)
})

test('草稿会话订阅：更新 / 重置通知监听器，取消订阅后不再通知', () => {
  draftStore.resetPresetDrafts()
  let calls = 0
  const unsubscribe = draftStore.subscribePresetDrafts(() => {
    calls += 1
  })
  draftStore.putPresetDraft('x', makeDraft())
  assert.equal(calls, 1)
  draftStore.resetPresetDrafts()
  assert.equal(calls, 2)
  unsubscribe()
  draftStore.putPresetDraft('y', makeDraft())
  assert.equal(calls, 2)
  draftStore.resetPresetDrafts()
})

/* ============================ P1-4 覆盖确认 / 旧草稿保护 ============================ */

test('importOverwriteCheck：内置 id 直接拒绝，用户自建需确认，导入包同 id 可直接更新', () => {
  assert.equal(overwrite.importOverwriteCheck(undefined), 'none')
  assert.equal(overwrite.importOverwriteCheck({ builtin: true, source: 'created' }), 'blocked')
  assert.equal(overwrite.importOverwriteCheck({ source: 'created' }), 'confirm')
  // 旧记录没有 source：按用户自建处理，仍需确认
  assert.equal(overwrite.importOverwriteCheck({}), 'confirm')
  assert.equal(overwrite.importOverwriteCheck({ source: 'imported' }), 'none')
})

test('saveNeedsStaleConfirm：草稿基于的 importedAt 与当前记录不一致才算过期', () => {
  assert.equal(overwrite.saveNeedsStaleConfirm(100, 100), false)
  assert.equal(overwrite.saveNeedsStaleConfirm(100, 200), true)
  // 新建草稿 / 旧插件调用没有 importedAt：不拦截
  assert.equal(overwrite.saveNeedsStaleConfirm(undefined, 100), false)
  assert.equal(overwrite.saveNeedsStaleConfirm(100, undefined), false)
  assert.equal(overwrite.saveNeedsStaleConfirm(undefined, undefined), false)
})

/* ==================== P2-9 预设 store 错误生命周期 ==================== */

test('clearPresetError：清除上次失败错误，重挂载后不再显示旧原因', () => {
  presetStore.usePresetStore.setState({ error: 'saveFailed' })
  assert.equal(presetStore.usePresetStore.getState().error, 'saveFailed')
  presetStore.clearPresetError()
  assert.equal(presetStore.usePresetStore.getState().error, null)
  // 幂等
  presetStore.clearPresetError()
  assert.equal(presetStore.usePresetStore.getState().error, null)
})

test('导入失败写入 error，成功路径开始时会清空（clearPresetError 可兜底）', async () => {
  presetStore.usePresetStore.setState({ error: null })
  const notZip = new File([new Uint8Array([1, 2, 3])], 'x.zip', { type: 'application/zip' })
  await assert.rejects(presetStore.importPresetZip(notZip))
  assert.equal(presetStore.usePresetStore.getState().error, 'notZip')
  presetStore.clearPresetError()
  assert.equal(presetStore.usePresetStore.getState().error, null)
})
