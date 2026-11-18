/**
 * 样式包编辑模式的 effects 编辑器：按组开关 + 数值 / 颜色输入。
 * 取值范围与默认值沿用 docs/style-packs.md 与 `types.ts` 的 EFFECT_DEFAULTS / TILT_DEFAULTS，
 * 非法值由 `editor.ts` 的校验在保存 / 导出时拦下。
 *
 * 效果组名与字段名统一走 `labels.ts` 的本地化文案（效果组 / 字段的技术值只用于数据与
 * `data-*` 属性），详情页、悬浮面板、元数据编辑共用同一套映射。
 */
import clsx from 'clsx'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { EFFECT_DEFAULTS, TILT_DEFAULTS, type StyleEffects } from '../../services/style/types.js'
import { useStyleLabels } from './labels.js'
import styles from './StyleEditMode.module.css'

type FieldKind = 'number' | 'color'

type EffectField = {
  /** 清单里的技术字段名（提交时原样写入 effects） */
  key: string
  labelKey: TranslationKey
  kind: FieldKind
  min?: number
  max?: number
  step?: number
}

type ScalarSpec = { min: number; max: number; step: number; defaultValue: number }

export type EffectGroupKey =
  | 'opacity'
  | 'shadow'
  | 'outerGlow'
  | 'innerGlow'
  | 'emboss'
  | 'stroke'
  | 'window'
  | 'zoom'
  | 'tilt'

type EffectGroup = {
  key: EffectGroupKey
  /** 本地化组名 key */
  labelKey: TranslationKey
  scalar?: ScalarSpec
  fields?: EffectField[]
  defaults?: Record<string, number | string>
}

