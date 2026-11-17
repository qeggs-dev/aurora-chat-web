import { useTranslate } from '../../i18n/index.js'
import { PackIcon } from '../base/PackIcon.js'
import { STYLE_SLOTS } from '../../services/style/types.js'
import { useRef } from 'react'
import type { MessageVersions } from '../../services/chat/branches.js'
import { IconChevronRightOutline14 } from '../base/icons.js'
import { IconButton } from '../base/IconButton.js'
import styles from './BranchSwitcher.module.css'

export type { MessageVersions } from '../../services/chat/branches.js'
export type SelectMessageVersion = (messageId: string, anchorTop: number) => void

export const BranchSwitcher = ({
  versions,
  disabled,
  onSelect,
}: {
  versions: MessageVersions
  disabled: boolean
  onSelect: SelectMessageVersion
}) => {
  const t = useTranslate()
  const anchorRef = useRef<HTMLDivElement>(null)
  const { ids, index } = versions
  const select = (messageId: string) => {
    if (anchorRef.current) {
      onSelect(messageId, anchorRef.current.getBoundingClientRect().top)
    }
  }
  if (ids.length <= 1) {
    return null
  }
  return (
    <div
      ref={anchorRef}
      className={styles.switcher}
      aria-label={t('messageVersions')}
      data-message-version={ids[index]}
    >
      <IconButton
        icon={<PackIcon slot={STYLE_SLOTS.iconLeftArrow} size={14} fallback={<IconChevronRightOutline14 />} />}
        className={styles.previous}
        aria-label={t('previousVersion')}
        disabled={disabled || index <= 0}
        onClick={() => select(ids[index - 1])}
      />
      <span className={styles.count}>
        {index + 1} / {ids.length}
      </span>
      <IconButton
        icon={<PackIcon slot={STYLE_SLOTS.iconRightArrow} size={14} fallback={<IconChevronRightOutline14 />} />}
        aria-label={t('nextVersion')}
        disabled={disabled || index >= ids.length - 1}
        onClick={() => select(ids[index + 1])}
      />
    </div>
  )
}
