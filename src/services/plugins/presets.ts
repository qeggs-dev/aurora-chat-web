/**
 * presets 服务插件（无服务依赖）：把 services/preset/store.ts 的公开 API 包成 Cordis 服务。
 *
 * 预设模块自己不 import 任何 service 模块，读写走 IndexedDB / localStorage，
 * 所以这里 inspect 为空是「按实际」的结果；api/client.ts 在模块级 import 预设解析，
 * 那是模块依赖，Phase 2 迁移调用时再改成 `ctx.presets`。
 */
import type { Context } from 'cordis'
import {
  activatePreset,
  createPresetDraft,
  DEFAULT_PRESET_NAME,
  getActivePreset,
  getActiveResolvedPreset,
  importPresetZip,
  initPresets,
  loadPresetConfig,
  removePreset,
  savePresetJson,
  usePresetStore,
} from '../preset/store.js'
import type { AppServicePlugin } from './types.js'

export interface PresetsService {
  readonly defaultName: typeof DEFAULT_PRESET_NAME
  init: typeof initPresets
  getState: typeof usePresetStore.getState
  subscribe: typeof usePresetStore.subscribe
  activate: typeof activatePreset
  importZip: typeof importPresetZip
  saveJson: typeof savePresetJson
  createDraft: typeof createPresetDraft
  remove: typeof removePreset
  getActive: typeof getActivePreset
  getActiveResolved: typeof getActiveResolvedPreset
  loadConfig: typeof loadPresetConfig
  /** 容器生命周期钩子：容器卸载时调用 */
  dispose(): Promise<void>
}

export const presetsPlugin: AppServicePlugin<'presets'> = {
  name: 'presets',
  inject: [],
  apply(ctx: Context) {
    const service: PresetsService = {
      defaultName: DEFAULT_PRESET_NAME,
      init: initPresets,
      getState: usePresetStore.getState,
      subscribe: (listener) => usePresetStore.subscribe(listener),
      activate: activatePreset,
      importZip: importPresetZip,
      saveJson: savePresetJson,
      createDraft: createPresetDraft,
      remove: removePreset,
      getActive: getActivePreset,
      getActiveResolved: getActiveResolvedPreset,
      loadConfig: loadPresetConfig,
      async dispose() {
        // 列表图标的 objectURL 可能仍被设置页正在渲染的图片引用，不在 pagehide 时 revoke
        // （Phase 2 若要支持运行时卸载服务，再由预设模块暴露 releaseSummaryIcons）
      },
    }
    ctx.provide('presets', service)
    ctx.effect(() => () => service.dispose(), 'presets.dispose()')
  },
}
