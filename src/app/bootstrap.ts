/**
 * 应用启动装配（可单测）。
 *
 * Cordis 容器 start() 失败时不能让界面永远停在「会话加载中」：
 * - 装配成功：按六个内置服务初始化（与 Cordis 化之后的行为一致）；
 * - 装配失败：记录可读原因，并改用直连模块的同一组初始化，Phase 1 的界面照常可用。
 * 两条路径都会执行 initChat 与 style / presets / usage / memory 的初始化。
 */

/** 一次启动需要的初始化入口；services 路径与 fallback 路径提供同一份形状 */
export type BootstrapServices = {
  /** 读取会话列表（任何界面都要先有它，否则一直停在加载中） */
  initChat: () => Promise<void>
  style: { init: () => Promise<unknown> }
  presets: {
    init: () => Promise<unknown>
    /** 当前预设解析后的记忆开关（默认预设留空 = 关闭） */
    getMemoryEnabled: () => boolean
    /** 预设切换通知；启动阶段用它同步记忆工具开关 */
    subscribe: (listener: () => void) => () => void
  }
  usage: { init: () => Promise<unknown> }
  memory: {
    init: (enabled: boolean) => Promise<unknown>
    setEnabled: (enabled: boolean) => Promise<unknown>
  }
  /** 首次使用先确认非官方声明；确认后再要求 API Key */
  disclaimerAccepted: () => boolean
  ensureApiKey: () => void
}

export type BootstrapInput = {
  /** 等待 Cordis 服务装配 */
  start: () => Promise<void>
  /** 装配成功：用容器里的服务初始化 */
  fromServices: () => BootstrapServices
  /** 装配失败：用直连模块初始化（Phase 1 的界面本来就直连 store） */
  fromFallback: () => BootstrapServices
}

export type BootstrapResult = {
  /** 装配失败原因（可展示）；成功为 null。注意成功不代表后续初始化没有失败 */
  error: string | null
  /** 取消预设订阅；页面卸载时调用 */
  dispose: () => void
}

export type BootstrapRun = {
  /** 取消预设订阅；页面卸载时调用 */
  dispose: () => void
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/** 装配失败的可读原因：AppContextStartError 已带「哪个服务、缺什么依赖」，直接用它的文案 */
export const describeBootstrapError = (error: unknown): string => {
  const message = messageOf(error).trim()
  return message || 'Cordis 服务装配失败'
}

/**
 * 执行初始化：initChat / style / usage 并行启动，预设恢复后再按记忆开关初始化记忆。
 * 与 Cordis 化之前完全一致（顺序、不阻塞、失败不抛给界面）。
 */
export const runBootstrap = (services: BootstrapServices): BootstrapRun => {
  void services.initChat()
  void services.style.init()
  void services.usage.init()
  let memoryReady = false
  let memoryEnabled: boolean | undefined
  const syncMemory = () => {
    const enabled = services.presets.getMemoryEnabled()
    if (!memoryReady || enabled === memoryEnabled) {
      return
    }
    memoryEnabled = enabled
    void services.memory.setEnabled(enabled)
  }
  // 先订阅再等预设恢复：恢复期间切换的预设也要同步到记忆开关
  const unsubscribe = services.presets.subscribe(syncMemory)
  void Promise.resolve(services.presets.init()).then(() => {
    memoryEnabled = services.presets.getMemoryEnabled()
    memoryReady = true
    void services.memory.init(memoryEnabled)
  })
  if (services.disclaimerAccepted()) {
    services.ensureApiKey()
  }
  return { dispose: unsubscribe }
}

/** 启动：失败时记录原因并退回直连初始化，绝不因装配失败停在加载中 */
export const bootstrapApp = async (input: BootstrapInput): Promise<BootstrapResult> => {
  let services: BootstrapServices
  let error: string | null = null
  try {
    await input.start()
    services = input.fromServices()
  } catch (startError) {
    error = describeBootstrapError(startError)
    services = input.fromFallback()
  }
  return { error, ...runBootstrap(services) }
}
