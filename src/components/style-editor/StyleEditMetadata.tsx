/**
 * 样式包「元数据编辑」界面：从悬浮面板的控件编辑里拆出来的包级数据。
 *
 * 入口在面板标题栏（「编辑元数据」）与编辑模式工具栏；面板内切换，标题栏按钮返回控件编辑。
 * 这里只负责表单：基本信息、编辑主题、字体、包图标 / 封面（含包级 effects）、配色。
 * 所有修改都写进同一份 draft，实时预览与保存 / 导出流程保持不变。
 */
import clsx from 'clsx'
import { useId, useState } from 'react'
import { useTranslate, type TranslationMessage } from '../../i18n/index.js'
import { PALETTE_VARS } from '../../services/style/apply.js'
import type { StyleDraftFile, StyleEditorDraft } from '../../services/style/editor.js'
import {
  setStyleEditTheme,
  updateStyleDraft,
  useStyleEditStore,
} from '../../services/style/editStore.js'
import { PALETTE_KEYS, type PaletteColorKey, type Theme } from '../../services/style/types.js'
import { Button } from '../base/Button.js'
import {
  ACCEPT_COVER,
  ACCEPT_FONT,
  ACCEPT_IMAGE,
  AssetField,
  Field,
  Section,
  THEME_OPTIONS,
  omitTheme,
  toColorInputValue,
  useAcceptFile,
  useIssueAt,
} from './fields.js'
import {
  EFFECT_GROUPS_COVER,
  EFFECT_GROUPS_PACK_ICON,
  StyleEditEffects,
} from './StyleEditEffects.js'
import { useStyleLabels } from './labels.js'
import styles from './StyleEditMode.module.css'

/* ============================ 基本信息 ============================ */

const BasicInfoSection = () => {
  const t = useTranslate()
  const draft = useStyleEditStore((state) => state.draft)
  const issueAt = useIssueAt()
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
  const setText = (key: keyof StyleEditorDraft, value: string): void => {
    updateStyleDraft((current) => ({ ...current, [key]: value }))
  }
  return (
    <Section title={t('styleEditBasicSection')}>
      <Field
        label={t('styleEditFieldId')}
        htmlFor={idField}
        hint={t('styleEditIdHint')}
        error={issueAt('id')}
      >
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
      <Field
        label={t('styleEditFieldDescription')}
        htmlFor={descriptionField}
        error={issueAt('description')}
      >
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
      <Field
        label={t('styleEditFieldLicense')}
        htmlFor={licenseField}
        error={issueAt('licenseText')}
      >
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

/* ============================ 编辑主题 ============================ */

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

/* ============================ 字体 ============================ */

const FontSection = () => {
  const t = useTranslate()
  const draft = useStyleEditStore((state) => state.draft)
  const acceptFile = useAcceptFile()
  const issueAt = useIssueAt()
  if (!draft) {
    return null
  }
  const theme = draft.theme
  return (
    <Section title={t('styleEditFontSection')} hint={t('styleEditFontHint')}>
      <AssetField
        label={t('stylePackDetailFonts')}
        file={draft.fonts[theme]}
        accept={ACCEPT_FONT}
        preview={false}
        error={issueAt(`fonts.${theme}`)}
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

/* ============================ 包图标 / 封面 + 包级 effects ============================ */

const PackImageSection = () => {
  const t = useTranslate()
  const draft = useStyleEditStore((state) => state.draft)
  const acceptFile = useAcceptFile()
  const issueAt = useIssueAt()
  if (!draft) {
    return null
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
      covers: file ? { ...current.covers, [theme]: file } : omitTheme(current.covers, theme),
    }))
  }
  const updateEffects = (
    kind: 'packIcons' | 'covers',
    theme: Theme,
    effects: StyleDraftFile['effects']
  ): void => {
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
              setIcon(option.value, {
                ...pickedFile,
                effects: draft.packIcons[option.value]?.effects,
              })
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
                setCover(option.value, {
                  ...pickedFile,
                  effects: draft.covers[option.value]?.effects,
                })
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

/* ============================ 配色 ============================ */

const PaletteSection = () => {
  const t = useTranslate()
  const labels = useStyleLabels()
  const draft = useStyleEditStore((state) => state.draft)
  const issueAt = useIssueAt()
  const [status, setStatus] = useState<TranslationMessage | null>(null)
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
            <span className={styles.paletteLabel} title={key} data-raw-token={key}>
              {labels.palette(key)}
            </span>
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

/* ============================ 元数据界面 ============================ */

/** 包级数据编辑：基本信息 / 编辑主题 / 字体 / 包图标与封面（含包级 effects）/ 配色 */
export const StyleEditMetadata = () => {
  const t = useTranslate()
  return (
    <div className={styles.metadata} data-style-edit-metadata>
      <p className={styles.metadataHint}>{t('styleEditMetadataHint')}</p>
      <BasicInfoSection />
      <ThemeSection />
      <FontSection />
      <PackImageSection />
      <PaletteSection />
    </div>
  )
}
