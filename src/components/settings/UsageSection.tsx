import clsx from 'clsx'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { usePresetStore } from '../../services/preset/store.js'
import { useSettings } from '../../services/settings.js'
import {
  canQueryBalance,
  fetchBalance,
  type BalanceSnapshot,
} from '../../services/usage/balance.js'
import {
  clearUsage,
  getUsageState,
  listUsage,
  subscribeUsage,
  type UsageRecord,
} from '../../services/usage/store.js'
import { Button } from '../base/Button.js'
import { IconRefreshOutline16 } from '../base/icons.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import settingsStyles from './Settings.module.css'
import styles from './UsageSection.module.css'

/** 用量统计分组的柱状图图标：与设置弹窗里的 InfoIcon / StyleIcon 一样用 16px 内联 SVG */
export const UsageIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
    <path d="M2.4 13.2h11.2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    <path
      d="M4.2 11V8.1M8 11V3.9M11.8 11V6.1"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
    />
  </svg>
)

/** 内存里只保留最近 200 条，统计范围与之一致 */
const USAGE_MEMORY_LIMIT = 200

/** 没有对应的字段（数据不存在）时显示 */
const MISSING = '—'

const formatCount = (value: number): string => value.toLocaleString()

const formatFixed1 = (value: number): string => value.toFixed(1)

const formatTime = (timestamp: number): string => new Date(timestamp).toLocaleString()

type UsageSummary = {
  requests: number
  total: number
  input: number
  cacheRead: number
  output: number
  /** cacheRead / (cacheRead + input)，没有输入时归为无数据 */
  cacheHitRate: number | null
  /** 输出 token / (Σ durationMs / 1000)，没有耗时时归为无数据 */
  averageRate: number | null
  reasoning: number | null
  search: number | null
  safety: number | null
}

/**
 * 统计口径：
 * - 缓存命中率 = 缓存命中输入 / (缓存命中输入 + 未命中缓存的输入)
 * - 平均生成速率 = 输出 token / (总耗时秒数)
 * - 推理 / 搜索 / 安全审查只累计带对应字段的记录；一条都没有时返回 null（界面显示「—」）
 */
const summarize = (records: UsageRecord[]): UsageSummary => {
  let total = 0
  let input = 0
  let cacheRead = 0
  let output = 0
  let duration = 0
  let reasoning = 0
  let search = 0
  let safety = 0
  let hasReasoning = false
  let hasSearch = false
  let hasSafety = false
  for (const record of records) {
    total += record.totalTokens
    input += record.inputTokens
    cacheRead += record.cacheReadTokens
    output += record.outputTokens
    duration += record.durationMs ?? 0
    if (record.reasoningTokens !== undefined) {
      hasReasoning = true
      reasoning += record.reasoningTokens
    }
    if (record.searchCount !== undefined) {
      hasSearch = true
      search += record.searchCount
    }
    if (record.safetyTokens !== undefined) {
      hasSafety = true
      safety += record.safetyTokens
    }
  }
  const prompt = cacheRead + input
  return {
    requests: records.length,
    total,
    input,
    cacheRead,
    output,
    cacheHitRate: prompt > 0 ? (cacheRead / prompt) * 100 : null,
    averageRate: duration > 0 ? output / (duration / 1000) : null,
    reasoning: hasReasoning ? reasoning : null,
    search: hasSearch ? search : null,
    safety: hasSafety ? safety : null,
  }
}

/** 单个统计项：标签在上、数值在下 */
const Stat = ({ label, value }: { label: string; value: string }) => (
  <div className={styles.stat}>
    <div className={styles.statLabel}>{label}</div>
    <div className={styles.statValue}>{value}</div>
  </div>
)

const BalanceField = ({ label, value }: { label: string; value: string }) => (
  <div className={styles.balanceField}>
    <div className={styles.balanceFieldLabel}>{label}</div>
    <div className={styles.balanceFieldValue}>{value}</div>
  </div>
)

/**
 * DeepSeek 账户余额：只有当前预设指向 api.deepseek.com 时才出现。
 * 没填 API Key 时提示去「数据管理」，失败时保留刷新入口。
 */
