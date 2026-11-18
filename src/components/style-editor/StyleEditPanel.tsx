import clsx from 'clsx'
import {
  useEffect,
  useId,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import { useTranslate, type TranslationMessage } from '../../i18n/index.js'
import { PALETTE_VARS } from '../../services/style/apply.js'
import {
  backgroundSlotName,
  createDraftFile,
  iconSlotName,
  validateDraftFile,
  type StyleDraftBackground,
  type StyleDraftFile,
  type StyleDraftFileKind,
  type StyleEditorDraft,
} from '../../services/style/editor.js'
import {
  selectStyleEditSlot,
  setStyleEditTheme,
  styleEditIsDirty,
  updateStyleDraft,
  useStyleEditStore,
} from '../../services/style/editStore.js'
import {
  PALETTE_KEYS,
  STYLE_ALIGNS,
  STYLE_ALIGN_DEFAULT,
  STYLE_FITS,
  STYLE_FIT_DEFAULT,
  STYLE_RENDERS,
  STYLE_RENDER_DEFAULT,
  type PaletteColorKey,
  type StyleAlign,
  type StyleFit,
  type StyleRender,
  type StyleSlot,
  type Theme,
} from '../../services/style/types.js'
import { styleEditTargetKind, styleEditTargetLabel } from './targets.js'
import {
  EFFECT_GROUPS_BACKGROUND,
  EFFECT_GROUPS_COVER,
  EFFECT_GROUPS_ICON,
  EFFECT_GROUPS_PACK_ICON,
  StyleEditEffects,
} from './StyleEditEffects.js'
import { STYLE_EDIT_ISSUE_KEYS, styleEditIssueParams } from './messages.js'
import { Button } from '../base/Button.js'
import { Select, type SelectOption } from '../base/Select.js'
import { showToast } from '../base/toastState.js'
import styles from './StyleEditMode.module.css'

const ACCEPT_IMAGE =
  '.png,.webp,.jpg,.jpeg,.gif,.svg,.avif,image/png,image/webp,image/jpeg,image/gif,image/svg+xml,image/avif'
const ACCEPT_COVER = '.png,.webp,.jpg,.jpeg,.svg,image/png,image/webp,image/jpeg,image/svg+xml'
const ACCEPT_FONT = '.ttf,.otf,.woff,.woff2,font/ttf,font/otf,font/woff,font/woff2'

const fitOptions: SelectOption<StyleFit>[] = STYLE_FITS.map((value) => ({ value, label: value }))
const alignOptions: SelectOption<StyleAlign>[] = STYLE_ALIGNS.map((value) => ({
  value,
  label: value,
}))
const renderOptions: SelectOption<StyleRender>[] = STYLE_RENDERS.map((value) => ({
  value,
  label: value,
}))

const THEME_OPTIONS: Array<{ value: Theme; key: 'stylePackDetailThemeLight' | 'stylePackDetailThemeDark' }> = [
  { value: 'light', key: 'stylePackDetailThemeLight' },
  { value: 'dark', key: 'stylePackDetailThemeDark' },
]

const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
const RGB_COLOR = /^rgba?\(\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})/i

