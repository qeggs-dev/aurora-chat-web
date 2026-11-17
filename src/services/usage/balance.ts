/**
 * DeepSeek 余额查询：GET {origin}/user/balance（Bearer）。
 * 只有当前预设的 base_url 指向 api.deepseek.com 时才可用；其它服务商返回 null。
 */
import { API_ORIGIN } from '../api/client.js'
import { getActivePreset } from '../preset/store.js'

export type BalanceInfo = {
  currency: string
  totalBalance: string
  grantedBalance: string
  toppedUpBalance: string
}

export type BalanceSnapshot = {
  isAvailable: boolean
  infos: BalanceInfo[]
  fetchedAt: number
}

const DEEPSEEK_HOST = 'api.deepseek.com'

/** 当前配置是否支持余额查询 */
export const canQueryBalance = (): boolean => {
  const base = getActivePreset()?.base_url ?? API_ORIGIN
  try {
    return new URL(base).hostname === DEEPSEEK_HOST
  } catch {
    return false
  }
}

export const fetchBalance = async (apiKey: string): Promise<BalanceSnapshot | null> => {
  if (!canQueryBalance()) {
    return null
  }
  const base = getActivePreset()?.base_url ?? API_ORIGIN
  const origin = new URL(base).origin
  const response = await fetch(`${origin}/user/balance`, {
    headers: { authorization: `Bearer ${apiKey}` },
  })
  if (!response.ok) {
    throw new Error(`balance request failed: ${response.status}`)
  }
  const body = (await response.json()) as {
    is_available?: boolean
    balance_infos?: {
      currency?: string
      total_balance?: string
      granted_balance?: string
      topped_up_balance?: string
    }[]
  }
  return {
    isAvailable: Boolean(body.is_available),
    infos: (body.balance_infos ?? []).map((info) => ({
      currency: info.currency ?? '',
      totalBalance: info.total_balance ?? '0',
      grantedBalance: info.granted_balance ?? '0',
      toppedUpBalance: info.topped_up_balance ?? '0',
    })),
    fetchedAt: Date.now(),
  }
}
