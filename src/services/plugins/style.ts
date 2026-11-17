/**
 * style 服务插件（依赖 settings）：把 services/style 的状态与 apply API 包成 Cordis 服务。
 *
 * 依赖 settings 的原因：样式包按主题偏好（light / dark / system）选择资源与应用 CSS 变量，
 * 模块内 `bindTheme()` 目前直接 import useSettings；Phase 2 改成用 `ctx.settings`，
 * 依赖图不用再变。启用包的 objectURL 仍由使用中的界面引用，dispose 不 revoke。
 */
import type { Context } from 'cordis'
import { applyStyleVars } from '../style/apply.js'
import {
  activateStylePack,
  importStylePack,
  initStylePacks,
  removeStylePack,
  useStylePackStore,
} from '../style/store.js'
import type { AppServicePlugin } from './types.js'

export interface StyleService {
  init: typeof initStylePacks
  getState: typeof useStylePackStore.getState
  subscribe: typeof useStylePackStore.subscribe
  activate: typeof activateStylePack
  importZip: typeof importStylePack
  remove: typeof removeStylePack
  /** 把启用包的资源写进 CSS 变量（phase 2 的主题重应用也走它） */
  applyVars: typeof applyStyleVars
  /** 容器生命周期钩子：容器卸载时调用 */
  dispose(): Promise<void>
}

export const stylePlugin: AppServicePlugin<'style'> = {
  name: 'style',
  inject: ['settings'],
  apply(ctx: Context) {
    const service: StyleService = {
      init: initStylePacks,
      getState: useStylePackStore.getState,
      subscribe: (listener) => useStylePackStore.subscribe(listener),
      activate: activateStylePack,
      importZip: importStylePack,
      remove: removeStylePack,
      applyVars: applyStyleVars,
      async dispose() {
        // 启用包的 objectURL 仍被页面上的图片/CSS 变量引用，pagehide 时不 revoke。
        // 主题订阅（useSettings.subscribe / matchMedia）由 style/store.ts 的 bindTheme 持有，
        // 只在页面生命周期内存在；Phase 2 支持运行时卸载服务时再补 unbind。
      },
    }
    ctx.provide('style', service)
    ctx.effect(() => () => service.dispose(), 'style.dispose()')
  },
}
