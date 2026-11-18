import clsx from 'clsx'
import type { Source } from '../../services/chat/view.js'
import { formatDate } from '../../utils/format.js'
import { isWebUrl } from '../../utils/url.js'
import { SiteLogo } from './SiteLogo.js'
import styles from './SourceCard.module.css'

/** 显示为 YYYY/MM/DD；无法解析的日期原样显示 */
const formatPublishedAt = (value: string | null) => (value ? (formatDate(value, '/') ?? value) : '')

/**
 * 搜索结果卡片：站点图标与名称、日期、标题、摘要。
 * 元数据缺失时省略摘要，图标使用链接图标兜底。
 * 只有 http/https 来源渲染成链接，其他协议只展示内容。
 */
export const SourceCard = ({ source, className }: { source: Source; className?: string }) => {
  const date = formatPublishedAt(source.publishedAt)
  const card = (
    <div className={clsx(styles.card, className)}>
      <div className={styles.meta}>
        <SiteLogo url={source.siteIcon} className={styles.siteIcon} />
        {source.siteName ? <span className={styles.siteName}>{source.siteName}</span> : null}
        {source.siteName && date ? <span className={styles.divider} /> : null}
        {date ? <span className={styles.date}>{date}</span> : null}
      </div>
      <div className={styles.title}>{source.title}</div>
      {source.snippet ? <div className={styles.snippet}>{source.snippet}</div> : null}
    </div>
  )
  return isWebUrl(source.url) ? (
    <a className={styles.anchor} href={source.url} target="_blank" rel="noreferrer">
      {card}
    </a>
  ) : (
    card
  )
}
