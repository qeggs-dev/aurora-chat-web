/**
 * 应用级 Cordis 容器（Phase 1）。
 *
 * 只有内部容器，不加载外部插件、不做沙箱（那是 Phase 2 的 plugin-runtime）：
 * - `createAppContext()` 建一个 `new Context()`，按依赖顺序注册六个内置服务插件；
 * - `start()` 等待六个服务按 inject 依赖激活（失败时抛 AppContextStartError，指明服务与缺失依赖）；
 * - `dispose()` 先释放服务作用域，再逆序 dispose 六个服务（pagehide 时自动调用）。
 *
 * 服务实现都是现有 modules 的转发，React 组件在 Phase 1 继续直接 import 原模块。
 */
import { Context, type Fiber } from 'cordis'
import { apiPlugin, type ApiService } from '../services/plugins/api.js'
import { memoryPlugin, type MemoryService } from '../services/plugins/memory.js'
import { presetsPlugin, type PresetsService } from '../services/plugins/presets.js'
import { settingsPlugin, type SettingsService } from '../services/plugins/settings.js'
import { stylePlugin, type StyleService } from '../services/plugins/style.js'
import { usagePlugin, type UsageService } from '../services/plugins/usage.js'
import type { AppServicePlugin } from '../services/plugins/types.js'

/**
 * 六个内置服务（名称 = 插件名 = `ctx.provide` 的名字）。
 * 顺序即创建顺序：settings 最先，其余按对 settings 的依赖排在后面。
 */
export interface AppServiceMap {
  settings: SettingsService
  api: ApiService
  presets: PresetsService
  style: StyleService
  memory: MemoryService
  usage: UsageService
}

export type AppServiceName = keyof AppServiceMap

export const BUILTIN_SERVICE_NAMES: readonly AppServiceName[] = [
  'settings',
  'api',
  'presets',
  'style',
  'memory',
  'usage',
]

/** 六个内置服务插件（按注册顺序）；导出供启动自检复用 */
export const BUILTIN_SERVICES: readonly AppServicePlugin<AppServiceName>[] = [
  settingsPlugin,
  apiPlugin,
  presetsPlugin,
  stylePlugin,
  memoryPlugin,
  usagePlugin,
]

declare module 'cordis' {
  interface Context {
    settings: SettingsService
    api: ApiService
    presets: PresetsService
    style: StyleService
    memory: MemoryService
    usage: UsageService
    /**
     * Cordis 4 在 Context 上混入了 `reflect.provide`（运行时存在），但 d.ts 没有声明；
     * 服务插件用它发布服务，这里补上类型。返回值是卸载该服务的 disposer。
     */
    provide(name: string, value: unknown, check?: (this: unknown) => boolean): () => void
  }
}

/** Cordis Fiber 状态值的数字常量：d.ts 里是 const enum，isolatedModules 下不能当值 import */
const FIBER_ACTIVE = 2

/** 一个服务激活失败的结构化原因 */
export type AppServiceFailureKind = 'failed' | 'pending'

export interface AppServiceFailure {
  /** 插件名（= 服务名） */
  service: string
  /** failed：apply 抛错；pending：声明的依赖没有就绪 */
  kind: AppServiceFailureKind
  /** inject 里声明、但没有被任何插件成功提供的服务名 */
  missing: string[]
  /** apply 抛出的原始错误（pending / 未激活时为空） */
  error?: unknown
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const describeFailure = (failure: AppServiceFailure): string => {
  if (failure.kind === 'failed') {
    return failure.error === undefined
      ? `${failure.service}（插件未激活）`
      : `${failure.service}（加载失败：${messageOf(failure.error)}）`
  }
  const missing = failure.missing.length > 0 ? failure.missing.join('、') : '未知服务'
  return `${failure.service}（缺少依赖：${missing}）`
}

/**
 * 容器启动失败：`failures` 逐项给出「哪个服务、是加载失败还是缺依赖、缺哪几个」。
 * 不静默停在 PENDING：`start()` 一定 resolve（全部 ACTIVE）或 reject 本错误。
 */
export class AppContextStartError extends Error {
  readonly failures: readonly AppServiceFailure[]

