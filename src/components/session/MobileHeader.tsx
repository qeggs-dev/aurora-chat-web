import clsx from 'clsx'
import { IconMenuOutline20, IconNewChatOutline20, IconVolumeOutline20 } from '../base/icons.js'
import { PackIcon } from '../base/PackIcon.js'
import { STYLE_SLOTS } from '../../services/style/types.js'
import { useTranslate } from '../../i18n/index.js'
import { useSettings } from '../../services/settings.js'
import { newChat } from '../../services/chat/store.js'
import { setAutoReadEnabled } from '../../services/speech/autoReadRuntime.js'
import { IconButton } from '../base/IconButton.js'
import { openMobileSider } from '../sider/mobileSiderState.js'
import styles from './MobileHeader.module.css'

/**
 * 自动朗读开关：点击即开关，出现在会话页「开启新对话」左侧；欢迎页显示在右端。
 * 点击本身是用户手势，setAutoReadEnabled 在同一事件里预热共享 AudioContext，自动朗读复用它。
 * 图标槽位有 40 个的规范，这里不新增 style 槽位，直接使用内置喇叭图标。
 */
const AutoReadButton = () => {
  const t = useTranslate()
  const enabled = useSettings((state) => state.autoReadAloud)
  return (
    <IconButton
      size="xl"
      tone="primary"
      className={clsx(enabled && styles.active)}
      aria-pressed={enabled}
      tooltip={t(enabled ? 'autoReadOn' : 'autoReadOff')}
      icon={<IconVolumeOutline20 />}
      onClick={() => setAutoReadEnabled(!enabled)}
    />
  )
}

/** 移动端顶栏：左侧菜单打开侧边栏；会话页再显示标题、自动朗读与开启新对话 */
export const MobileHeader = ({ title }: { title?: string }) => {
  const t = useTranslate()
  return (
    <div className={styles.header}>
      <IconButton
        size="xl"
        tone="primary"
        icon={
          <PackIcon slot={STYLE_SLOTS.iconMobileMenu} size={20} fallback={<IconMenuOutline20 />} />
        }
        aria-label={t('expandSiderbarButton')}
        onClick={openMobileSider}
      />
      {title === undefined ? (
        <>
          {/* 欢迎页没有新对话按钮：喇叭开关放在右端 */}
          <div className={styles.spacer} />
          <AutoReadButton />
        </>
      ) : (
        <>
          <div className={styles.title}>{title}</div>
          <AutoReadButton />
          <IconButton
            size="xl"
            tone="primary"
            icon={
              <PackIcon
                slot={STYLE_SLOTS.iconNewSession}
                size={20}
                fallback={<IconNewChatOutline20 />}
              />
            }
            aria-label={t('newChat')}
            onClick={newChat}
          />
        </>
      )}
    </div>
  )
}