/** 把 CSS 颜色尽量转成 `<input type="color">` 可显示的值 */
const toColorInputValue = (value: string): string => {
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

const useBlobUrl = (blob: Blob | undefined): string | undefined => {
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

/** 去掉某个槽位（用拷贝代替 delete 动态键，规避 typescript/no-dynamic-delete） */
const omitSlot = <T,>(
  record: Partial<Record<StyleSlot, T>>,
  slot: StyleSlot
): Partial<Record<StyleSlot, T>> => {
  const next: Partial<Record<StyleSlot, T>> = {}
  for (const key of Object.keys(record) as StyleSlot[]) {
    if (key !== slot) {
      next[key] = record[key]
    }
  }
  return next
}

/** 去掉某个主题项（主题只有亮 / 暗两个静态键） */
const omitTheme = <T,>(
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

const Section = ({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) => (
  <section className={styles.section}>
    <div className={styles.sectionHead}>
      <h3 className={styles.sectionTitle}>{title}</h3>
      {hint ? <p className={styles.sectionHint}>{hint}</p> : null}
    </div>
    {children}
  </section>
)

const Field = ({
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
const AssetField = ({
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
            {url ? <img className={styles.thumbImage} src={url} alt="" /> : <span className={styles.thumbEmpty} />}
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
const useAcceptFile = () => {
  return (
    picked: File,
    kind: StyleDraftFileKind,
    apply: (file: StyleDraftFile) => void
  ): void => {
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

/* ============================ 控件修改面板 ============================ */

const BackgroundSlotEditor = ({ slot }: { slot: StyleSlot }) => {
  const t = useTranslate()
  const draft = useStyleEditStore((state) => state.draft)
  const issues = useStyleEditStore((state) => state.issues)
  const acceptFile = useAcceptFile()
  if (!draft) {
    return null
  }
  const theme = draft.theme
  const file = draft.backgrounds[theme][slot]
  const basePath = `backgrounds.${theme}.${slot}`
  const issueAt = (path: string): string | undefined => {
    const issue = issues.find((entry) => entry.path === path)
    return issue ? t(STYLE_EDIT_ISSUE_KEYS[issue.code], styleEditIssueParams(issue)) : undefined
  }
  const patch = (next: Partial<StyleDraftBackground>): void => {
    updateStyleDraft((current) => {
      const existing = current.backgrounds[theme][slot]
      if (!existing) {
        return current
      }
      return {
        ...current,
        backgrounds: {
          ...current.backgrounds,
          [theme]: { ...current.backgrounds[theme], [slot]: { ...existing, ...next } },
        },
      }
    })
  }
  const fit = file?.fit ?? STYLE_FIT_DEFAULT
  const align = file?.align ?? STYLE_ALIGN_DEFAULT
  const render = file?.render ?? STYLE_RENDER_DEFAULT
  return (
    <div className={styles.slotEditor}>
      <AssetField
        label={backgroundSlotName(slot)}
        file={file}
        accept={ACCEPT_IMAGE}
        error={issueAt(basePath)}
        onPick={(picked) =>
          acceptFile(picked, 'background', (pickedFile) =>
            updateStyleDraft((current) => ({
              ...current,
              backgrounds: {
                ...current.backgrounds,
                [theme]: {
                  ...current.backgrounds[theme],
                  [slot]: {
                    ...pickedFile,
                    fit: current.backgrounds[theme][slot]?.fit,
                    align: current.backgrounds[theme][slot]?.align,
                    position: current.backgrounds[theme][slot]?.position,
                    render: current.backgrounds[theme][slot]?.render,
                    effects: current.backgrounds[theme][slot]?.effects,
                  },
                },
              },
            }))
          )
        }
        onClear={() =>
          updateStyleDraft((current) => ({
            ...current,
            backgrounds: {
              ...current.backgrounds,
              [theme]: omitSlot(current.backgrounds[theme], slot),
            },
          }))
        }
      />
      {file ? (
        <>
          <div className={styles.options}>
            <div className={styles.option}>
              <span className={styles.optionLabel}>{t('stylePackDetailFit')}</span>
              <Select<StyleFit>
                ariaLabel={`${slot} fit`}
                className={styles.select}
                value={fit}
                options={fitOptions}
                onChange={(value) => patch({ fit: value })}
              />
            </div>
            <div className={styles.option}>
              <span className={styles.optionLabel}>{t('stylePackDetailAlign')}</span>
              <Select<StyleAlign>
                ariaLabel={`${slot} align`}
                className={styles.select}
                value={align}
                options={alignOptions}
                onChange={(value) => patch({ align: value })}
              />
            </div>
            <div className={styles.option}>
              <span className={styles.optionLabel}>{t('stylePackDetailRender')}</span>
              <Select<StyleRender>
                ariaLabel={`${slot} render`}
                className={styles.select}
                value={render}
                options={renderOptions}
                onChange={(value) => patch({ render: value })}
              />
            </div>
          </div>
          <div className={styles.field}>
            <span className={styles.optionLabel}>{t('stylePackDetailPosition')}</span>
            <input
              className={clsx(styles.input, issueAt(`${basePath}.position`) && styles.inputInvalid)}
              value={file.position ?? ''}
              placeholder={t('styleEditPositionPlaceholder')}
              aria-label={`${slot} position`}
              onChange={(event) => patch({ position: event.target.value })}
            />
            {issueAt(`${basePath}.position`) ? (
              <div className={styles.fieldError} role="alert">
                {issueAt(`${basePath}.position`)}
              </div>
            ) : null}
          </div>
          <div className={styles.field}>
            <span className={styles.fieldLabel}>{t('styleEditEffectsSection')}</span>
            <StyleEditEffects
              effects={file.effects}
              groups={EFFECT_GROUPS_BACKGROUND}
              onChange={(effects) => patch({ effects })}
            />
          </div>
        </>
      ) : null}
    </div>
  )
}

const IconSlotEditor = ({ slot }: { slot: StyleSlot }) => {
  const t = useTranslate()
  const draft = useStyleEditStore((state) => state.draft)
  const issues = useStyleEditStore((state) => state.issues)
  const acceptFile = useAcceptFile()
  if (!draft) {
    return null
  }
  const theme = draft.theme
  const file = draft.icons[theme][slot]
  const basePath = `icons.${theme}.${slot}`
  const issueAt = (path: string): string | undefined => {
    const issue = issues.find((entry) => entry.path === path)
    return issue ? t(STYLE_EDIT_ISSUE_KEYS[issue.code], styleEditIssueParams(issue)) : undefined
  }
  const patch = (next: Partial<StyleDraftFile>): void => {
    updateStyleDraft((current) => {
      const existing = current.icons[theme][slot]
      if (!existing) {
        return current
      }
      return {
        ...current,
        icons: {
          ...current.icons,
          [theme]: { ...current.icons[theme], [slot]: { ...existing, ...next } },
        },
      }
    })
  }
  return (
    <div className={styles.slotEditor}>
      <AssetField
        label={iconSlotName(slot)}
        file={file}
        accept={ACCEPT_IMAGE}
        error={issueAt(basePath)}
        onPick={(picked) =>
          acceptFile(picked, 'icon', (pickedFile) =>
            updateStyleDraft((current) => {
              const existing = current.icons[theme][slot]
              return {
                ...current,
                icons: {
                  ...current.icons,
                  [theme]: {
                    ...current.icons[theme],
                    [slot]: {
                      ...pickedFile,
                      render: existing?.render,
                      effects: existing?.effects,
                    },
                  },
                },
              }
            })
          )
        }
        onClear={() =>
          updateStyleDraft((current) => ({
            ...current,
            icons: { ...current.icons, [theme]: omitSlot(current.icons[theme], slot) },
          }))
        }
      />
      {file ? (
        <>
          <div className={styles.option}>
            <span className={styles.optionLabel}>{t('stylePackDetailRender')}</span>
            <Select<StyleRender>
              ariaLabel={`${slot} render`}
              className={styles.select}
              value={file.render ?? STYLE_RENDER_DEFAULT}
              options={renderOptions}
              onChange={(value) => patch({ render: value })}
            />
          </div>
          <div className={styles.field}>
            <span className={styles.fieldLabel}>{t('styleEditEffectsSection')}</span>
            <StyleEditEffects
              effects={file.effects}
              groups={EFFECT_GROUPS_ICON}
              onChange={(effects) => patch({ effects })}
            />
          </div>
        </>
      ) : null}
    </div>
  )
}

const SidebarTitleEditor = () => {
  const t = useTranslate()
  const draft = useStyleEditStore((state) => state.draft)
  const issues = useStyleEditStore((state) => state.issues)
  const id = useId()
  if (!draft) {
    return null
  }
  const issue = issues.find((entry) => entry.path === 'sidebarTitle')
  return (
    <div className={styles.slotEditor}>
      <Field
        label={t('styleEditFieldSidebarTitle')}
        htmlFor={id}
        hint={t('styleEditSidebarTitleHint')}
        error={issue ? t(STYLE_EDIT_ISSUE_KEYS[issue.code], styleEditIssueParams(issue)) : undefined}
      >
        <input
          id={id}
          className={clsx(styles.input, issue && styles.inputInvalid)}
          value={draft.sidebarTitle}
          onChange={(event) =>
            updateStyleDraft((current) => ({ ...current, sidebarTitle: event.target.value }))
          }
        />
      </Field>
    </div>
  )
}

/** 选中控件后的修改面板：按控件类型上传 / 替换 / 清除 / 排版 / effects */
const SlotEditor = ({ slot }: { slot: string }) => {
  const t = useTranslate()
  const kind = styleEditTargetKind(slot)
  return (
    <Section
      title={`${t('styleEditSlotSection')} · ${styleEditTargetLabel(slot)}`}
      hint={t('styleEditSlotHint')}
    >
      <Button variant="outlined" size="s" onClick={() => selectStyleEditSlot(null)}>
        {t('styleEditBackToAll')}
      </Button>
      {kind === 'background' ? (
        <BackgroundSlotEditor slot={slot as StyleSlot} />
      ) : kind === 'icon' ? (
        <IconSlotEditor slot={slot as StyleSlot} />
      ) : kind === 'sidebarTitle' ? (
        <SidebarTitleEditor />
      ) : (
        <p className={styles.sectionHint}>{t('styleEditSlotUnsupported')}</p>
      )}
    </Section>
  )
}

/* ============================ 非元素级资源 ============================ */

const BasicInfoSection = () => {
  const t = useTranslate()
  const draft = useStyleEditStore((state) => state.draft)
  const issues = useStyleEditStore((state) => state.issues)
  const idField = useId()
  const nameField = useId()
  const authorField = useId()
  const versionField = useId()
  const descriptionField = useId()
  const copyrightField = useId()
  const licenseField = useId()
  if (!draft) {
    return null
  }
  const issueAt = (path: string): string | undefined => {
    const issue = issues.find((entry) => entry.path === path)
    return issue ? t(STYLE_EDIT_ISSUE_KEYS[issue.code], styleEditIssueParams(issue)) : undefined
  }
  const setText = (key: keyof StyleEditorDraft, value: string): void => {
    updateStyleDraft((current) => ({ ...current, [key]: value }))
  }
  return (
    <Section title={t('styleEditBasicSection')}>
      <Field label={t('styleEditFieldId')} htmlFor={idField} hint={t('styleEditIdHint')} error={issueAt('id')}>
        <input
          id={idField}
          className={clsx(styles.input, styles.readonly)}
          value={draft.id}
          readOnly
        />
      </Field>
      <Field label={t('styleEditFieldName')} htmlFor={nameField} error={issueAt('name')}>
        <input
          id={nameField}
          className={clsx(styles.input, issueAt('name') && styles.inputInvalid)}
          value={draft.name}
          onChange={(event) => setText('name', event.target.value)}
        />
      </Field>
      <div className={styles.grid}>
        <Field label={t('styleEditFieldAuthor')} htmlFor={authorField} error={issueAt('author')}>
          <input
            id={authorField}
            className={clsx(styles.input, issueAt('author') && styles.inputInvalid)}
            value={draft.author}
            onChange={(event) => setText('author', event.target.value)}
          />
        </Field>
        <Field label={t('styleEditFieldVersion')} htmlFor={versionField} error={issueAt('version')}>
          <input
            id={versionField}
            className={clsx(styles.input, issueAt('version') && styles.inputInvalid)}
            value={draft.version}
            onChange={(event) => setText('version', event.target.value)}
          />
        </Field>
      </div>
      <Field label={t('styleEditFieldDescription')} htmlFor={descriptionField} error={issueAt('description')}>
        <textarea
          id={descriptionField}
          className={clsx(styles.textarea, issueAt('description') && styles.inputInvalid)}
          rows={2}
          value={draft.description}
          onChange={(event) => setText('description', event.target.value)}
        />
      </Field>
      <Field
        label={t('styleEditFieldCopyright')}
        htmlFor={copyrightField}
        error={issueAt('copyright')}
        hint={t('styleEditCopyrightHint')}
      >
        <input
          id={copyrightField}
          className={clsx(styles.input, issueAt('copyright') && styles.inputInvalid)}
          value={draft.copyright}
          onChange={(event) => setText('copyright', event.target.value)}
        />
      </Field>
      <Field label={t('styleEditFieldLicense')} htmlFor={licenseField} error={issueAt('licenseText')}>
        <textarea
          id={licenseField}
          className={clsx(styles.textarea, issueAt('licenseText') && styles.inputInvalid)}
          rows={4}
          value={draft.licenseText}
          onChange={(event) => setText('licenseText', event.target.value)}
        />
      </Field>
    </Section>
  )
}

const ThemeSection = () => {
  const t = useTranslate()
  const draft = useStyleEditStore((state) => state.draft)
  if (!draft) {
    return null
  }
  return (
    <Section title={t('styleEditThemeSection')} hint={t('styleEditThemeHint')}>
      <div role="radiogroup" aria-label={t('styleEditThemeSection')} className={styles.themeTabs}>
        {THEME_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={draft.theme === option.value}
            className={clsx(styles.themeTab, draft.theme === option.value && styles.themeTabActive)}
            onClick={() => setStyleEditTheme(option.value)}
          >
            {t(option.key)}
          </button>
        ))}
      </div>
    </Section>
  )
}

const FontSection = () => {
  const t = useTranslate()
  const draft = useStyleEditStore((state) => state.draft)
  const issues = useStyleEditStore((state) => state.issues)
  const acceptFile = useAcceptFile()
  if (!draft) {
    return null
  }
  const theme = draft.theme
  const file = draft.fonts[theme]
  const issue = issues.find((entry) => entry.path === `fonts.${theme}`)
  return (
    <Section title={t('styleEditFontSection')} hint={t('styleEditFontHint')}>
      <AssetField
        label={t('stylePackDetailFonts')}
        file={file}
        accept={ACCEPT_FONT}
        preview={false}
        error={
          issue
            ? t(STYLE_EDIT_ISSUE_KEYS[issue.code], styleEditIssueParams(issue))
            : undefined
        }
        onPick={(picked) =>
          acceptFile(picked, 'font', (pickedFile) =>
            updateStyleDraft((current) => ({
              ...current,
              fonts: { ...current.fonts, [theme]: pickedFile },
            }))
          )
        }
        onClear={() =>
          updateStyleDraft((current) => ({ ...current, fonts: omitTheme(current.fonts, theme) }))
        }
      />
    </Section>
  )
}

const PackImageSection = () => {
  const t = useTranslate()
  const draft = useStyleEditStore((state) => state.draft)
  const issues = useStyleEditStore((state) => state.issues)
  const acceptFile = useAcceptFile()
  if (!draft) {
    return null
  }
  const issueAt = (path: string): string | undefined => {
    const issue = issues.find((entry) => entry.path === path)
    return issue ? t(STYLE_EDIT_ISSUE_KEYS[issue.code], styleEditIssueParams(issue)) : undefined
  }
  const setIcon = (theme: Theme, file: StyleDraftFile | undefined): void => {
    updateStyleDraft((current) => ({
      ...current,
      packIcons: file
        ? { ...current.packIcons, [theme]: file }
        : omitTheme(current.packIcons, theme),
    }))
  }
  const setCover = (theme: Theme, file: StyleDraftFile | undefined): void => {
    updateStyleDraft((current) => ({
      ...current,
      covers: file
        ? { ...current.covers, [theme]: file }
        : omitTheme(current.covers, theme),
    }))
  }
  const updateEffects = (kind: 'packIcons' | 'covers', theme: Theme, effects: StyleDraftFile['effects']): void => {
    updateStyleDraft((current) => {
      const existing = current[kind][theme]
      if (!existing) {
        return current
      }
      return { ...current, [kind]: { ...current[kind], [theme]: { ...existing, effects } } }
    })
  }
  return (
    <Section title={t('styleEditPackImageSection')} hint={t('styleEditPackImageHint')}>
      {THEME_OPTIONS.map((option) => (
        <AssetField
          key={`icon-${option.value}`}
          label={`${t('stylePackDetailPackageIcon')} · ${t(option.key)}`}
          file={draft.packIcons[option.value]}
          accept={ACCEPT_IMAGE}
          error={issueAt(`packIcons.${option.value}`)}
          onPick={(picked) =>
            acceptFile(picked, 'packIcon', (pickedFile) =>
              setIcon(option.value, { ...pickedFile, effects: draft.packIcons[option.value]?.effects })
            )
          }
          onClear={() => setIcon(option.value, undefined)}
        />
      ))}
      {THEME_OPTIONS.map((option) => (
        <div key={`cover-${option.value}`} className={styles.assetGroup}>
          <AssetField
            label={`${t('stylePackDetailCover')} · ${t(option.key)}`}
            file={draft.covers[option.value]}
            accept={ACCEPT_COVER}
            error={issueAt(`covers.${option.value}`)}
            onPick={(picked) =>
              acceptFile(picked, 'cover', (pickedFile) =>
                setCover(option.value, { ...pickedFile, effects: draft.covers[option.value]?.effects })
              )
            }
            onClear={() => setCover(option.value, undefined)}
          />
          {draft.covers[option.value] ? (
            <StyleEditEffects
              effects={draft.covers[option.value]?.effects}
              groups={EFFECT_GROUPS_COVER}
              onChange={(effects) => updateEffects('covers', option.value, effects)}
            />
          ) : null}
        </div>
      ))}
      {THEME_OPTIONS.map((option) =>
        draft.packIcons[option.value] ? (
          <StyleEditEffects
            key={`packicon-effects-${option.value}`}
            effects={draft.packIcons[option.value]?.effects}
            groups={EFFECT_GROUPS_PACK_ICON}
            onChange={(effects) => updateEffects('packIcons', option.value, effects)}
          />
        ) : null
      )}
    </Section>
  )
}

const PaletteSection = () => {
  const t = useTranslate()
  const draft = useStyleEditStore((state) => state.draft)
  const issues = useStyleEditStore((state) => state.issues)
  const [status, setStatus] = useState<TranslationMessage | null>(null)
  const issueAt = (path: string): string | undefined => {
    const issue = issues.find((entry) => entry.path === path)
    return issue ? t(STYLE_EDIT_ISSUE_KEYS[issue.code], styleEditIssueParams(issue)) : undefined
  }
  const setColor = (key: PaletteColorKey, value: string): void => {
    updateStyleDraft((current) => ({
      ...current,
      palette: {
        ...current.palette,
        [current.theme]: { ...current.palette[current.theme], [key]: value },
      },
    }))
  }
  const pickFromTheme = (): void => {
    const bodyStyle = getComputedStyle(document.body)
    const rootStyle = getComputedStyle(document.documentElement)
    const next: Partial<Record<PaletteColorKey, string>> = {}
    for (const key of PALETTE_KEYS) {
      for (const name of PALETTE_VARS[key]) {
        const value = (bodyStyle.getPropertyValue(name) || rootStyle.getPropertyValue(name)).trim()
        if (value) {
          next[key] = value
          break
        }
      }
    }
    if (Object.keys(next).length === 0) {
      setStatus({ key: 'styleEditPalettePickFailed' })
      return
    }
    updateStyleDraft((current) => ({
      ...current,
      palette: { ...current.palette, [current.theme]: next },
    }))
    setStatus({ key: 'styleEditPalettePicked' })
  }
  if (!draft) {
    return null
  }
  return (
    <Section title={t('styleEditPaletteSection')} hint={t('styleEditPaletteHint')}>
      <div className={styles.paletteToolbar}>
        <Button variant="outlined" size="s" onClick={pickFromTheme}>
          {t('styleEditPalettePick')}
        </Button>
        <Button
          variant="outlined"
          size="s"
          onClick={() =>
            updateStyleDraft((current) => ({
              ...current,
              palette: { ...current.palette, [current.theme]: {} },
            }))
          }
        >
          {t('styleEditPaletteClear')}
        </Button>
      </div>
      {status ? <p className={styles.sectionHint}>{t(status.key, status.params)}</p> : null}
      {PALETTE_KEYS.map((key) => {
        const value = draft.palette[draft.theme][key] ?? ''
        const error = issueAt(`palette.${draft.theme}.${key}`)
        return (
          <div key={key} className={styles.paletteRow}>
            <span className={styles.paletteLabel}>{key}</span>
            <input
              type="color"
              className={styles.colorPicker}
              aria-label={`${key} color picker`}
              value={toColorInputValue(value)}
              onChange={(event) => setColor(key, event.target.value)}
            />
            <input
              className={clsx(styles.input, error && styles.inputInvalid)}
              aria-label={`${key} CSS color`}
              value={value}
              placeholder={t('styleEditPaletteEmpty')}
              onChange={(event) => setColor(key, event.target.value)}
            />
            {error ? (
              <div className={styles.fieldError} role="alert">
                {error}
              </div>
            ) : null}
          </div>
        )
      })}
    </Section>
  )
}

/**
 * 面板标题栏的拖动事件：由 StyleEditMode 统一处理（位置状态也在那里），
 * 面板只把标题栏作为拖动手柄转发 pointerdown/move/up/cancel。
 */
export type StyleEditPanelDragHandlers = {
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void
  onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void
  onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void
  onPointerCancel: (event: ReactPointerEvent<HTMLDivElement>) => void
}

/**
 * 编辑模式侧面板：选中控件时显示该控件的修改面板，下面始终保留非元素级资源
 * （基本信息 / 主题 / 字体 / 包图标与封面 / 配色）的轻量表单。
 * 标题栏是拖动手柄（`dragHandlers` 由编辑模式传入），面板内部交互不受影响。
 */
export const StyleEditPanel = ({
  dragHandlers,
}: {
  dragHandlers?: StyleEditPanelDragHandlers
}) => {
  const t = useTranslate()
  const selectedSlot = useStyleEditStore((state) => state.selectedSlot)
  const issues = useStyleEditStore((state) => state.issues)
  const dirty = useStyleEditStore(() => styleEditIsDirty())
  const globalIssues = issues.filter(
    (issue) => issue.path === 'total' || issue.path === 'assets'
  )
  return (
    <div className={styles.panelBody}>
      <div
        className={styles.panelHead}
        data-style-edit-drag-handle
        onPointerDown={dragHandlers?.onPointerDown}
        onPointerMove={dragHandlers?.onPointerMove}
        onPointerUp={dragHandlers?.onPointerUp}
        onPointerCancel={dragHandlers?.onPointerCancel}
        onContextMenu={(event) => event.preventDefault()}
      >
        <span className={styles.panelGrip} aria-hidden>
          ⠿
        </span>
        <span className={styles.panelTitle}>{t('styleEditPanel')}</span>
        <span className={dirty ? styles.panelDirty : styles.panelSaved}>
          {t(dirty ? 'styleEditDirtyBadge' : 'styleEditSavedBadge')}
        </span>
      </div>
      {selectedSlot ? <SlotEditor slot={selectedSlot} /> : null}
      <BasicInfoSection />
      <ThemeSection />
      <FontSection />
      <PackImageSection />
      <PaletteSection />
      {globalIssues.map((issue) => (
        <div key={`${issue.path}-${issue.code}`} className={styles.statusError} role="alert">
          {t(STYLE_EDIT_ISSUE_KEYS[issue.code], styleEditIssueParams(issue))}
        </div>
      ))}
      <p className={styles.panelFooterHint}>{t('styleEditHint')}</p>
    </div>
  )
}