const BalanceCard = ({ onOpenData }: { onOpenData: () => void }) => {
  const t = useTranslate()
  const apiKey = useSettings((state) => state.apiKey)
  const [snapshot, setSnapshot] = useState<BalanceSnapshot | null>(null)
  const [loading, setLoading] = useState(apiKey !== null)
  const [failed, setFailed] = useState(false)
  const busyRef = useRef(false)

  const load = useCallback(async () => {
    if (!apiKey) {
      setSnapshot(null)
      setFailed(false)
      setLoading(false)
      return
    }
    if (busyRef.current) {
      return
    }
    busyRef.current = true
    setLoading(true)
    setFailed(false)
    try {
      setSnapshot(await fetchBalance(apiKey))
    } catch {
      setSnapshot(null)
      setFailed(true)
    } finally {
      busyRef.current = false
      setLoading(false)
    }
  }, [apiKey])

  // 进入分组或更换 API Key 时自动查询一次
  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className={styles.card} aria-busy={loading}>
      <div className={styles.cardHeader}>
        <div className={styles.cardTitle}>{t('usageBalanceTitle')}</div>
        {apiKey ? (
          <Button
            variant="outlined"
            size="m"
            className={styles.cardButton}
            disabled={loading}
            onClick={() => void load()}
          >
            <IconRefreshOutline16 />
            {t(loading ? 'usageBalanceRefreshing' : 'usageBalanceRefresh')}
          </Button>
        ) : null}
      </div>
      {!apiKey ? (
        <div className={styles.balanceMissing}>
          <div className={styles.hint}>{t('usageBalanceNoApiKey')}</div>
          <Button variant="outlined" size="m" className={styles.cardButton} onClick={onOpenData}>
            {t('usageBalanceGoData')}
          </Button>
        </div>
      ) : failed ? (
        <div className={styles.error} role="alert">
          {t('usageBalanceFailed')}
        </div>
      ) : snapshot ? (
        <>
          <div className={styles.balanceStatus}>
            <span
              className={clsx(
                styles.badge,
                snapshot.isAvailable ? styles.badgeAvailable : styles.badgeUnavailable
              )}
            >
              {t(snapshot.isAvailable ? 'usageBalanceAvailable' : 'usageBalanceUnavailable')}
            </span>
          </div>
          {snapshot.infos.length === 0 ? (
            <div className={styles.hint}>{t('usageBalanceEmpty')}</div>
          ) : (
            <ul className={styles.balanceList}>
              {snapshot.infos.map((info, index) => (
                <li key={`${info.currency}-${index}`} className={styles.balanceItem}>
                  <div className={styles.balanceCurrency}>{info.currency || MISSING}</div>
                  <div className={styles.balanceFields}>
                    <BalanceField label={t('usageBalanceTotal')} value={info.totalBalance} />
                    <BalanceField label={t('usageBalanceGranted')} value={info.grantedBalance} />
                    <BalanceField label={t('usageBalanceToppedUp')} value={info.toppedUpBalance} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}
      {loading && !snapshot ? (
        <div className={styles.hint} role="status">
          {t('usageBalanceRefreshing')}
        </div>
      ) : null}
    </div>
  )
}

/** 清空前的二次确认，叠在设置弹窗之上 */
const ClearConfirm = ({
  clearing,
  onCancel,
  onConfirm,
}: {
  clearing: boolean
  onCancel: () => void
  onConfirm: () => void
}) => {
  const t = useTranslate()
  return (
    <Modal
      title={t('usageClearConfirmTitle')}
      className={settingsStyles.deleteConfirm}
      onClose={onCancel}
      footer={
        <div className={settingsStyles.deleteActions} aria-busy={clearing}>
          <Button variant="outlined" size="m" autoFocus disabled={clearing} onClick={onCancel}>
            {t('cancel')}
          </Button>
          <Button variant="danger" size="m" disabled={clearing} onClick={onConfirm}>
            {t(clearing ? 'usageClearing' : 'usageClear')}
          </Button>
        </div>
      }
    >
      <div>{t('usageClearConfirmDescription')}</div>
    </Modal>
  )
}

/**
 * 用量统计分组：余额卡片（可查询时）、请求与 token 汇总、最近请求列表与清空入口。
 * 订阅 usage store；App 启动时 initUsage 已恢复最近记录，这里再读一次兜底。
 */
export const UsageSection = ({ onOpenData }: { onOpenData: () => void }) => {
  const t = useTranslate()
  const usage = useSyncExternalStore(subscribeUsage, getUsageState)
  // 预设加载 / 切换后重新判断能否查询余额（canQueryBalance 读取当前启用预设）
  const balanceAvailable = usePresetStore(() => canQueryBalance())
  const [restored, setRestored] = useState<UsageRecord[] | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [clearing, setClearing] = useState(false)
  const clearingRef = useRef(false)

  // 首次挂载时按内存上限读一次，保证恢复失败时也能拿到完整记录
  useEffect(() => {
    let cancelled = false
    void listUsage(USAGE_MEMORY_LIMIT).then((records) => {
      if (!cancelled) {
        setRestored(records)
      }
    })
    return () => {
      cancelled = true
    }
  }, [])

  const records = usage.ready ? usage.records : (restored ?? [])
  const summary = summarize(records)

  const confirmClear = async () => {
    if (clearingRef.current) {
      return
    }
    clearingRef.current = true
    setClearing(true)
    try {
      await clearUsage()
      setRestored(null)
      setConfirmOpen(false)
      showToast({ key: 'usageCleared' })
    } catch {
      showToast({ key: 'usageClearFailed', type: 'error' })
    } finally {
      clearingRef.current = false
      setClearing(false)
    }
  }

  return (
    <div className={styles.section}>
      {balanceAvailable ? <BalanceCard onOpenData={onOpenData} /> : null}
      <div className={styles.card}>
        <div className={styles.cardHeader}>
          <div className={styles.cardTitle}>{t('usageStatsTitle')}</div>
          {records.length > 0 ? (
            <div className={styles.cardMeta}>{t('usageStatsScope', { count: records.length })}</div>
          ) : null}
        </div>
        {records.length === 0 ? (
          <div className={styles.empty}>
            <div className={styles.emptyTitle}>{t('usageEmpty')}</div>
            <div className={styles.emptyHint}>{t('usageEmptyHint')}</div>
          </div>
        ) : (
          <div className={styles.stats}>
            <Stat label={t('usageRequests')} value={formatCount(summary.requests)} />
            <Stat label={t('usageTotalTokens')} value={formatCount(summary.total)} />
            <Stat label={t('usageInputTokens')} value={formatCount(summary.input)} />
            <Stat label={t('usageCacheReadTokens')} value={formatCount(summary.cacheRead)} />
            <Stat label={t('usageOutputTokens')} value={formatCount(summary.output)} />
            <Stat
              label={t('usageCacheHitRate')}
              value={
                summary.cacheHitRate === null ? MISSING : `${formatFixed1(summary.cacheHitRate)}%`
              }
            />
            <Stat
              label={t('usageAverageRate')}
              value={
                summary.averageRate === null
                  ? MISSING
                  : `${formatFixed1(summary.averageRate)} tok/s`
              }
            />
            <Stat
              label={t('usageReasoningTokens')}
              value={summary.reasoning === null ? MISSING : formatCount(summary.reasoning)}
            />
            <Stat
              label={t('usageSearchCount')}
              value={summary.search === null ? MISSING : formatCount(summary.search)}
            />
            <Stat
              label={t('usageSafetyTokens')}
              value={summary.safety === null ? MISSING : formatCount(summary.safety)}
            />
          </div>
        )}
      </div>
      {records.length === 0 ? null : (
        <>
          <div className={styles.card}>
            <div className={styles.cardHeader}>
              <div className={styles.cardTitle}>{t('usageRecentTitle')}</div>
            </div>
            <ul className={styles.requests} aria-label={t('usageRecentTitle')}>
              <li className={styles.requestHead} aria-hidden="true">
                <span className={styles.requestTime}>{t('usageRecentTime')}</span>
                <span className={styles.requestModel}>{t('usageRecentModel')}</span>
                <span className={styles.requestTokens}>{t('usageRecentTokens')}</span>
                <span className={styles.requestDuration}>{t('usageRecentDuration')}</span>
              </li>
              {records.map((record) => (
                <li key={record.id} className={styles.request}>
                  <span className={styles.requestTime}>{formatTime(record.createdAt)}</span>
                  <span className={styles.requestModel}>
                    {record.protocol} · {record.model}
                  </span>
                  <span className={styles.requestTokens}>
                    {formatCount(record.inputTokens)} / {formatCount(record.cacheReadTokens)} /{' '}
                    {formatCount(record.outputTokens)}
                  </span>
                  <span className={styles.requestDuration}>
                    {record.durationMs === undefined
                      ? MISSING
                      : `${formatCount(record.durationMs)} ms`}
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <div className={styles.clearRow}>
            <Button
              variant="dangerOutlined"
              size="m"
              className={styles.cardButton}
              onClick={() => setConfirmOpen(true)}
            >
              {t('usageClear')}
            </Button>
          </div>
        </>
      )}
      {confirmOpen ? (
        <ClearConfirm
          clearing={clearing}
          onCancel={() => {
            if (!clearingRef.current) {
              setConfirmOpen(false)
            }
          }}
          onConfirm={() => void confirmClear()}
        />
      ) : null}
    </div>
  )
}