  constructor(failures: readonly AppServiceFailure[]) {
    super(`Cordis 服务启动失败：${failures.map(describeFailure).join('；')}`)
    this.name = 'AppContextStartError'
    this.failures = failures
  }
}

type RegisteredService = {
  name: string
  inject: string[]
  fiber: Fiber
}

export type CreateAppContextOptions = {
  /**
   * 覆盖内置插件列表，仅供启动自检使用（Node 里验证依赖缺失 / apply 抛错的报错）。
   * 生产代码不要传：服务作用域的类型与 init/dispose 顺序都按六个内置服务约定。
   */
  plugins?: readonly AppServicePlugin[]
}

export interface AppContext extends Context {
  /** 等待六个服务按依赖激活；失败时抛 AppContextStartError（不止是 PENDING） */
  start(): Promise<void>
  /** 卸载容器：先释放服务作用域，再逆序 dispose 六个服务（pagehide 会自动调用） */
  dispose(): Promise<void>
  readonly started: boolean
  readonly disposed: boolean
  /** start() 失败时的结构化原因；成功或未启动时为 null */
  readonly startError: AppContextStartError | null
  /** 注入了六个服务的子上下文（scope.settings 等）；未就绪或已卸载时抛错 */
  services(): Context
}

const createAppContextWith = (plugins: readonly AppServicePlugin[]): AppContext => {
  const ctx = new Context()
  const registered: RegisteredService[] = plugins.map((plugin) => ({
    name: plugin.name,
    inject: plugin.inject,
    fiber: ctx.plugin(plugin),
  }))

  /**
   * 服务作用域：一个注入全部服务的子上下文，React 层用它按名字取服务。
   * 它同时是「全部服务已就绪」的信号（依赖缺一个就会一直 PENDING）。
   */
  let serviceScope: Context | undefined
  /** 命名函数让 Cordis 日志里能看出是服务作用域，而不是匿名的 root */
  const captureServiceScope = (scope: Context) => {
    serviceScope = scope
  }
  const scopeFiber = ctx.inject(
    registered.map((entry) => entry.name),
    captureServiceScope
  )

  let started = false
  let disposed = false
  let startError: AppContextStartError | null = null
  let startTask: Promise<void> | undefined
  let disposeTask: Promise<void> | undefined
  let pagehideBound = false

  const dispose = (): Promise<void> => {
    disposeTask ??= (async () => {
      detachPagehide()
      disposed = true
      serviceScope = undefined
      // 服务视图先释放（可能被 UI 持有），再逆序卸载服务：先卸载依赖方，再卸载被依赖方
      await scopeFiber.dispose()
      for (const entry of [...registered].reverse()) {
        try {
          await entry.fiber.dispose()
        } catch (error: unknown) {
          // oxlint-disable-next-line no-console
          console.error(`Cordis 服务卸载失败：${entry.name}`, error)
        }
      }
    })()
    return disposeTask
  }

  const onPagehide = () => {
    void dispose()
  }

  const attachPagehide = () => {
    if (pagehideBound || typeof window === 'undefined') {
      return
    }
    pagehideBound = true
    window.addEventListener('pagehide', onPagehide)
  }

  const detachPagehide = () => {
    if (!pagehideBound || typeof window === 'undefined') {
      return
    }
    pagehideBound = false
    window.removeEventListener('pagehide', onPagehide)
  }

  const start = (): Promise<void> => {
    if (disposed) {
      return Promise.reject(
        new Error('Cordis 容器已卸载，不能再次 start；请重新 createAppContext()')
      )
    }
    startTask ??= (async () => {
      // 插件依赖缺失时 Cordis 会把 fiber 停在 PENDING，await 一个 PENDING fiber 会立即返回，
      // 所以先收集 await 抛出的错误，再按 fiber 的最终 state 判定是否全部 ACTIVE。
      const loadErrors = new Map<number, unknown>()
      for (const [index, entry] of registered.entries()) {
        try {
          await entry.fiber
        } catch (error: unknown) {
          loadErrors.set(index, error)
        }
      }
      const activeServices = new Set<string>()
      for (const entry of registered) {
        if (entry.fiber.state === FIBER_ACTIVE) {
          activeServices.add(entry.name)
        }
      }
      const failures: AppServiceFailure[] = []
      for (const [index, entry] of registered.entries()) {
        if (entry.fiber.state === FIBER_ACTIVE) {
          continue
        }
        const missing = entry.inject.filter((name) => !activeServices.has(name))
        const loadError = loadErrors.get(index)
        failures.push({
          service: entry.name,
          kind: loadError !== undefined || missing.length === 0 ? 'failed' : 'pending',
          missing,
          ...(loadError === undefined ? {} : { error: loadError }),
        })
      }
      if (failures.length > 0) {
        const error = new AppContextStartError(failures)
        startError = error
        // 服务装配失败属于开发期错误：完整原因写控制台，Phase 1 的界面继续用直连 store 工作
        // oxlint-disable-next-line no-console
        console.error(error.message)
        throw error
      }
      await scopeFiber
      started = true
      attachPagehide()
    })()
    return startTask
  }

  const getServiceScope = (): Context => {
    if (!serviceScope) {
      throw new Error(
        'Cordis 服务容器尚未就绪或已卸载：请先 await ctx.start()，且不要在 ctx.dispose() 之后访问服务'
      )
    }
    return serviceScope
  }

  const app = ctx as AppContext
  Object.defineProperties(app, {
    start: { value: start },
    dispose: { value: dispose },
    services: { value: getServiceScope },
    started: { get: () => started },
    disposed: { get: () => disposed },
    startError: { get: () => startError },
  })
  return app
}

/** 创建应用容器：注册六个内置服务插件（依赖顺序），返回带 start/dispose 的上下文 */
export const createAppContext = (options: CreateAppContextOptions = {}): AppContext =>
  createAppContextWith(options.plugins ?? BUILTIN_SERVICES)

let appContext: AppContext | undefined

/** 应用容器单例：App 模块加载时首次调用即创建（只创建一次） */
export const getAppContext = (): AppContext => (appContext ??= createAppContext())
