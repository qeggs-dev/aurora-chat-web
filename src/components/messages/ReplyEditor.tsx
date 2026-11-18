import clsx from 'clsx'
import { useTranslate } from '../../i18n/index.js'
import { useLayoutEffect, useRef, useState } from 'react'
import { Button } from '../base/Button.js'
import styles from './ReplyEditor.module.css'

/** 自动高度上限（px）；手机端键盘弹出后超出视口的部分交给页面滚动 */
const MAX_HEIGHT = 400

/**
 * 助手回复正文的就地编辑器：多行 textarea，随内容自动长高，保留原始 markdown 文本。
 * Esc 取消、Ctrl/Cmd+Enter 保存；内容为空时禁用保存并提示。
 * 草稿只保存在组件状态里：切会话、刷新或卸载都不会写库。
 */
export const ReplyEditor = ({
  initial,
  onCancel,
  onSave,
}: {
  /** 进入编辑时的原始 markdown 文本 */
  initial: string
  onCancel: () => void
  /** 保存成功后由调用方收起编辑器；返回 false 时保留草稿与编辑器 */
  onSave: (content: string) => Promise<boolean>
}) => {
  const t = useTranslate()
  const [draft, setDraft] = useState(initial)
  const [saving, setSaving] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const empty = draft.trim() === ''

  useLayoutEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) {
      return
    }
    textarea.style.height = 'auto'
    textarea.style.height = `${Math.min(textarea.scrollHeight, MAX_HEIGHT)}px`
  }, [draft])

  // 移动端键盘弹出会压缩可视区域：把输入框滚回可视范围，避免被键盘遮住。
  useLayoutEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) {
      return
    }
    const reveal = () => textarea.scrollIntoView({ block: 'center', behavior: 'smooth' })
    textarea.focus({ preventScroll: true })
    const frame = requestAnimationFrame(reveal)
    const viewport = window.visualViewport
    viewport?.addEventListener('resize', reveal)
    return () => {
      cancelAnimationFrame(frame)
      viewport?.removeEventListener('resize', reveal)
    }
  }, [])

  const save = async () => {
    if (empty || saving) {
      return
    }
    setSaving(true)
    const saved = await onSave(draft.trim())
    if (!saved) {
      setSaving(false)
    }
  }

  return (
    <div className={styles.editor} data-reply-editor>
      <textarea
        ref={textareaRef}
        className={styles.textarea}
        aria-label={t('replyEdit')}
        rows={1}
        value={draft}
        disabled={saving}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) {
            return
          }
          if (event.key === 'Escape') {
            event.preventDefault()
            if (!saving) {
              onCancel()
            }
          } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault()
            void save()
          }
        }}
      />
      <div className={styles.footer}>
        <span className={clsx(styles.hint, !empty && styles.hintHidden)}>
          {empty ? t('replyEditEmpty') : ''}
        </span>
        <Button size="s" variant="outlined" disabled={saving} onClick={onCancel}>
          {t('replyEditCancel')}
        </Button>
        <Button size="s" disabled={empty || saving} onClick={save}>
          {t('replyEditSave')}
        </Button>
      </div>
    </div>
  )
}