const EFFECT_GROUPS: Record<EffectGroupKey, EffectGroup> = {
  opacity: {
    key: 'opacity',
    labelKey: 'styleEffectGroupOpacity',
    scalar: { min: 0, max: 1, step: 0.05, defaultValue: 1 },
  },
  shadow: {
    key: 'shadow',
    labelKey: 'styleEffectGroupShadow',
    fields: [
      { key: 'x', labelKey: 'styleEffectFieldX', kind: 'number', min: -100, max: 100, step: 1 },
      { key: 'y', labelKey: 'styleEffectFieldY', kind: 'number', min: -100, max: 100, step: 1 },
      { key: 'blur', labelKey: 'styleEffectFieldBlur', kind: 'number', min: 0, max: 100, step: 1 },
      { key: 'color', labelKey: 'styleEffectFieldColor', kind: 'color' },
    ],
    defaults: { ...EFFECT_DEFAULTS.shadow },
  },
  outerGlow: {
    key: 'outerGlow',
    labelKey: 'styleEffectGroupOuterGlow',
    fields: [
      {
        key: 'radius',
        labelKey: 'styleEffectFieldRadius',
        kind: 'number',
        min: 0,
        max: 50,
        step: 1,
      },
      {
        key: 'intensity',
        labelKey: 'styleEffectFieldIntensity',
        kind: 'number',
        min: 0,
        max: 1,
        step: 0.05,
      },
      { key: 'color', labelKey: 'styleEffectFieldColor', kind: 'color' },
    ],
    defaults: { ...EFFECT_DEFAULTS.outerGlow },
  },
  innerGlow: {
    key: 'innerGlow',
    labelKey: 'styleEffectGroupInnerGlow',
    fields: [
      {
        key: 'radius',
        labelKey: 'styleEffectFieldRadius',
        kind: 'number',
        min: 0,
        max: 50,
        step: 1,
      },
      {
        key: 'intensity',
        labelKey: 'styleEffectFieldIntensity',
        kind: 'number',
        min: 0,
        max: 1,
        step: 0.05,
      },
      { key: 'color', labelKey: 'styleEffectFieldColor', kind: 'color' },
    ],
    defaults: { ...EFFECT_DEFAULTS.innerGlow },
  },
  emboss: {
    key: 'emboss',
    labelKey: 'styleEffectGroupEmboss',
    fields: [
      {
        key: 'depth',
        labelKey: 'styleEffectFieldDepth',
        kind: 'number',
        min: 0,
        max: 10,
        step: 0.5,
      },
      {
        key: 'angle',
        labelKey: 'styleEffectFieldAngle',
        kind: 'number',
        min: 0,
        max: 360,
        step: 5,
      },
      {
        key: 'intensity',
        labelKey: 'styleEffectFieldIntensity',
        kind: 'number',
        min: 0,
        max: 1,
        step: 0.05,
      },
    ],
    defaults: { ...EFFECT_DEFAULTS.emboss },
  },
  stroke: {
    key: 'stroke',
    labelKey: 'styleEffectGroupStroke',
    fields: [
      { key: 'width', labelKey: 'styleEffectFieldWidth', kind: 'number', min: 0, max: 20, step: 1 },
      { key: 'color', labelKey: 'styleEffectFieldColor', kind: 'color' },
    ],
    defaults: { ...EFFECT_DEFAULTS.stroke },
  },
  window: {
    key: 'window',
    labelKey: 'styleEffectGroupWindow',
    fields: [
      { key: 'x1', labelKey: 'styleEffectFieldX1', kind: 'number', min: 0, max: 1, step: 0.05 },
      { key: 'y1', labelKey: 'styleEffectFieldY1', kind: 'number', min: 0, max: 1, step: 0.05 },
      { key: 'x2', labelKey: 'styleEffectFieldX2', kind: 'number', min: 0, max: 1, step: 0.05 },
      { key: 'y2', labelKey: 'styleEffectFieldY2', kind: 'number', min: 0, max: 1, step: 0.05 },
    ],
    defaults: { x1: 0, y1: 0, x2: 1, y2: 1 },
  },
  zoom: {
    key: 'zoom',
    labelKey: 'styleEffectGroupZoom',
    scalar: { min: 0, max: 4, step: 0.05, defaultValue: 1 },
  },
  tilt: {
    key: 'tilt',
    labelKey: 'styleEffectGroupTilt',
    fields: [
      {
        key: 'maxAngle',
        labelKey: 'styleEffectFieldMaxAngle',
        kind: 'number',
        min: 0,
        max: 30,
        step: 1,
      },
      {
        key: 'perspective',
        labelKey: 'styleEffectFieldPerspective',
        kind: 'number',
        min: 200,
        max: 2000,
        step: 50,
      },
      {
        key: 'scale',
        labelKey: 'styleEffectFieldScale',
        kind: 'number',
        min: 0.8,
        max: 1.2,
        step: 0.01,
      },
    ],
    defaults: { ...TILT_DEFAULTS },
  },
}

/** 各资源允许出现的 effects 组（与导入校验的允许矩阵一致） */
export const EFFECT_GROUPS_BACKGROUND: EffectGroupKey[] = ['window', 'zoom']
export const EFFECT_GROUPS_ICON: EffectGroupKey[] = [
  'opacity',
  'shadow',
  'outerGlow',
  'innerGlow',
  'emboss',
  'stroke',
  'window',
  'zoom',
  'tilt',
]
export const EFFECT_GROUPS_PACK_ICON: EffectGroupKey[] = [
  'opacity',
  'shadow',
  'outerGlow',
  'innerGlow',
  'emboss',
  'stroke',
  'window',
  'zoom',
]
export const EFFECT_GROUPS_COVER: EffectGroupKey[] = ['window', 'zoom', 'tilt']

const asRecord = (value: unknown): Record<string, number | string | undefined> =>
  value !== null && typeof value === 'object'
    ? (value as Record<string, number | string | undefined>)
    : {}

const pruneEffects = (
  effects: StyleEffects,
  groups: readonly EffectGroupKey[]
): StyleEffects | undefined => {
  const pruned: Record<string, unknown> = {}
  for (const key of groups) {
    const value = effects[key]
    if (value !== undefined) {
      pruned[key] = value
    }
  }
  return Object.keys(pruned).length > 0 ? (pruned as StyleEffects) : undefined
}

