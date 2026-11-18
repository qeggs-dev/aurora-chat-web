import clsx from 'clsx'
import { memo, useState, type CSSProperties } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { IconEditOutline16, IconEllipsisOutline16, IconTrashOutline16 } from '../base/icons.js'
import { PackIcon } from '../base/PackIcon.js'
import { STYLE_SLOTS } from '../../services/style/types.js'
import { renameSession, selectSession } from '../../services/chat/store.js'
import type { SessionSummary } from '../../services/chat/types.js'
import { IconButton } from '../base/IconButton.js'
import { Menu } from '../base/Menu.js'
import { closeMobileSider } from './mobileSiderState.js'
import type { StaggeredItem } from '../motion/useStaggeredList.js'
import styles from './SessionItem.module.css'

export const SessionItem = memo(function SessionItem({
  session,
  active,
  motion,
  onDelete,
  onSelect,
}: {
  session: SessionSummary
  active: boolean
  /** 进入 / 退出时的逐项动效（只对可视区项传入，屏幕外的不参与） */
  motion?: StaggeredItem
  onDelete: () => void
  /** 选中回调：移动端由侧边栏按「高亮 1/3」编排收起抽屉 */
  onSelect?: () => void
}) {
  const t = useTranslate()
  const [editing, setEditing] = useState(false)
  const displayTitle = session.title || t('untitledChat')
  // 动效只挂 class + animation-delay，位移/透明度全在 CSS keyframes 里
  const motionClass =
    motion === undefined
      ? undefined
      : motion.phase === 'enter'
        ? styles.itemEnter
        : styles.itemExit
  const motionStyle: CSSProperties | undefined =
    motion === undefined ? undefined : { animationDelay: `${motion.delayMs}ms` }

  if (editing) {
    const finish = (title: string) => {
      setEditing(false)
      if (title.trim() && title.trim() !== displayTitle) {
        renameSession(session.id, title.trim())
      }
    }
    return (
      <input
        className={styles.renameInput}
        defaultValue={displayTitle}
        autoFocus
        onFocus={(event) => event.target.select()}
        onBlur={(event) => finish(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            finish(event.currentTarget.value)
          } else if (event.key === 'Escape') {
            setEditing(false)
          }
        }}
      />
    )
  }

  return (
    <div
      className={clsx(styles.item, active && styles.active, motionClass)}
      style={motionStyle}
      data-motion-item={session.id}
      data-style-slot={active ? STYLE_SLOTS.bgSelectedSession : STYLE_SLOTS.bgNormalSession}
      onClick={() => {
        selectSession(session.id)
        if (onSelect) {
          onSelect()
        } else {
          closeMobileSider()
        }
      }}
    >
      <div className={styles.title}>{displayTitle}</div>
      <div className={styles.action} onClick={(event) => event.stopPropagation()}>
        <Menu
          options={[
            {
              key: 'rename',
              label: t('sessionItemMenuRenameOption'),
              icon: (
                <PackIcon slot={STYLE_SLOTS.iconEdit} size={16} fallback={<IconEditOutline16 />} />
              ),
              onSelect: () => setEditing(true),
            },
            {
              key: 'delete',
              label: t('delete'),
              icon: <PackIcon slot={STYLE_SLOTS.iconDelete} fallback={<IconTrashOutline16 />} />,
              danger: true,
              onSelect: onDelete,
            },
          ]}
        >
          {({ toggle }) => (
            <IconButton icon={<PackIcon slot={STYLE_SLOTS.iconMenu} fallback={<IconEllipsisOutline16 />} />} aria-label={t('more')} onClick={toggle} />
          )}
        </Menu>
      </div>
    </div>
  )
})
