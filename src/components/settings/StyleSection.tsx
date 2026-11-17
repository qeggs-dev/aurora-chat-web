import clsx from 'clsx'
import { useRef, useState, type ReactNode } from 'react'
import { useTheme } from '../../app/theme.js'
import { useTranslate, type TranslationKey, type TranslationMessage } from '../../i18n/index.js'
import { useSettings } from '../../services/settings.js'
import {
  activateStylePack,
  importStylePack,
  removeStylePack,
  restoreDefaultStylePack,
  useStylePackState,
} from '../../services/style/store.js'
import { effectCss, useEffectsImage } from '../../services/style/effects.js'
import {
  PALETTE_KEYS,
  STYLE_PREFIX,
  resolveStyleFileRef,
  type StyleAssetEntry,
  type StyleFileRef,
  type StyleManifest,
  type StylePackSummary,
  type ThemedUrls,
  type Theme,
} from '../../services/style/types.js'
import { StylePackError, type StylePackErrorCode } from '../../services/style/zip.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import settingsStyles from './Settings.module.css'
import styles from './StyleSection.module.css'

/** 样式分组的调色板图标：与设置弹窗里的 InfoIcon 一样用 16px 内联 SVG */
export const StyleIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
    <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.3" />
    <circle cx="5.4" cy="6.2" r="0.95" fill="currentColor" />
    <circle cx="8" cy="4.7" r="0.95" fill="currentColor" />
    <circle cx="10.6" cy="6.2" r="0.95" fill="currentColor" />
    <circle cx="10" cy="10.2" r="0.95" fill="currentColor" />
  </svg>
)

/** 每个导入错误码对应的文案 key；未知错误退回带原始 message 的通用文案。 */
const importErrorKeys: Record<StylePackErrorCode, TranslationKey> = {
  tooLarge: 'stylePackErrorTooLarge',
  tooManyFiles: 'stylePackErrorTooManyFiles',
  notZip: 'stylePackErrorNotZip',
  noIndex: 'stylePackErrorNoIndex',
  badIndex: 'stylePackErrorBadIndex',
  badConfig: 'stylePackErrorBadConfig',
  badPath: 'stylePackErrorBadPath',
  missingFile: 'stylePackErrorMissingFile',
  badFileType: 'stylePackErrorBadFileType',
}

/** 行内提示：`error` 为 true 时用错误色显示。 */
type Status = (TranslationMessage & { error?: boolean; detail?: string }) | null

const importErrorStatus = (error: unknown): Status =>
  error instanceof StylePackError
    ? { key: importErrorKeys[error.code], error: true, detail: error.detail }
    : {
        key: 'stylePackImportFailed',
        params: { message: error instanceof Error ? error.message : String(error) },
        error: true,
      }

/**
 * blob: URL 只来自 URL.createObjectURL；仍统一加引号并转义，沿用 apply.ts 的安全约定，
 * 详情页背景写成 `url("…")`，包内路径不会进入样式。
 */
const cssUrl = (url: string): string => `url("${url.replace(/[\\"]/g, '\\$&')}")`

/**
 * 取当前主题的图；该主题没有图时回退到另一主题（列表图标 / 详情封面都按这个规则展示）。
 * 返回实际取到的主题，便于再取该主题专属的 effects。
 */
type PickedUrl = { theme: Theme; url: string }

const pickThemedUrl = (urls: ThemedUrls | undefined, theme: Theme): PickedUrl | undefined => {
  if (!urls) {
    return undefined
  }
  const own = urls[theme]
  if (own) {
    return { theme, url: own }
  }
  const other: Theme = theme === 'light' ? 'dark' : 'light'
  const fallback = urls[other]
  return fallback ? { theme: other, url: fallback } : undefined
}

/**
 * 包图标：跟随当前主题取图，effects 取实际所用主题的配置。
 * 静态部分（阴影 / 透明度 / alpha 派生图）走 effectCss / useEffectsImage；
 * 包图标不允许 tilt（zip.ts 导入时已拒绝），因此这里不做透视处理。
 */
