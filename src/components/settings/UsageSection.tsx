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
import { exportUsage, type UsageExportFormat } from '../../services/usage/export.js'
import {
  clearUsageLog,
  getUsageState,
  isUsageTotalsEmpty,
  listUsage,
  resetUsageStats,
  subscribeUsage,
  type UsageRecord,
  type UsageTotals,
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

/** 内存里只保留最近 200 条用于列表；统计面板读累计 totals，不再受这个上限影响 */
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
  reasoning: number
  search: number
  safety: number
}

/**
 * 统计口径（数据来自累计 totals，不是从最近 200 条记录现算）：
 * - 缓存命中率 = 缓存命中输入 / (缓存命中输入 + 未命中缓存的输入)
 * - 平均生成速率 = 输出 token / (总耗时秒数)
 */
const summarize = (totals: UsageTotals): UsageSummary => {
  const prompt = totals.cacheReadTokens + totals.inputTokens
  return {
    requests: totals.requests,
    total: totals.totalTokens,
    input: totals.inputTokens,
    cacheRead: totals.cacheReadTokens,
    output: totals.outputTokens,
    cacheHitRate: prompt > 0 ? (totals.cacheReadTokens / prompt) * 100 : null,
    averageRate: totals.durationMs > 0 ? totals.outputTokens / (totals.durationMs / 1000) : null,
    reasoning: totals.reasoningTokens,
    search: totals.searchCount,
    safety: totals.safetyTokens,
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

/** 破坏性操作前的二次确认，叠在设置弹窗之上 */
const ClearConfirm = ({
  title,
  description,
  confirmLabel,
  busy,
  onCancel,
  onConfirm,
}: {
  title: string
  description: string
  confirmLabel: string
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}) => {
  const t = useTranslate()
  return (
    <Modal
      title={title}
      className={settingsStyles.deleteConfirm}
      onClose={onCancel}
      footer={
        <div className={settingsStyles.deleteActions} aria-busy={busy}>
          <Button variant="outlined" size="m" autoFocus disabled={busy} onClick={onCancel}>
            {t('cancel')}
          </Button>
          <Button variant="danger" size="m" disabled={busy} onClick={onConfirm}>
            {busy ? t('usageClearing') : confirmLabel}
          </Button>
        </div>
      }
    >
      <div>{description}</div>
    </Modal>
  )
}

/**
 * 用量统计分组：
 * - 统计面板读累计 totals（独立于请求日志，清日志不影响、也不受 200 条上限影响）；
 * - 最近请求列表读内存里的最近 records；
 * - 底部「导出 JSON / 导出 CSV」「仅清理日志」「全部置零」，清理各有独立二次确认。
 * 订阅 usage store；App 启动时 initUsage 已恢复数据，这里再读一次列表兜底。
 */
export const UsageSection = ({ onOpenData }: { onOpenData: () => void }) => {
  const t = useTranslate()
  const usage = useSyncExternalStore(subscribeUsage, getUsageState)
  // 预设加载 / 切换后重新判断能否查询余额（canQueryBalance 读取当前启用预设）
  const balanceAvailable = usePresetStore(() => canQueryBalance())
  const [restored, setRestored] = useState<UsageRecord[] | null>(null)
  const [pendingClear, setPendingClear] = useState<'log' | 'reset' | null>(null)
  const [clearing, setClearing] = useState(false)
  const [exporting, setExporting] = useState(false)
  const clearingRef = useRef(false)
  const exportingRef = useRef(false)

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
  const totals = usage.totals
  const hasLog = records.length > 0
  const hasStats = !isUsageTotalsEmpty(totals)
  const summary = summarize(totals)

  const confirmClear = async () => {
    if (pendingClear === null || clearingRef.current) {
      return
    }
    const kind = pendingClear
    clearingRef.current = true
    setClearing(true)
    try {
      if (kind === 'log') {
        await clearUsageLog()
      } else {
        await resetUsageStats()
      }
      setPendingClear(null)
      setRestored(null)
      showToast({ key: kind === 'log' ? 'usageLogCleared' : 'usageResetDone' })
    } catch {
      showToast({ key: 'usageClearFailed', type: 'error' })
    } finally {
      clearingRef.current = false
      setClearing(false)
    }
  }

  const runExport = async (format: UsageExportFormat) => {
    if (exportingRef.current) {
      return
    }
    exportingRef.current = true
    setExporting(true)
    try {
      const result = await exportUsage(format)
      if (result === 'unsupported') {
        showToast({ key: 'usageExportUnsupported', type: 'error' })
      } else {
        showToast({ key: 'usageExportDone' })
      }
    } catch {
      showToast({ key: 'usageExportFailed', type: 'error' })
    } finally {
      exportingRef.current = false
      setExporting(false)
    }
  }

  return (
    <div className={styles.section}>
      {balanceAvailable ? <BalanceCard onOpenData={onOpenData} /> : null}
      <div className={styles.card}>
        <div className={styles.cardHeader}>
          <div className={styles.cardTitle}>{t('usageStatsTitle')}</div>
          {hasStats ? (
            <div className={styles.cardMeta}>
              {t('usageStatsScope', { count: summary.requests })}
            </div>
          ) : null}
        </div>
        {hasStats ? (
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
            <Stat label={t('usageReasoningTokens')} value={formatCount(summary.reasoning)} />
            <Stat label={t('usageSearchCount')} value={formatCount(summary.search)} />
            <Stat label={t('usageSafetyTokens')} value={formatCount(summary.safety)} />
          </div>
        ) : (
          <div className={styles.empty}>
            <div className={styles.emptyTitle}>{t('usageEmpty')}</div>
            <div className={styles.emptyHint}>{t('usageEmptyHint')}</div>
          </div>
        )}
      </div>
      {hasLog ? (
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
      ) : hasStats ? (
        <div className={styles.card}>
          <div className={styles.logEmpty} role="status">
            <div className={styles.logEmptyTitle}>{t('usageLogEmpty')}</div>
            <div className={styles.hint}>{t('usageLogEmptyHint')}</div>
          </div>
        </div>
      ) : null}
      <div className={styles.actions}>
        <div className={styles.actionsGroup}>
          <Button
            variant="outlined"
            size="m"
            className={styles.cardButton}
            disabled={exporting}
            onClick={() => void runExport('json')}
          >
            {t('usageExportJson')}
          </Button>
          <Button
            variant="outlined"
            size="m"
            className={styles.cardButton}
            disabled={exporting}
            onClick={() => void runExport('csv')}
          >
            {t('usageExportCsv')}
          </Button>
        </div>
        <div className={styles.actionsGroup}>
          <Button
            variant="outlined"
            size="m"
            className={styles.cardButton}
            disabled={!hasLog || clearing}
            onClick={() => setPendingClear('log')}
          >
            {t('usageClearLog')}
          </Button>
          <Button
            variant="dangerOutlined"
            size="m"
            className={styles.cardButton}
            disabled={(!hasStats && !hasLog) || clearing}
            onClick={() => setPendingClear('reset')}
          >
            {t('usageReset')}
          </Button>
        </div>
      </div>
      {pendingClear === 'log' ? (
        <ClearConfirm
          title={t('usageClearLogConfirmTitle')}
          description={t('usageClearLogConfirm')}
          confirmLabel={t('usageClearLog')}
          busy={clearing}
          onCancel={() => {
            if (!clearingRef.current) {
              setPendingClear(null)
            }
          }}
          onConfirm={() => void confirmClear()}
        />
      ) : null}
      {pendingClear === 'reset' ? (
        <ClearConfirm
          title={t('usageResetConfirmTitle')}
          description={t('usageResetConfirm')}
          confirmLabel={t('usageReset')}
          busy={clearing}
          onCancel={() => {
            if (!clearingRef.current) {
              setPendingClear(null)
            }
          }}
          onConfirm={() => void confirmClear()}
        />
      ) : null}
    </div>
  )
}