/**
 * effects 编辑器：每个效果组一个开关，打开时写入该组默认值；组内字段按清单里的范围输入。
 * 组名 / 字段名显示本地化文案，提交的 effects 仍使用 `EffectGroup.key` / `EffectField.key`。
 */
export const StyleEditEffects = ({
  effects,
  groups,
  onChange,
}: {
  effects: StyleEffects | undefined
  groups: readonly EffectGroupKey[]
  onChange: (effects: StyleEffects | undefined) => void
}) => {
  const t = useTranslate()
  const labels = useStyleLabels()
  const current = effects ?? {}

  const toggle = (group: EffectGroup, enabled: boolean): void => {
    if (!enabled) {
      // 用拷贝 + 过滤代替 delete 动态键（lint 规则 typescript/no-dynamic-delete）
      const next: Record<string, unknown> = {}
      for (const key of Object.keys(current) as EffectGroupKey[]) {
        if (key !== group.key) {
          next[key] = current[key]
        }
      }
      onChange(pruneEffects(next as StyleEffects, groups))
      return
    }
    const next: StyleEffects = { ...current }
    if (next[group.key] === undefined) {
      Object.assign(next, {
        [group.key]: group.scalar ? group.scalar.defaultValue : { ...group.defaults },
      })
    }
    onChange(pruneEffects(next, groups))
  }

  const setValue = (group: EffectGroup, field: string, value: number | string): void => {
    const next: StyleEffects = { ...current }
    if (group.scalar) {
      Object.assign(next, { [group.key]: value })
    } else {
      Object.assign(next, {
        [group.key]: { ...asRecord(current[group.key]), [field]: value },
      })
    }
    onChange(pruneEffects(next, groups))
  }

  return (
    <div className={styles.effects}>
      {groups.map((key) => {
        const group = EFFECT_GROUPS[key]
        const enabled = current[key] !== undefined
        const groupLabel = labels.effectGroup(group.key)
        return (
          <div key={key} className={styles.effectGroup} data-effect-group-key={group.key}>
            <label className={styles.effectHead}>
              <input
                type="checkbox"
                checked={enabled}
                onChange={(event) => toggle(group, event.target.checked)}
              />
              <span className={styles.effectName}>{groupLabel}</span>
            </label>
            {enabled ? (
              group.scalar ? (
                <input
                  className={clsx(styles.input, styles.effectNumber)}
                  type="number"
                  min={group.scalar.min}
                  max={group.scalar.max}
                  step={group.scalar.step}
                  aria-label={groupLabel}
                  value={String(current[key] ?? '')}
                  onChange={(event) => setValue(group, group.key, Number(event.target.value))}
                />
              ) : (
                <div className={styles.effectFields}>
                  {group.fields?.map((field) => {
                    const values = asRecord(current[key])
                    const value = values[field.key]
                    const fieldLabel = labels.effectField(field.key)
                    return (
                      <label
                        key={field.key}
                        className={styles.effectField}
                        data-effect-field-key={field.key}
                      >
                        <span className={styles.effectFieldLabel}>{fieldLabel}</span>
                        <input
                          className={clsx(
                            styles.input,
                            field.kind === 'color' && styles.effectColor
                          )}
                          type={field.kind === 'number' ? 'number' : 'text'}
                          min={field.min}
                          max={field.max}
                          step={field.step}
                          aria-label={`${groupLabel} ${fieldLabel}`}
                          value={value === undefined ? '' : String(value)}
                          onChange={(event) =>
                            setValue(
                              group,
                              field.key,
                              field.kind === 'number'
                                ? Number(event.target.value)
                                : event.target.value
                            )
                          }
                        />
                      </label>
                    )
                  })}
                </div>
              )
            ) : null}
          </div>
        )
      })}
      <p className={styles.effectHint}>{t('styleEditEffectsHint')}</p>
    </div>
  )
}
