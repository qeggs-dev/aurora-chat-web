/**
 * 就地编辑模式的悬浮面板。
 *
 * 面板只有两个视图（由 editStore 的 `panelView` 决定）：
 * - 控件编辑：当前选中控件的即时编辑（上传 / 替换 / 清除、fit / align / position / render、
 *   effects），以及「控件选择列表」兜底入口（背景 10 / 图标 40 / 侧边栏标题）——
 *   控件被面板或其他元素挡住时也能从列表里选中；
 * - 元数据编辑：包级数据（基本信息 / 编辑主题 / 字体 / 配色 / 包图标与封面 / 包级 effects），
 *   见 StyleEditMetadata。
 *
 * 标题栏是拖动手柄（`dragHandlers` 由编辑模式传入）；标题栏右侧的「编辑元数据 / 返回控件编辑」
 * 按钮会阻止 pointerdown 冒泡，避免点按钮变成拖动。
 */
import clsx from 'clsx'
import { useId } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { type StyleDraftBackground, type StyleDraftFile } from '../../services/style/editor.js'
import {
  selectStyleEditSlot,
  setStyleEditPanelView,
  styleEditIsDirty,
  updateStyleDraft,
  useStyleEditStore,
} from '../../services/style/editStore.js'
import {
  BACKGROUND_SLOTS,
  ICON_SLOTS,
  STYLE_ALIGNS,
  STYLE_ALIGN_DEFAULT,
  STYLE_FITS,
  STYLE_FIT_DEFAULT,
  STYLE_RENDERS,
  STYLE_RENDER_DEFAULT,
  type StyleAlign,
  type StyleFit,
  type StyleRender,
  type StyleSlot,
} from '../../services/style/types.js'
import { Button } from '../base/Button.js'
import { Select, type SelectOption } from '../base/Select.js'
import {
  EFFECT_GROUPS_BACKGROUND,
  EFFECT_GROUPS_ICON,
  StyleEditEffects,
} from './StyleEditEffects.js'
import { StyleEditMetadata } from './StyleEditMetadata.js'
import { ACCEPT_IMAGE, AssetField, Field, Section, useAcceptFile, useIssueAt } from './fields.js'
import { STYLE_EDIT_ISSUE_KEYS, styleEditIssueParams } from './messages.js'
import { useStyleSlotLabel } from './slotLabels.js'
import { STYLE_EDIT_SIDEBAR_TITLE, styleEditTargetKind } from './targets.js'
import styles from './StyleEditMode.module.css'

const fitOptions: SelectOption<StyleFit>[] = STYLE_FITS.map((value) => ({ value, label: value }))
const alignOptions: SelectOption<StyleAlign>[] = STYLE_ALIGNS.map((value) => ({
  value,
  label: value,
}))
const renderOptions: SelectOption<StyleRender>[] = STYLE_RENDERS.map((value) => ({
  value,
  label: value,
}))

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

/* ============================ 控件修改面板 ============================ */

