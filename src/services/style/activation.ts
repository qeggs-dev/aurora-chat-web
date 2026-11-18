/**
 * 样式包激活的时序闸门：快速连续切换样式包 / 切主题时，只允许最后一次激活与最后一次
 * 主题重应用落地，避免旧包的异步任务（派生图、字体加载）在后来者之后写入变量。
 *
 * 纯逻辑（不碰 DOM），store 里所有激活 / 重应用都经过它，单测直接覆盖并发终态。
 */
export type ActivationGate = {
  /** 开始一次激活，返回本次激活的 token */
  begin(): number
  /** token 是否仍是最新一次激活（旧的激活应在每个异步边界后检查并退出） */
  isCurrent(token: number): boolean
  /** 是否有激活正在进行：此时主题变化不必立即重应用，激活收尾会按当前主题落地 */
  isPending(): boolean
  /** 激活结束（成功、失败、被更新的激活取代都算） */
  end(): void
  /** 当前最新 token（无激活进行时用于诊断 / 测试） */
  current(): number
}

export const createActivationGate = (): ActivationGate => {
  let sequence = 0
  let pending = 0
  return {
    begin() {
      sequence += 1
      pending += 1
      return sequence
    },
    isCurrent(token) {
      return token === sequence
    },
    isPending() {
      return pending > 0
    },
    end() {
      if (pending > 0) {
        pending -= 1
      }
    },
    current() {
      return sequence
    },
  }
}

/**
 * 主题变化的延迟重应用：激活进行中时不能立刻用旧 active 应用新主题，
 * 先记下请求，等激活收尾（没有其它激活在跑）后再用最新 active + 当前主题应用一次。
 * 这样「快速切包 + 切主题」最终一定落在最后一次操作的状态上。
 */
export type DeferredReapply = {
  /** 请求一次重应用：没有激活时立即执行，有激活时延后 */
  request(): void
  /** 激活收尾时调用：满足条件时执行被延后的重应用 */
  flush(): void
}

export const createDeferredReapply = (
  isActivationPending: () => boolean,
  apply: () => void
): DeferredReapply => {
  let deferred = false
  return {
    request() {
      if (isActivationPending()) {
        deferred = true
        return
      }
      apply()
    },
    flush() {
      if (!deferred || isActivationPending()) {
        return
      }
      deferred = false
      apply()
    },
  }
}
