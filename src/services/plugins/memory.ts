/**
 * memory 服务插件（无 UI / 服务依赖）：把 services/memory/store.ts 的公开 API
 * （含模型工具 runMemoryTool）包成 Cordis 服务。
 *
 * dispose 会 flush：写操作是 400ms 防抖落盘，pagehide 时把 dirty 的库立即写进 IndexedDB，
 * 并清掉防抖定时器。
 */
import type { Context } from 'cordis'
import {
  flushMemory,
  getMemoryState,
  getMemoryStats,
  initMemory,
  listMemories,
  MEMORY_SECTIONS,
  MEMORY_SECTION_LABELS,
  MEMORY_TOOLS,
  removeMemory,
  runMemoryTool,
  searchMemories,
  setMemoryEnabled,
  subscribeMemory,
  writeMemory,
} from '../memory/store.js'
import type { AppServicePlugin } from './types.js'

export interface MemoryService {
  readonly tools: typeof MEMORY_TOOLS
  readonly sections: typeof MEMORY_SECTIONS
  readonly sectionLabels: typeof MEMORY_SECTION_LABELS
  init: typeof initMemory
  setEnabled: typeof setMemoryEnabled
  /** 立即把 dirty 的记忆库落盘（pagehide / dispose 时调用） */
  flush: typeof flushMemory
  runTool: typeof runMemoryTool
  getState: typeof getMemoryState
  subscribe: typeof subscribeMemory
  list: typeof listMemories
  search: typeof searchMemories
  write: typeof writeMemory
  remove: typeof removeMemory
  getStats: typeof getMemoryStats
  /** 容器生命周期钩子：容器卸载时调用 */
  dispose(): Promise<void>
}

export const memoryPlugin: AppServicePlugin<'memory'> = {
  name: 'memory',
  inject: [],
  apply(ctx: Context) {
    const service: MemoryService = {
      tools: MEMORY_TOOLS,
      sections: MEMORY_SECTIONS,
      sectionLabels: MEMORY_SECTION_LABELS,
      init: initMemory,
      setEnabled: setMemoryEnabled,
      flush: flushMemory,
      runTool: runMemoryTool,
      getState: getMemoryState,
      subscribe: subscribeMemory,
      list: listMemories,
      search: searchMemories,
      write: writeMemory,
      remove: removeMemory,
      getStats: getMemoryStats,
      async dispose() {
        // flushMemory 会取消防抖计时器并把 dirty 的库导出写进 IndexedDB 快照
        await flushMemory()
      },
    }
    ctx.provide('memory', service)
    ctx.effect(() => () => service.dispose(), 'memory.dispose()')
  },
}
