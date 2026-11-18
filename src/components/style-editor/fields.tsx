/**
 * 样式包编辑器共用的小组件与钩子：区块 / 字段 / 上传行、文件校验、主题选项、颜色转换。
 *
 * 放在单独模块里，让「控件编辑面板」（StyleEditPanel）与「元数据编辑界面」
 * （StyleEditMetadata）共用同一套表单外观；两边只负责各自的数据与交互。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslate, type TranslationMessage } from '../../i18n/index.js'
import {
  createDraftFile,
  validateDraftFile,
  type StyleDraftFile,
  type StyleDraftFileKind,
} from '../../services/style/editor.js'
import { useStyleEditStore } from '../../services/style/editStore.js'
import type { Theme } from '../../services/style/types.js'
import { Button } from '../base/Button.js'
import { showToast } from '../base/toastState.js'
import { STYLE_EDIT_ISSUE_KEYS, styleEditIssueParams } from './messages.js'
import styles from './StyleEditMode.module.css'

export const ACCEPT_IMAGE =
  '.png,.webp,.jpg,.jpeg,.gif,.svg,.avif,image/png,image/webp,image/jpeg,image/gif,image/svg+xml,image/avif'
export const ACCEPT_COVER =
  '.png,.webp,.jpg,.jpeg,.svg,image/png,image/webp,image/jpeg,image/svg+xml'
export const ACCEPT_FONT = '.ttf,.otf,.woff,.woff2,font/ttf,font/otf,font/woff,font/woff2'

/** 编辑主题选项（亮 / 暗），文案沿用详情页的主题名 */
export const THEME_OPTIONS: Array<{
  value: Theme
  key: 'stylePackDetailThemeLight' | 'stylePackDetailThemeDark'
}> = [
  { value: 'light', key: 'stylePackDetailThemeLight' },
  { value: 'dark', key: 'stylePackDetailThemeDark' },
]

const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
const RGB_COLOR = /^rgba?\(\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})/i

/** 把 CSS 颜色尽量转成 `<input type="color">` 可显示的值 */
export const toColorInputValue = (value: string): string => {
  const trimmed = value.trim()
  if (HEX_COLOR.test(trimmed)) {
    if (trimmed.length === 4) {
      return `#${trimmed[1]}${trimmed[1]}${trimmed[2]}${trimmed[2]}${trimmed[3]}${trimmed[3]}`
    }
    if (trimmed.length === 5) {
      return `#${trimmed[1]}${trimmed[1]}${trimmed[2]}${trimmed[2]}${trimmed[3]}${trimmed[3]}`
    }
    return trimmed.length === 9 ? trimmed.slice(0, 7) : trimmed
  }
  const rgb = RGB_COLOR.exec(trimmed)
  if (rgb) {
    return `#${[rgb[1], rgb[2], rgb[3]]
      .map((part) => Math.min(255, Number(part)).toString(16).padStart(2, '0'))
      .join('')}`
  }
  return '#000000'
}

/** 去掉某个主题项（主题只有亮 / 暗两个静态键） */
export const omitTheme = <T,>(
  record: Partial<Record<Theme, T>>,
  removed: Theme
): Partial<Record<Theme, T>> =>
  removed === 'light'
    ? record.dark
      ? { dark: record.dark }
      : {}
    : record.light
      ? { light: record.light }
      : {}

/** blob → objectURL（卸载 / blob 变化时释放） */
export const useBlobUrl = (blob: Blob | undefined): string | undefined => {
  const [url, setUrl] = useState<string | undefined>(undefined)
  useEffect(() => {
    if (!blob) {
      setUrl(undefined)
      return
    }
    const next = URL.createObjectURL(blob)
    setUrl(next)
    return () => URL.revokeObjectURL(next)
  }, [blob])
  return url
}