const StylePackIcon = ({
  pack,
  className,
  letterClassName,
}: {
  pack: StylePackSummary
  className: string
  letterClassName: string
}) => {
  const theme = useTheme()
  const picked = pickThemedUrl(pack.iconUrls, theme)
  const effects = picked ? resolveStyleFileRef(pack.manifest.icon, picked.theme)?.effects : undefined
  const tone = effectCss(effects)
  const derived = useEffectsImage(
    picked?.url,
    effects,
    picked ? `pack-icon:${pack.id}:${picked.theme}` : undefined
  )
  if (!picked) {
    return (
      <span className={letterClassName} aria-hidden="true">
        {pack.name.slice(0, 1)}
      </span>
    )
  }
  return (
    <img
      className={className}
      src={derived.url ?? picked.url}
      alt=""
      style={{
        filter: tone.filter,
        opacity: tone.opacity,
        transform: derived.scale > 1.0001 ? `scale(${derived.scale})` : undefined,
      }}
    />
  )
}

/** 资源 ID → 展示名：去掉统一前缀与主题后缀，如 `background.main`、`icon.send`、`font` */
const assetLabel = (assetId: string): string =>
  assetId.replace(`${STYLE_PREFIX}.`, '').replace(/\.(light|dark)$/, '')

const isBackgroundAsset = (assetId: string): boolean =>
  assetId.startsWith(`${STYLE_PREFIX}.background.`)
const isIconAsset = (assetId: string): boolean => assetId.startsWith(`${STYLE_PREFIX}.icon.`)
const isFontAsset = (assetId: string): boolean => assetId.startsWith(`${STYLE_PREFIX}.font.`)

const THEME_LABELS: Array<{ theme: Theme; label: TranslationKey }> = [
  { theme: 'light', label: 'stylePackDetailThemeLight' },
  { theme: 'dark', label: 'stylePackDetailThemeDark' },
]

type ThemedAsset = { id: string; entry: StyleAssetEntry; theme: Theme }

/** 某个主题下清单里实际提供的资源（ID 以 `.light` / `.dark` 结尾） */
const themedAssets = (manifest: StyleManifest, theme: Theme): ThemedAsset[] =>
  Object.entries(manifest.assets)
    .filter(([id]) => id.endsWith(`.${theme}`))
    .map(([id, entry]) => ({ id, entry, theme }))

const DetailSection = ({
  title,
  hint,
  children,
}: {
  title: string
  hint?: string
  children: ReactNode
}) => (
  <section className={styles.detailSection}>
    <h3 className={styles.detailSectionTitle}>{title}</h3>
    {hint ? <p className={styles.detailSectionHint}>{hint}</p> : null}
    {children}
  </section>
)

const DetailRow = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className={styles.detailRow}>
    <div className={styles.detailRowLabel}>{label}</div>
    <div className={styles.detailRowValue}>{children}</div>
  </div>
)

const DetailChips = ({ items, empty }: { items: string[]; empty: string }) =>
  items.length === 0 ? (
    <span className={styles.detailMuted}>{empty}</span>
  ) : (
    <span className={styles.detailChips}>
      {items.map((item) => (
        <span key={item} className={styles.detailChip}>
          {item}
        </span>
      ))}
    </span>
  )

/** 背景资源参数：缺省值按 README 的约定显示，便于对照 index.json 判断是否写过字段 */
const assetParam = (
  entry: StyleAssetEntry,
  key: 'alpha' | 'exposure' | 'fit' | 'align' | 'position' | 'render'
): string => {
  if (key === 'alpha') {
    return String(entry.alpha ?? 1)
  }
  if (key === 'exposure') {
    return String(entry.exposure ?? 0)
  }
  if (key === 'fit') {
    return entry.fit ?? 'cover'
  }
  if (key === 'align') {
    return entry.align ?? 'center'
  }
  if (key === 'position') {
    return entry.position ?? '—'
  }
  return entry.render ?? 'auto'
}

