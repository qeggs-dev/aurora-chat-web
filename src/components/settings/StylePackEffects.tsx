/**
 * 样式包详情页的「图像效果 / 滤镜」区块：只读展示某个主题下各资源显式配置的 effects。
 *
 * - 按资源名分组（背景槽位 / 图标 / 字体 / 包图标 / 封面），每组可折叠；
 * - 只展示与默认值不同的字段（见 services/style/effectSummary.ts），避免把缺省值当成配置；
 * - 没有自定义效果的资源只汇总提示「使用默认效果」，不逐个展开空分组。
 *
 * 纯展示组件：数据全部来自详情页已经拿到的 `pack.manifest`，不额外读 IndexedDB。
 */
import { useTranslate } from '../../i18n/index.js'
import type { TranslationKey } from '../../i18n/index.js'
import {
  collectThemeEffectResources,
  styleAssetLabel,
  summarizeEffects,
  type StyleEffectResource,
  type StyleEffectSummary,
} from '../../services/style/effectSummary.js'
import type { StyleManifest, Theme } from '../../services/style/types.js'
import styles from './StyleSection.module.css'

const THEMES: Array<{ theme: Theme; label: TranslationKey }> = [
  { theme: 'light', label: 'stylePackDetailThemeLight' },
  { theme: 'dark', label: 'stylePackDetailThemeDark' },
]

type Translate = ReturnType<typeof useTranslate>

/** 资源展示名：assets 用去前缀的槽位名，包图标 / 封面 / 字体用界面文案 */
const resourceLabel = (resource: StyleEffectResource, t: Translate): string => {
  if (resource.kind === 'font') {
    return t('stylePackDetailFonts')
  }
  if (resource.kind === 'packIcon') {
    return t('stylePackDetailPackageIcon')
  }
  if (resource.kind === 'cover') {
    return t('stylePackDetailCover')
  }
  return styleAssetLabel(resource.id)
}

/** 效果组内每个字段的展示文本：`y 6`、`color #11223344`；标量效果只有值 */
const fieldText = (group: StyleEffectSummary[number]): string =>
  group.values
    .map((value) => (value.field ? `${value.field} ${value.value}` : value.value))
    .join(' · ')

export const StylePackEffects = ({ manifest }: { manifest: StyleManifest }) => {
  const t = useTranslate()
  return (
    <div className={styles.detailEffects}>
      {THEMES.map(({ theme, label }) => {
        const resources = collectThemeEffectResources(manifest, theme)
        const custom = resources
          .map((resource) => ({ resource, summary: summarizeEffects(resource.effects) }))
          .filter((entry) => entry.summary.length > 0)
        const defaultCount = resources.length - custom.length
        return (
          <div key={theme} className={styles.detailThemeGroup}>
            <div className={styles.detailThemeTitle}>{t(label)}</div>
            {resources.length === 0 ? (
              <div className={styles.detailMuted}>{t('stylePackDetailEffectsEmpty')}</div>
            ) : (
              <>
                {custom.length > 0 ? (
                  <div className={styles.effectList}>
                    {custom.map(({ resource, summary }) => (
                      <details
                        key={resource.id}
                        className={styles.effectItem}
                        open
                        data-effect-resource={resource.id}
                      >
                        <summary className={styles.effectSummary}>
                          <span className={styles.effectResourceName}>
                            {resourceLabel(resource, t)}
                          </span>
                          <span className={styles.effectChips}>
                            {summary.map((group) => (
                              <span key={group.group} className={styles.effectChip}>
                                {group.group}
                              </span>
                            ))}
                          </span>
                        </summary>
                        <div className={styles.effectValues}>
                          {summary.map((group) => (
                            <div key={group.group} className={styles.effectValueRow}>
                              <span className={styles.effectValueGroup}>{group.group}</span>
                              <span className={styles.effectValueFields}>{fieldText(group)}</span>
                            </div>
                          ))}
                        </div>
                      </details>
                    ))}
                  </div>
                ) : null}
                {defaultCount > 0 ? (
                  <div className={styles.detailMuted}>
                    {custom.length === 0
                      ? t('stylePackDetailEffectsDefault')
                      : t('stylePackDetailEffectsDefaultRest', { count: defaultCount })}
                  </div>
                ) : null}
              </>
            )}
          </div>
        )
      })}
    </div>
  )
}