/** 区块标题 + 提示 */
export const Section = ({
  title,
  hint,
  children,
}: {
  title: string
  hint?: string
  children: ReactNode
}) => (
  <section className={styles.section}>
    <div className={styles.sectionHead}>
      <h3 className={styles.sectionTitle}>{title}</h3>
      {hint ? <p className={styles.sectionHint}>{hint}</p> : null}
    </div>
    {children}
  </section>
)

/** 表单字段：label + 控件 + 错误 / 提示 */
export const Field = ({
  label,
  htmlFor,
  error,
  hint,
  children,
}: {
  label: string
  htmlFor?: string
  error?: string
  hint?: string
  children: ReactNode
}) => (
  <div className={styles.field}>
    {htmlFor ? (
      <label className={styles.fieldLabel} htmlFor={htmlFor}>
        {label}
      </label>
    ) : (
      <div className={styles.fieldLabel}>{label}</div>
    )}
    {children}
    {error ? (
      <div className={styles.fieldError} role="alert">
        {error}
      </div>
    ) : hint ? (
      <div className={styles.fieldHint}>{hint}</div>
    ) : null}
  </div>
)

/** 图片 / 字体上传行：缩略图 + 上传 / 替换 / 清除（面板里比表单版更紧凑） */
export const AssetField = ({
  label,
  file,
  accept,
  error,
  preview = true,
  onPick,
  onClear,
}: {
  label: string
  file?: StyleDraftFile
  accept: string
  error?: string
  preview?: boolean
  onPick: (file: File) => void
  onClear: () => void
}) => {
  const t = useTranslate()
  const inputRef = useRef<HTMLInputElement>(null)
  const url = useBlobUrl(preview ? file?.blob : undefined)
  return (
    <div className={styles.assetRow}>
      <div className={styles.assetHead}>
        <span className={styles.assetName}>{label}</span>
        <span className={styles.assetState}>{file ? file.fileName : t('styleEditNone')}</span>
      </div>
      <div className={styles.assetBody}>
        {preview ? (
          <span className={styles.thumb}>
            {url ? (
              <img className={styles.thumbImage} src={url} alt="" />
            ) : (
              <span className={styles.thumbEmpty} />
            )}
          </span>
        ) : null}
        <span className={styles.assetActions}>
          <Button variant="outlined" size="s" onClick={() => inputRef.current?.click()}>
            {t(file ? 'styleEditReplace' : 'styleEditUpload')}
          </Button>
          {file ? (
            <Button variant="outlined" size="s" onClick={onClear}>
              {t('styleEditClear')}
            </Button>
          ) : null}
        </span>
      </div>
      {error ? (
        <div className={styles.fieldError} role="alert">
          {error}
        </div>
      ) : null}
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        hidden
        onChange={(event) => {
          const picked = event.target.files?.[0]
          event.target.value = ''
          if (picked) {
            onPick(picked)
          }
        }}
      />
    </div>
  )
}

/** 上传文件先做类型 / 大小校验；不合格时 toast 提示原因，不写进草稿 */
export const useAcceptFile = (): ((
  picked: File,
  kind: StyleDraftFileKind,
  apply: (file: StyleDraftFile) => void
) => void) => {
  return (picked, kind, apply) => {
    const file = createDraftFile(picked, picked.name)
    const issue = validateDraftFile(file, kind)
    if (issue) {
      const status: TranslationMessage & { type: 'error' } = {
        key: STYLE_EDIT_ISSUE_KEYS[issue.code],
        params: styleEditIssueParams(issue),
        type: 'error',
      }
      showToast(status)
      return
    }
    apply(file)
  }
}

/** 把 issues 里的字段路径转成当前语言的错误文案（没有对应问题返回 undefined） */
export const useIssueAt = (): ((path: string) => string | undefined) => {
  const t = useTranslate()
  const issues = useStyleEditStore((state) => state.issues)
  return (path: string): string | undefined => {
    const issue = issues.find((entry) => entry.path === path)
    return issue ? t(STYLE_EDIT_ISSUE_KEYS[issue.code], styleEditIssueParams(issue)) : undefined
  }
}
