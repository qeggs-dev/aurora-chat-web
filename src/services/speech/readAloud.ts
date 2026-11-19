import { create } from 'zustand'
import type { TranslationMessage } from '../../i18n/index.js'
import { ApiError } from '../api/client.js'
import { classifyApiError } from '../api/errors.js'
import { synthesize, TTS_SAMPLE_RATE } from '../api/speech.js'
import { useSettings } from '../settings.js'

/**
 * 朗读：同一时间只读一条回复。
 * 请求 TTS 的裸 PCM 流，边收边用 AudioContext 按顺序排程播放，首帧到达即出声。
 * 状态：loading（已请求、未出声）→ playing → 结束回到 idle。
 *
 * AudioContext 需要用户手势才能出声：顶栏开关在点击事件里调用 primeReadAloud()
 * 预热一个共享 context，之后手动朗读与自动朗读都复用它；共享 context 不在朗读结束时关闭。
 * 没有共享 context（例如用户从未点过开关）时临时创建一个并尝试 resume，失败按
 * ReadAloudAudioError 交给调用方（自动朗读据此关闭开关并提示，避免静默失败）。
 */
export type ReadAloudStatus = 'idle' | 'loading' | 'playing'

type ReadAloudState = {
  /** 正在朗读的回复 id */
  messageId: string | null
  status: ReadAloudStatus
}

export const useReadAloud = create<ReadAloudState>(() => ({ messageId: null, status: 'idle' }))

/** 首帧前多缓冲一点，减少网络抖动造成的断续 */
const START_DELAY = 0.1
/** 等待 AudioContext 进入 running 的上限：非手势创建时浏览器会一直挂起 */
const RESUME_TIMEOUT = 300

/** AudioContext 没能启动（浏览器自动播放策略拦截）：调用方应提示并关闭自动朗读 */
export class ReadAloudAudioError extends Error {
  constructor() {
    super('AudioContext is not running')
    this.name = 'ReadAloudAudioError'
  }
}

export const isReadAloudAudioError = (error: unknown): error is ReadAloudAudioError =>
  error instanceof ReadAloudAudioError

type AudioContextFactory = () => AudioContext

const createBrowserContext: AudioContextFactory = () =>
  new AudioContext({ sampleRate: TTS_SAMPLE_RATE })

/** 测试 / 宿主可注入的 AudioContext 工厂 */
let createContext: AudioContextFactory = createBrowserContext

/** 开关按钮的用户手势里预热的共享 AudioContext */
let sharedContext: AudioContext | null = null

type Playback = { controller: AbortController; context: AudioContext; owned: boolean }

let current: Playback | null = null

/** 测试用：显式前恢复浏览器实现，同时释放共享 context（已结束的朗读会先停止） */
export const setReadAloudAudioContextFactory = (factory: AudioContextFactory | null) => {
  createContext = factory ?? createBrowserContext
  stopReadAloud()
  const shared = sharedContext
  sharedContext = null
  if (shared && shared.state !== 'closed') {
    void shared.close().catch(() => {})
  }
}

