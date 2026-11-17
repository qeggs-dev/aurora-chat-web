import type { Context } from 'cordis'

/**
 * 内置服务插件的统一形态：插件名即服务名。
 * apply 里用 `ctx.provide(name, service)` 发布服务，依赖用 `inject` 声明；
 * 依赖未就绪时 Cordis 会让插件停在 PENDING，由 app/context.ts 的 start() 统一报告。
 */
export interface AppServicePlugin<K extends string = string> {
  readonly name: K
  /** 声明依赖的服务名（Cordis inject）；否则插件会在依赖提供前一直 PENDING */
  inject: string[]
  apply(ctx: Context): void
}
