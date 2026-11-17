/**
 * 用量数据导出：把全部请求日志（IndexedDB `events` 全量，不受内存 200 条限制）
 * 与累计统计导出成 JSON / CSV，供用户自己处理。
 *
 * 构造数据的函数（buildUsageJson / buildUsageCsv / usageExportFilename / toIsoWithOffset）
 * 都是纯函数，界面只负责取数据与触发下载。
 */
import { getUsageState, listAllUsage, type UsageRecord, type UsageTotals } from './store.js'

export type UsageExportFormat = 'json' | 'csv'

/** downloaded：已触发下载；unsupported：当前环境（Android WebView）不支持 */
export type UsageExportResult = 'downloaded' | 'unsupported'

export type UsageExportPayload = {
  schema: 1
  exportedAt: string
  stats: UsageTotals
  events: UsageRecord[]
}

/** CSV 表头，顺序与每行字段一一对应 */
export const USAGE_CSV_HEADER = [
  'createdAt',
  'sessionId',
  'messageId',
  'protocol',
  'model',
  'inputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'outputTokens',
  'reasoningTokens',
  'searchCount',
  'safetyTokens',
  'durationMs',
  'totalTokens',
] as const

const pad = (value: number): string => String(value).padStart(2, '0')

/** 本地时区的 ISO 8601，例如 2026-11-18T03:30:00+08:00 */
export const toIsoWithOffset = (timestamp: number): string => {
  const date = new Date(timestamp)
  const offsetMinutes = -date.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const absolute = Math.abs(offsetMinutes)
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`
  )
}

/** 文件名里的本地时间戳：YYYYMMDD-HHmm */
export const usageExportStamp = (timestamp: number): string => {
  const date = new Date(timestamp)
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}`
  )
}

/** dslike-usage-YYYYMMDD-HHmm.json / .csv */
export const usageExportFilename = (
  format: UsageExportFormat,
  timestamp = Date.now()
): string => `dslike-usage-${usageExportStamp(timestamp)}.${format}`

/** 按 createdAt 升序；时间相同的保持读取顺序（IndexedDB 索引顺序） */
const sortByCreatedAt = (events: UsageRecord[]): UsageRecord[] =>
  [...events].sort((a, b) => a.createdAt - b.createdAt)

/**
 * JSON 导出内容：schema 恒为 1，exportedAt 是本地时区 ISO 8601，
 * stats 与 stats/totals 同结构，events 按 createdAt 升序。
 */
export const buildUsageJson = (
  events: UsageRecord[],
  totals: UsageTotals,
  timestamp = Date.now()
): string => {
  const payload: UsageExportPayload = {
    schema: 1,
    exportedAt: toIsoWithOffset(timestamp),
    stats: totals,
    events: sortByCreatedAt(events),
  }
  return JSON.stringify(payload, null, 2)
}

/** 含逗号、双引号、换行的字段按 RFC 4180 用双引号包裹，内部双引号翻倍 */
export const escapeCsvField = (value: string): string =>
  /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value

const optionalNumber = (value: number | undefined): string =>
  value === undefined ? '' : String(value)

/** CSV 导出内容：第一行表头，之后每行一条事件，行尾 RFC 4180 的 CRLF */
export const buildUsageCsv = (events: UsageRecord[]): string => {
  const rows = sortByCreatedAt(events).map((record) =>
    [
      toIsoWithOffset(record.createdAt),
      record.sessionId ?? '',
      record.messageId,
      record.protocol,
      record.model,
      String(record.inputTokens),
      String(record.cacheReadTokens),
      String(record.cacheWriteTokens),
      String(record.outputTokens),
      optionalNumber(record.reasoningTokens),
      optionalNumber(record.searchCount),
      optionalNumber(record.safetyTokens),
      optionalNumber(record.durationMs),
      String(record.totalTokens),
    ]
      .map(escapeCsvField)
      .join(',')
  )
  return [USAGE_CSV_HEADER.join(','), ...rows].join('\r\n')
}

type CapacitorGlobal = { isNativePlatform?: () => boolean }

/** 是否跑在 Capacitor 原生壳（Android WebView）里：原生环境下 a[download] 不生效 */
export const isNativePlatform = (): boolean => {
  const capacitor = (globalThis as unknown as { Capacitor?: CapacitorGlobal }).Capacitor
  return typeof capacitor?.isNativePlatform === 'function' && capacitor.isNativePlatform()
}

const triggerDownload = (filename: string, mime: string, content: string): void => {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

/**
 * 导出全部日志 + 当前累计统计。
 * 原生壳里返回 'unsupported'（由界面提示用户去桌面端导出），不静默失败。
 */
export const exportUsage = async (format: UsageExportFormat): Promise<UsageExportResult> => {
  if (isNativePlatform()) {
    return 'unsupported'
  }
  const events = await listAllUsage()
  const totals = getUsageState().totals
  const timestamp = Date.now()
  const filename = usageExportFilename(format, timestamp)
  if (format === 'json') {
    triggerDownload(filename, 'application/json', buildUsageJson(events, totals, timestamp))
  } else {
    triggerDownload(filename, 'text/csv', buildUsageCsv(events))
  }
  return 'downloaded'
}