const resume = (context: AudioContext) => {
  if (context.state !== 'suspended') {
    return
  }
  try {
    void context.resume().catch(() => {})
  } catch {
    // 部分环境同步抛错；能否出声由 ensureRunning 的 state 检查兜底
  }
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** 用函数读取 state：避免 TS 按前面的判断把类型窄化死 */
const isRunning = (context: AudioContext) => context.state === 'running'

/** 非手势路径下浏览器可能拒绝唤醒 AudioContext：超时后按失败处理 */
const ensureRunning = async (context: AudioContext) => {
  if (isRunning(context)) {
    return
  }
  try {
    await Promise.race([context.resume(), delay(RESUME_TIMEOUT)])
  } catch {
    // 落到下面的 state 检查
  }
  if (!isRunning(context)) {
    throw new ReadAloudAudioError()
  }
}

/**
 * 在用户手势（顶栏开关的点击）里创建并 resume 共享 AudioContext。
 * 只负责预热：真正能否出声由朗读开始时的 ensureRunning 判断。
 */
export const primeReadAloud = (): boolean => {
  let context = sharedContext
  if (!context || context.state === 'closed') {
    try {
      context = createContext()
    } catch {
      sharedContext = null
      return false
    }
    sharedContext = context
  }
  resume(context)
  return true
}

const acquireContext = (): { context: AudioContext; owned: boolean } | null => {
  const shared = sharedContext
  if (shared && shared.state !== 'closed') {
    resume(shared)
    return { context: shared, owned: false }
  }
  try {
    return { context: createContext(), owned: true }
  } catch {
    return null
  }
}

const finish = (controller: AbortController) => {
  if (current?.controller !== controller) {
    return
  }
  const { context, owned } = current
  current = null
  useReadAloud.setState({ messageId: null, status: 'idle' })
  // 共享 context 留给下一次朗读复用；只有这里临时创建的才关闭
  if (owned) {
    void context.close().catch(() => {})
  }
}

/** 停止当前朗读（发送、停止生成、切换会话、关闭自动朗读等场景调用） */
export const stopReadAloud = () => {
  if (current) {
    const { controller } = current
    controller.abort()
    finish(controller)
  }
}

/** 16-bit 小端 PCM 转成 Float32；奇数字节留到下一段 */
const toFloat32 = (bytes: Uint8Array) => {
  const samples = new Float32Array(bytes.length >> 1)
  const view = new DataView(bytes.buffer, bytes.byteOffset, samples.length * 2)
  for (let i = 0; i < samples.length; i++) {
    samples[i] = view.getInt16(i * 2, true) / 0x8000
  }
  return samples
}

export const describeReadAloudError = (error: unknown): TranslationMessage | string => {
  if (error instanceof ApiError && error.kind === 'protocol') {
    return error.message
  }
  // 400 表示这段正文服务端无法合成，与其余失败区分开
  if (error instanceof ApiError && error.status === 400) {
    return { key: 'ttsUnavailable' }
  }
  if (isReadAloudAudioError(error)) {
    return { key: 'ttsUnavailable' }
  }
  switch (classifyApiError(error)) {
    case 'unauthorized':
      return { key: 'apiKeyInvalidRetry' }
    case 'insufficientBalance':
      return { key: 'insufficientBalance' }
    case 'rateLimited':
      return { key: 'rateLimited' }
    default:
      return { key: 'ttsFailed' }
  }
}

/**
 * 开始朗读一条回复的正文；同一条正在朗读时调用等于停止。
 * 手动点击时必须同步调用（AudioContext 需要用户手势）；自动朗读复用开关预热的 context。
 */
export const toggleReadAloud = (
  messageId: string,
  text: string,
  onError: (error: unknown) => void
) => {
  const reading = useReadAloud.getState().messageId
  stopReadAloud()
  if (reading === messageId) {
    return
  }
  const acquired = acquireContext()
  if (!acquired) {
    onError(new ReadAloudAudioError())
    return
  }
  const controller = new AbortController()
  const { context } = acquired
  current = { controller, ...acquired }
  useReadAloud.setState({ messageId, status: 'loading' })
  // 音色在开始朗读时读取，设置中切换后下一次朗读生效
  const { apiKey, ttsVoice } = useSettings.getState()

  void (async () => {
    let nextTime = 0
    let lastSource: AudioBufferSourceNode | null = null
    let rest = new Uint8Array(0)
    try {
      await ensureRunning(context)
      const stream = await synthesize(apiKey ?? '', text, ttsVoice, controller.signal)
      const reader = stream.getReader()
      controller.signal.addEventListener('abort', () => void reader.cancel().catch(() => {}))
      for (;;) {
        const { done, value } = await reader.read()
        if (done) {
          break
        }
        const bytes = new Uint8Array(rest.length + value.length)
        bytes.set(rest)
        bytes.set(value, rest.length)
        const samples = toFloat32(bytes)
        rest = bytes.slice(samples.length * 2)
        if (samples.length === 0) {
          continue
        }
        const buffer = context.createBuffer(1, samples.length, TTS_SAMPLE_RATE)
        buffer.copyToChannel(samples, 0)
        const source = context.createBufferSource()
        source.buffer = buffer
        source.connect(context.destination)
        // 网络慢于播放时从当前时间续上，不补播过去的时间
        nextTime = Math.max(nextTime, context.currentTime + (lastSource ? 0 : START_DELAY))
        source.start(nextTime)
        nextTime += buffer.duration
        lastSource = source
        if (useReadAloud.getState().status === 'loading') {
          useReadAloud.setState({ status: 'playing' })
        }
      }
      if (lastSource) {
        lastSource.onended = () => finish(controller)
      } else {
        finish(controller)
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        finish(controller)
        onError(error)
      }
    }
  })()
}