const BackgroundSlotEditor = ({ slot }: { slot: StyleSlot }) => {
  const t = useTranslate()
  const slotLabel = useStyleSlotLabel()
  const draft = useStyleEditStore((state) => state.draft)
  const issueAt = useIssueAt()
  const acceptFile = useAcceptFile()
  if (!draft) {
    return null
  }
  const theme = draft.theme
  const file = draft.backgrounds[theme][slot]
  const basePath = `backgrounds.${theme}.${slot}`
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
        label={slotLabel(slot)}
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
  const slotLabel = useStyleSlotLabel()
  const draft = useStyleEditStore((state) => state.draft)
  const issueAt = useIssueAt()
  const acceptFile = useAcceptFile()
  if (!draft) {
    return null
  }
  const theme = draft.theme
  const file = draft.icons[theme][slot]
  const basePath = `icons.${theme}.${slot}`
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
        label={slotLabel(slot)}
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
  const issueAt = useIssueAt()
  const id = useId()
  if (!draft) {
    return null
  }
  const issue = issueAt('sidebarTitle')
  return (
    <div className={styles.slotEditor}>
      <Field
        label={t('styleEditFieldSidebarTitle')}
        htmlFor={id}
        hint={t('styleEditSidebarTitleHint')}
        error={issue}
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
  const slotLabel = useStyleSlotLabel()
  const kind = styleEditTargetKind(slot)
  return (
    <Section
      title={`${t('styleEditSlotSection')} · ${slotLabel(slot)}`}
      hint={t('styleEditSlotHint')}
    >
      <Button variant="outlined" size="s" onClick={() => selectStyleEditSlot(null)}>
        {t('styleEditClearSelection')}
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

/* ============================ 控件选择列表 ============================ */

/** 一组控件（背景 / 图标 / 其他）：可折起，按钮点击即选中并显示对应编辑项 */
const ControlGroup = ({
  title,
  slots,
  defaultOpen = false,
  selectedSlot,
}: {
  title: string
  slots: readonly string[]
  defaultOpen?: boolean
  selectedSlot: string | null
}) => {
  const slotLabel = useStyleSlotLabel()
  return (
    <details className={styles.controlGroup} open={defaultOpen}>
      <summary className={styles.controlGroupSummary}>
        <span>{title}</span>
        <span className={styles.controlCount}>{slots.length}</span>
      </summary>
      <div className={styles.controlGrid}>
        {slots.map((slot) => (
          <button
            key={slot}
            type="button"
            className={clsx(styles.controlChip, slot === selectedSlot && styles.controlChipActive)}
            aria-pressed={slot === selectedSlot}
            onClick={() => selectStyleEditSlot(slot)}
          >
            {slotLabel(slot)}
          </button>
        ))}
      </div>
    </details>
  )
}

/**
 * 控件选择列表：被面板 / 其他元素挡住的控件（如输入框右下角的发送按钮）也能从这里选中。
 * 未选中控件时展开、选中后收起，避免长列表把编辑表单挤到下面。
 */
const ControlPicker = ({ selectedSlot }: { selectedSlot: string | null }) => {
  const t = useTranslate()
  return (
    <details className={styles.controlPicker} open={selectedSlot === null} data-style-edit-controls>
      <summary className={styles.controlPickerSummary}>{t('styleEditControlsSection')}</summary>
      <p className={styles.controlPickerHint}>{t('styleEditControlsHint')}</p>
      <ControlGroup
        title={t('styleEditControlsBackgrounds')}
        slots={BACKGROUND_SLOTS}
        selectedSlot={selectedSlot}
        defaultOpen
      />
      <ControlGroup
        title={t('styleEditControlsIcons')}
        slots={ICON_SLOTS}
        selectedSlot={selectedSlot}
      />
      <ControlGroup
        title={t('styleEditControlsOther')}
        slots={[STYLE_EDIT_SIDEBAR_TITLE]}
        selectedSlot={selectedSlot}
        defaultOpen
      />
    </details>
  )
}

/* ============================ 面板外壳 ============================ */

/**
 * 面板标题栏的拖动事件：由 StyleEditMode 统一处理（位置状态也在那里），
 * 面板只把标题栏作为拖动手柄转发 pointerdown/move/up/cancel。
 */
export type StyleEditPanelDragHandlers = {
  onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void
  onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => void
  onPointerUp: (event: React.PointerEvent<HTMLDivElement>) => void
  onPointerCancel: (event: React.PointerEvent<HTMLDivElement>) => void
}

/**
 * 编辑模式悬浮面板：控件编辑（含控件选择列表）↔ 元数据编辑。
 * 标题栏是拖动手柄，右侧按钮切到元数据编辑 / 返回控件编辑。
 */
export const StyleEditPanel = ({ dragHandlers }: { dragHandlers?: StyleEditPanelDragHandlers }) => {
  const t = useTranslate()
  const panelView = useStyleEditStore((state) => state.panelView)
  const selectedSlot = useStyleEditStore((state) => state.selectedSlot)
  const issues = useStyleEditStore((state) => state.issues)
  const dirty = useStyleEditStore(() => styleEditIsDirty())
  const globalIssues = issues.filter((issue) => issue.path === 'total' || issue.path === 'assets')
  const metadata = panelView === 'metadata'
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
        <span className={styles.panelTitle}>
          {t(metadata ? 'styleEditMetadataTitle' : 'styleEditPanel')}
        </span>
        <span className={dirty ? styles.panelDirty : styles.panelSaved}>
          {t(dirty ? 'styleEditDirtyBadge' : 'styleEditSavedBadge')}
        </span>
        <Button
          variant="outlined"
          size="s"
          className={styles.panelModeButton}
          data-style-edit-metadata-toggle
          aria-pressed={metadata}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => setStyleEditPanelView(metadata ? 'controls' : 'metadata')}
        >
          {t(metadata ? 'styleEditMetadataBack' : 'styleEditMetadataOpen')}
        </Button>
      </div>
      {metadata ? (
        <StyleEditMetadata />
      ) : (
        <>
          {selectedSlot ? (
            <SlotEditor slot={selectedSlot} />
          ) : (
            <p className={styles.panelPlaceholder}>{t('styleEditNoSelection')}</p>
          )}
          <ControlPicker selectedSlot={selectedSlot} />
        </>
      )}
      {globalIssues.map((issue) => (
        <div key={`${issue.path}-${issue.code}`} className={styles.statusError} role="alert">
          {t(STYLE_EDIT_ISSUE_KEYS[issue.code], styleEditIssueParams(issue))}
        </div>
      ))}
      {metadata ? null : <p className={styles.panelFooterHint}>{t('styleEditHint')}</p>}
    </div>
  )
}