/** 顶层 icon / cover 在某个主题实际使用的文件；没有文件返回 undefined（不跨主题借用） */
const themeFileOf = (ref: StyleFileRef | undefined, theme: Theme): string | undefined =>
  resolveStyleFileRef(ref, theme)?.file

const StylePackDetailContent = ({
  pack,
  coverUrls,
  activeId,
  busy,
  pending,
  onBack,
  onLoad,
  onDelete,
}: {
  pack: StylePackSummary
  /** 详情页封面（按主题）：启用中的包优先用 ActiveStyle.coverUrls，否则用列表 summary 的 coverUrls */
  coverUrls?: ThemedUrls
  activeId: string | null
  busy: boolean
  pending: boolean
  onBack: () => void
  onLoad: () => void
  onDelete: () => void
}) => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  const theme = useTheme()
  const manifest = pack.manifest
  const isActive = pack.id === activeId
  const importedAt = new Date(pack.importedAt).toLocaleString(locale)
  const heroMeta = [
    pack.author ? `${t('stylePackAuthor')} ${pack.author}` : '',
    pack.version ? `${t('stylePackVersion')} ${pack.version}` : '',
  ]
    .filter(Boolean)
    .join(' · ')

  /** 包图标 / 封面在亮/暗主题的清单展示：“亮色主题 · assets/…”，旧包只写 file 时两个主题都会列出 */
  const themedFileChips = (ref: StyleFileRef | undefined): string[] =>
    THEME_LABELS.flatMap(({ theme: fileTheme, label }) => {
      const file = themeFileOf(ref, fileTheme)
      return file ? [`${t(label)} · ${file}`] : []
    })

  // 详情页 cover 作为整个内容区的背景：按当前主题取图，缺主题时回退另一主题；
  // window / zoom 仍走 canvas 派生图，铺满内容区的背景只消费派生后的图（静态 effect 不再适用）。
  const pickedCover = pickThemedUrl(coverUrls, theme)
  const coverEffects = pickedCover
    ? resolveStyleFileRef(manifest.cover, pickedCover.theme)?.effects
    : undefined
  const coverImage = useEffectsImage(
    pickedCover?.url,
    coverEffects,
    pickedCover ? `cover:${pack.id}:${pickedCover.theme}` : undefined
  )
  const coverUrl = coverImage.url ?? pickedCover?.url

  return (
    <div
      className={styles.detailRoot}
      style={coverUrl ? { backgroundImage: cssUrl(coverUrl) } : undefined}
    >
      <div className={styles.detailBar}>
        <Button variant="outlined" size="m" className={styles.backButton} onClick={onBack}>
          <span aria-hidden="true">←</span> {t('stylePackBack')}
        </Button>
      </div>

      <div className={styles.detailHero}>
        <span className={styles.detailHeroIcon}>
          <StylePackIcon
            pack={pack}
            className={styles.detailHeroIconImage}
            letterClassName={styles.detailHeroIconLetter}
          />
        </span>
        <div className={styles.detailHeroText}>
          <div className={styles.detailHeroName}>{pack.name}</div>
          {heroMeta ? <div className={styles.detailHeroMeta}>{heroMeta}</div> : null}
        </div>
        <span className={styles.detailHeroBadge}>
          {pack.builtin ? (
            <span className={settingsStyles.stylePackBadge}>{t('stylePackBuiltinBadge')}</span>
          ) : null}
          {isActive ? (
            <span className={settingsStyles.stylePackBadge}>{t('stylePackInUse')}</span>
          ) : null}
        </span>
      </div>

      <DetailSection title={t('stylePackDetailInfoSection')}>
        <div className={styles.detailRows}>
          <DetailRow label={t('stylePackDetailName')}>{pack.name}</DetailRow>
          <DetailRow label={t('stylePackDetailDescription')}>
            {pack.description || (
              <span className={styles.detailMuted}>{t('stylePackDetailNotProvided')}</span>
            )}
          </DetailRow>
          <DetailRow label={t('stylePackDetailAuthor')}>
            {pack.author || (
              <span className={styles.detailMuted}>{t('stylePackDetailNotProvided')}</span>
            )}
          </DetailRow>
          <DetailRow label={t('stylePackDetailVersion')}>
            {pack.version || (
              <span className={styles.detailMuted}>{t('stylePackDetailNotProvided')}</span>
            )}
          </DetailRow>
          <DetailRow label={t('stylePackDetailId')}>
            <code className={styles.detailCode}>{pack.id}</code>
          </DetailRow>
          <DetailRow label={t('stylePackDetailImportedAt')}>{importedAt}</DetailRow>
          <DetailRow label={t('stylePackDetailStatus')}>
            {isActive ? t('stylePackInUse') : t('stylePackDetailNotLoaded')}
          </DetailRow>
          <DetailRow label={t('stylePackDetailSidebarTitle')}>
            {manifest.sidebarTitle || (
              <span className={styles.detailMuted}>{t('stylePackDetailNotProvided')}</span>
            )}
          </DetailRow>
        </div>
      </DetailSection>

      <DetailSection title={t('stylePackDetailResourcesSection')}>
        {THEME_LABELS.map(({ theme, label }) => {
          const assets = themedAssets(manifest, theme)
          const backgrounds = assets.filter((asset) => isBackgroundAsset(asset.id))
          const icons = assets.filter((asset) => isIconAsset(asset.id))
          const fonts = assets.filter((asset) => isFontAsset(asset.id))
          return (
            <div key={theme} className={styles.detailThemeGroup}>
              <div className={styles.detailThemeTitle}>{t(label)}</div>
              <div className={styles.detailResourceRow}>
                <span className={styles.detailResourceLabel}>
                  {t('stylePackDetailBackgrounds')} ·{' '}
                  {t('stylePackDetailSlotCount', { count: backgrounds.length })}
                </span>
                <DetailChips
                  items={backgrounds.map((asset) => assetLabel(asset.id))}
                  empty={t('stylePackDetailNotProvided')}
                />
              </div>
              <div className={styles.detailResourceRow}>
                <span className={styles.detailResourceLabel}>
                  {t('stylePackDetailIcons')} ·{' '}
                  {t('stylePackDetailSlotCount', { count: icons.length })}
                </span>
                <DetailChips
                  items={icons.map((asset) => assetLabel(asset.id))}
                  empty={t('stylePackDetailNotProvided')}
                />
              </div>
              <div className={styles.detailResourceRow}>
                <span className={styles.detailResourceLabel}>{t('stylePackDetailFonts')}</span>
                <DetailChips
                  items={fonts.map((asset) => asset.entry.file)}
                  empty={t('stylePackDetailNotProvided')}
                />
              </div>
            </div>
          )
        })}
        <div className={styles.detailThemeGroup}>
          <div className={styles.detailThemeTitle}>{t('stylePackDetailPackageResources')}</div>
          <div className={styles.detailResourceRow}>
            <span className={styles.detailResourceLabel}>{t('stylePackDetailPackageIcon')}</span>
            <DetailChips
              items={themedFileChips(manifest.icon)}
              empty={t('stylePackDetailNotProvided')}
            />
          </div>
          <div className={styles.detailResourceRow}>
            <span className={styles.detailResourceLabel}>{t('stylePackDetailCover')}</span>
            <DetailChips
              items={themedFileChips(manifest.cover)}
              empty={t('stylePackDetailNotProvided')}
            />
          </div>
          <div className={styles.detailResourceRow}>
            <span className={styles.detailResourceLabel}>{t('stylePackDetailLicenseFile')}</span>
            <span className={styles.detailResourceValue}>
              {manifest.license ? (
                <code className={styles.detailCode}>{manifest.license.file}</code>
              ) : (
                <span className={styles.detailMuted}>{t('stylePackDetailNotProvided')}</span>
              )}
            </span>
          </div>
        </div>
      </DetailSection>

      <DetailSection
        title={t('stylePackDetailParamsSection')}
        hint={t('stylePackDetailParamsHint')}
      >
        <div className={styles.detailParams}>
          {THEME_LABELS.flatMap(({ theme, label }) => {
            const backgrounds = themedAssets(manifest, theme).filter((asset) =>
              isBackgroundAsset(asset.id)
            )
            return backgrounds.map((asset) => (
              <div key={asset.id} className={styles.detailParamCard}>
                <div className={styles.detailParamTitle}>
                  {assetLabel(asset.id)}
                  <span className={styles.detailParamTheme}>{t(label)}</span>
                </div>
                <div className={styles.detailParamGrid}>
                  {(
                    [
                      ['alpha', assetParam(asset.entry, 'alpha')],
                      ['exposure', assetParam(asset.entry, 'exposure')],
                      ['fit', assetParam(asset.entry, 'fit')],
                      ['align', assetParam(asset.entry, 'align')],
                      ['position', assetParam(asset.entry, 'position')],
                      ['render', assetParam(asset.entry, 'render')],
                    ] as const
                  ).map(([key, value]) => (
                    <div key={key} className={styles.detailParam}>
                      <span className={styles.detailParamKey}>
                        {t(
                          key === 'alpha'
                            ? 'stylePackDetailAlpha'
                            : key === 'exposure'
                              ? 'stylePackDetailExposure'
                              : key === 'fit'
                                ? 'stylePackDetailFit'
                                : key === 'align'
                                  ? 'stylePackDetailAlign'
                                  : key === 'position'
                                    ? 'stylePackDetailPosition'
                                    : 'stylePackDetailRender'
                        )}
                      </span>
                      <span className={styles.detailParamValue}>{value}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))
          })}
        </div>
        {THEME_LABELS.every(
          ({ theme }) =>
            themedAssets(manifest, theme).filter((asset) => isBackgroundAsset(asset.id)).length ===
            0
        ) ? (
          <div className={styles.detailMuted}>{t('stylePackDetailParamsEmpty')}</div>
        ) : null}
        <div className={styles.detailResourceRow}>
          <span className={styles.detailResourceLabel}>{t('stylePackDetailFontFile')}</span>
          <DetailChips
            items={[
              ...new Set(
                THEME_LABELS.flatMap(({ theme }) =>
                  themedAssets(manifest, theme)
                    .filter((asset) => isFontAsset(asset.id))
                    .map((asset) => asset.entry.file)
                )
              ),
            ]}
            empty={t('stylePackDetailNotProvided')}
          />
        </div>
      </DetailSection>

      <DetailSection
        title={t('stylePackDetailPaletteSection')}
        hint={t('stylePackDetailPaletteHint')}
      >
        {THEME_LABELS.map(({ theme, label }) => {
          const colors = manifest.color_palette?.[theme]
          const keys = colors ? PALETTE_KEYS.filter((key) => Boolean(colors[key])) : []
          return (
            <div key={theme} className={styles.detailThemeGroup}>
              <div className={styles.detailThemeTitle}>{t(label)}</div>
              {keys.length === 0 ? (
                <div className={styles.detailMuted}>{t('stylePackDetailPaletteEmpty')}</div>
              ) : (
                <div className={styles.paletteGrid}>
                  {keys.map((key) => {
                    const value = (colors as Record<string, string>)[key]
                    return (
                      <div key={key} className={styles.paletteItem}>
                        <span
                          className={styles.paletteSwatch}
                          style={{ backgroundColor: value }}
                          aria-hidden="true"
                        />
                        <span className={styles.paletteToken}>{key}</span>
                        <span className={styles.paletteValue}>{value}</span>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </DetailSection>

      <DetailSection title={t('stylePackDetailLicenseSection')}>
        <p className={styles.detailLicenseNote}>{t('stylePackDetailLicenseNote')}</p>
        {pack.license ? (
          <pre className={styles.licenseText}>{pack.license}</pre>
        ) : (
          <div className={styles.detailMuted}>{t('stylePackDetailLicenseMissing')}</div>
        )}
      </DetailSection>

      <div className={styles.detailActions} aria-busy={busy}>
        {isActive ? (
          <span className={settingsStyles.stylePackBadge}>{t('stylePackInUse')}</span>
        ) : (
          <Button variant="outlined" size="m" disabled={busy} onClick={onLoad}>
            {t(pending ? 'stylePackLoadingPack' : 'stylePackLoad')}
          </Button>
        )}
        <Button
          variant="dangerOutlined"
          size="m"
          disabled={busy || pack.builtin}
          title={pack.builtin ? t('stylePackBuiltinUndeletable') : undefined}
          onClick={onDelete}
        >
          {t('stylePackDelete')}
        </Button>
      </div>
    </div>
  )
}

/**
 * 样式设置分组：导入样式包 ZIP、点击卡片加载、查看详情并加载 / 删除。
 *
 * - 列表：整卡主体是「加载」按钮（调用 activateStylePack 立即生效），右侧保留「详情」「删除」；
 *   顶部固定一行「恢复默认样式」，没有加载任何包时显示为当前状态且不可点。
 * - 详情：同一区域内切换到详情视图（不是新弹窗），顶部有「← 返回」；封面只用 blob URL，
 *   `url("…")` 与 apply.ts 的安全约定一致。详情里加载后停留在详情页，状态徽标原地更新。
 */
export const StyleSection = () => {
  const t = useTranslate()
  const { ready, packs, activeId, active, importing, error } = useStylePackState()
  const [importStatus, setImportStatus] = useState<Status>(null)
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [restoring, setRestoring] = useState(false)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<StylePackSummary | null>(null)
  const [deleting, setDeleting] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const busy = pendingId !== null || restoring || importing
  const detailPack = detailId === null ? undefined : packs.find((pack) => pack.id === detailId)
  /** 本机内置样式包 id（内置资产缺失 / 被用户同 id 包覆盖时为 null） */
  const builtinId = packs.find((pack) => pack.builtin === true)?.id ?? null
  /** 当前生效的是「默认样式」：内置包启用中，或没有任何包（应用默认外观） */
  const defaultActive = activeId === null || builtinId === activeId

  const onPick = async (file: File) => {
    setImportStatus(null)
    try {
      await importStylePack(file)
      showToast({ key: 'stylePackImported' })
    } catch (error) {
      setImportStatus(importErrorStatus(error))
    }
  }

  const load = async (id: string) => {
    if (busy) {
      return
    }
    setPendingId(id)
    try {
      await activateStylePack(id)
    } catch {
      showToast({ key: 'stylePackLoadFailed', type: 'error' })
    } finally {
      setPendingId(null)
    }
  }

  const restoreDefault = async () => {
    if (busy || defaultActive) {
      return
    }
    setRestoring(true)
    try {
      await restoreDefaultStylePack()
    } catch {
      showToast({ key: 'stylePackRestoreFailed', type: 'error' })
    } finally {
      setRestoring(false)
    }
  }

  const confirmDelete = async () => {
    if (!deleteTarget || deleting) {
      return
    }
    const target = deleteTarget
    setDeleting(true)
    // 先退出详情再删除：列表刷新会 revoke 封面 blob URL，避免详情页短暂指向已释放的地址
    if (detailId === target.id) {
      setDetailId(null)
    }
    try {
      await removeStylePack(target.id)
      setDeleteTarget(null)
      showToast({ key: 'stylePackDeleted' })
    } catch {
      showToast({ key: 'stylePackDeleteFailed', type: 'error' })
    } finally {
      setDeleting(false)
    }
  }

  return (
    <>
      {detailPack ? (
        <StylePackDetailContent
          pack={detailPack}
          coverUrls={
            detailPack.id === activeId && active?.coverUrls
              ? active.coverUrls
              : detailPack.coverUrls
          }
          activeId={activeId}
          busy={busy}
          pending={pendingId === detailPack.id}
          onBack={() => setDetailId(null)}
          onLoad={() => void load(detailPack.id)}
          onDelete={() => setDeleteTarget(detailPack)}
        />
      ) : (
        <div className={styles.section} aria-busy={importing}>
          <div className={styles.header}>
            <div className={styles.headerText}>
              <div className={styles.title}>{t('stylePackSectionTitle')}</div>
              <div className={styles.description}>{t('stylePackSectionDescription')}</div>
              <div className={styles.hint}>{t('stylePackImportHint')}</div>
            </div>
            <Button
              variant="outlined"
              size="m"
              className={styles.importButton}
              disabled={importing}
              onClick={() => fileRef.current?.click()}
            >
              {t(importing ? 'stylePackImporting' : 'stylePackImport')}
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept=".zip,application/zip"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0]
                event.target.value = ''
                if (file) {
                  void onPick(file)
                }
              }}
            />
          </div>
          {importStatus ? (
            <div
              className={clsx(styles.status, importStatus.error && styles.statusError)}
              role={importStatus.error ? 'alert' : 'status'}
            >
              {t(importStatus.key, importStatus.params)}
              {importStatus.detail ? (
                <span className={styles.statusDetail}>{importStatus.detail}</span>
              ) : null}
            </div>
          ) : error ? (
            <div className={clsx(styles.status, styles.statusError)} role="alert">
              {Object.hasOwn(importErrorKeys, error)
                ? t(importErrorKeys[error as StylePackErrorCode])
                : t('stylePackFailed')}
            </div>
          ) : null}
          {!ready ? (
            <div className={styles.status} role="status">
              {t('stylePackLoading')}
            </div>
          ) : packs.length === 0 ? (
            <div className={styles.empty}>
              <div className={styles.emptyTitle}>{t('stylePackEmpty')}</div>
              <div className={styles.emptyHint}>{t('stylePackEmptyHint')}</div>
            </div>
          ) : (
            <ul className={settingsStyles.stylePackList}>
              <li
                className={clsx(
                  settingsStyles.stylePackCard,
                  settingsStyles.stylePackRestoreCard,
                  defaultActive && settingsStyles.stylePackCardActive
                )}
              >
                <div className={settingsStyles.stylePackRestoreMain}>
                  <span className={settingsStyles.stylePackIcon}>
                    <StyleIcon />
                  </span>
                  <div className={settingsStyles.stylePackInfo}>
                    <div className={settingsStyles.stylePackName}>
                      {t(builtinId ? 'stylePackRestoreBuiltin' : 'stylePackRestoreDefault')}
                    </div>
                    <div className={settingsStyles.stylePackDescription}>
                      {builtinId === activeId
                        ? t('stylePackBuiltinHint')
                        : activeId === null
                          ? t('stylePackDefaultInUse')
                          : builtinId
                            ? t('stylePackDefaultHint')
                            : t('stylePackBuiltinMissing')}
                    </div>
                  </div>
                </div>
                <div className={settingsStyles.stylePackActions}>
                  {defaultActive ? (
                    <span className={settingsStyles.stylePackBadge}>
                      {builtinId === activeId
                        ? t('stylePackBuiltinActive')
                        : t('stylePackDefaultInUse')}
                    </span>
                  ) : builtinId ? (
                    // 正常安装下始终可用：恢复默认 = 启用内置极光包（不提供回到上游外观的入口）
                    <Button
                      variant="outlined"
                      size="m"
                      disabled={busy}
                      onClick={() => void restoreDefault()}
                    >
                      {t('stylePackRestoreBuiltin')}
                    </Button>
                  ) : null}
                </div>
              </li>
              {packs.map((pack) => {
                const isActive = pack.id === activeId
                const activating = pendingId === pack.id
                const meta = [
                  pack.author ? `${t('stylePackAuthor')} ${pack.author}` : '',
                  pack.version ? `${t('stylePackVersion')} ${pack.version}` : '',
                ]
                  .filter(Boolean)
                  .join(' · ')
                return (
                  <li
                    key={pack.id}
                    className={clsx(
                      settingsStyles.stylePackCard,
                      isActive && settingsStyles.stylePackCardActive
                    )}
                  >
                    <button
                      type="button"
                      className={settingsStyles.stylePackMain}
                      disabled={isActive || busy}
                      aria-label={`${t('stylePackLoad')}: ${pack.name}`}
                      onClick={() => {
                        if (!isActive) {
                          void load(pack.id)
                        }
                      }}
                    >
                      <span className={settingsStyles.stylePackIcon}>
                        <StylePackIcon
                          pack={pack}
                          className={settingsStyles.stylePackIconImage}
                          letterClassName={settingsStyles.stylePackIconLetter}
                        />
                      </span>
                      <span className={settingsStyles.stylePackInfo}>
                        <span className={styles.stylePackNameRow}>
                          <span className={settingsStyles.stylePackName}>{pack.name}</span>
                          {pack.builtin ? (
                            <span
                              className={clsx(
                                settingsStyles.stylePackBadge,
                                styles.builtinBadge
                              )}
                            >
                              {t('stylePackBuiltinBadge')}
                            </span>
                          ) : null}
                        </span>
                        {meta ? <span className={settingsStyles.stylePackMeta}>{meta}</span> : null}
                        {pack.description ? (
                          <span className={settingsStyles.stylePackDescription}>
                            {pack.description}
                          </span>
                        ) : null}
                      </span>
                    </button>
                    <div className={settingsStyles.stylePackActions}>
                      {isActive ? (
                        <span className={settingsStyles.stylePackBadge}>{t('stylePackInUse')}</span>
                      ) : (
                        <Button
                          variant="outlined"
                          size="m"
                          disabled={busy}
                          onClick={() => void load(pack.id)}
                        >
                          {t(activating ? 'stylePackLoadingPack' : 'stylePackLoad')}
                        </Button>
                      )}
                      <Button variant="outlined" size="m" onClick={() => setDetailId(pack.id)}>
                        {t('stylePackDetails')}
                      </Button>
                      <Button
                        variant="dangerOutlined"
                        size="m"
                        disabled={busy || pack.builtin}
                        title={pack.builtin ? t('stylePackBuiltinUndeletable') : undefined}
                        onClick={() => setDeleteTarget(pack)}
                      >
                        {t('stylePackDelete')}
                      </Button>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}
      {deleteTarget ? (
        <Modal
          title={t('stylePackDeleteConfirmTitle')}
          className={settingsStyles.deleteConfirm}
          onClose={() => {
            if (!deleting) {
              setDeleteTarget(null)
            }
          }}
          footer={
            <div className={settingsStyles.deleteActions} aria-busy={deleting}>
              <Button
                variant="outlined"
                size="m"
                autoFocus
                disabled={deleting}
                onClick={() => setDeleteTarget(null)}
              >
                {t('cancel')}
              </Button>
              <Button
                variant="danger"
                size="m"
                disabled={deleting}
                onClick={() => void confirmDelete()}
              >
                {t(deleting ? 'stylePackDeleting' : 'stylePackDelete')}
              </Button>
            </div>
          }
        >
          <div>{t('stylePackDeleteConfirm')}</div>
          <div className={styles.deleteName}>{deleteTarget.name}</div>
        </Modal>
      ) : null}
    </>
  )
}
