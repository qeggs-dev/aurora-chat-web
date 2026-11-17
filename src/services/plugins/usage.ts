/**
 * usage 服务插件（无服务依赖）：把 services/usage/store.ts 的公开 API 包成 Cordis 服务。
 *
 * 用量写盘是「单事务 append events + 累加 stats」的异步操作，没有防抖缓冲；
 * dispose 会等所有进行中的 recordUsage 事务结束（pagehide 时尽量不丢最后几条）。
 */
import type { Context } from 'cordis'
import {
  clearUsageLog,
  emptyUsageTotals,
  getUsageState,
  initUsage,
  isUsageTotalsEmpty,
  listAllUsage,
  listUsage,
  recordUsage,
  resetUsageStats,
  subscribeUsage,
  totalsOf,
} from '../usage/store.js'
import type { AppServicePlugin } from './types.js'

export interface UsageService {
  readonly emptyTotals: typeof emptyUsageTotals
  readonly totalsOf: typeof totalsOf
  readonly isTotalsEmpty: typeof isUsageTotalsEmpty
  init: typeof initUsage
  record: typeof recordUsage
  list: typeof listUsage
  listAll: typeof listAllUsage
  clearLog: typeof clearUsageLog
  reset: typeof resetUsageStats
  getState: typeof getUsageState
  subscribe: typeof subscribeUsage
  /** 容器生命周期钩子：容器卸载时调用 */
  dispose(): Promise<void>
}

export const usagePlugin: AppServicePlugin<'usage'> = {
  name: 'usage',
  inject: [],
  apply(ctx: Context) {
    /** 进行中的写事务：dispose 时等它们落盘，避免 pagehide 丢最后一条用量 */
    const pendingWrites = new Set<Promise<unknown>>()
    const track = <T>(task: Promise<T>): Promise<T> => {
      pendingWrites.add(task)
      const settle = () => {
        pendingWrites.delete(task)
      }
      task.then(settle, settle)
      return task
    }
    const service: UsageService = {
      emptyTotals: emptyUsageTotals,
      totalsOf,
      isTotalsEmpty: isUsageTotalsEmpty,
      init: initUsage,
      record: (input) => track(recordUsage(input)),
      list: listUsage,
      listAll: listAllUsage,
      clearLog: clearUsageLog,
      reset: resetUsageStats,
      getState: getUsageState,
      subscribe: subscribeUsage,
      async dispose() {
        await Promise.allSettled([...pendingWrites])
      },
    }
    ctx.provide('usage', service)
    ctx.effect(() => () => service.dispose(), 'usage.dispose()')
  },
}
