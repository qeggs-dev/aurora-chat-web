/**
 * React 集成（Phase 1）：只提供容器与按名字取服务的 hook，不迁移任何现有调用。
 *
 * - `<AppServicesProvider context={getAppContext()}>` 包在 App 根节点；
 * - `useAppService('style')` 返回 `StyleService`（类型由 AppServiceMap 保证）；
 * - 现有组件继续直接 import 原模块，Phase 2 再逐步换成这里的服务。
 */
import { createContext, useContext, type ReactNode } from 'react'
import type { AppContext, AppServiceMap } from './context.js'

const AppServicesContext = createContext<AppContext | null>(null)

export type AppServicesProviderProps = {
  context: AppContext
  children: ReactNode
}

export const AppServicesProvider = ({ context, children }: AppServicesProviderProps) => (
  <AppServicesContext.Provider value={context}>{children}</AppServicesContext.Provider>
)

/** 取当前应用容器；必须在 <AppServicesProvider> 内使用 */
export const useAppContext = (): AppContext => {
  const context = useContext(AppServicesContext)
  if (!context) {
    throw new Error('useAppContext 必须在 <AppServicesProvider> 内使用')
  }
  return context
}

/** 按名字取一个已就绪的服务（容器未 start / 已 dispose 时抛错） */
export const useAppService = <K extends keyof AppServiceMap>(name: K): AppServiceMap[K] =>
  useAppContext().services()[name]
