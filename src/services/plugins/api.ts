/**
 * api 服务插件（依赖 settings）：把 services/api/client.ts 的请求入口包成 Cordis 服务。
 *
 * 依赖 settings 的原因：Phase 2 的调用方不再自己从 useSettings 取 Key，
 * 由服务统一读当前设置；Phase 1 只做转发，现有 chat/store 仍直接调用 client.ts。
 */
import type { Context } from 'cordis'
import {
  API_ORIGIN,
  ApiError,
  deleteFile,
  request,
  streamChat,
  streamMessage,
  supportsFileUpload,
  uploadFile,
  verifyApiKey,
} from '../api/client.js'
import type { AppServicePlugin } from './types.js'

export interface ApiService {
  readonly API_ORIGIN: typeof API_ORIGIN
  readonly ApiError: typeof ApiError
  /** 当前设置里的 API Key（Phase 2 的请求入口用它，不必在 UI 层再读 settings） */
  getApiKey(): string | null
  request: typeof request
  streamChat: typeof streamChat
  streamMessage: typeof streamMessage
  verifyApiKey: typeof verifyApiKey
  uploadFile: typeof uploadFile
  deleteFile: typeof deleteFile
  supportsFileUpload: typeof supportsFileUpload
  /** 容器生命周期钩子：容器卸载时调用（进行中的流由调用方的 AbortSignal 负责中止） */
  dispose(): Promise<void>
}

export const apiPlugin: AppServicePlugin<'api'> = {
  name: 'api',
  inject: ['settings'],
  apply(ctx: Context) {
    const service: ApiService = {
      API_ORIGIN,
      ApiError,
      getApiKey: () => ctx.settings.getState().apiKey,
      request,
      streamChat,
      streamMessage,
      verifyApiKey,
      uploadFile,
      deleteFile,
      supportsFileUpload,
      async dispose() {
        // 请求层是纯函数，没有需要清理的状态或定时器
      },
    }
    ctx.provide('api', service)
    ctx.effect(() => () => service.dispose(), 'api.dispose()')
  },
}
