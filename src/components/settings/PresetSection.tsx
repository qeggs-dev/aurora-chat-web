import clsx from 'clsx'
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import {
  useTranslate,
  type TranslationKey,
  type TranslationMessage,
  type TranslationParams,
} from '../../i18n/index.js'
import {
  getMemoryState,
  listMemories,
  MEMORY_SECTION_LABELS,
  MEMORY_SECTIONS,
  removeMemory,
  searchMemories,
  subscribeMemory,
  type MemoryEntry,
} from '../../services/memory/store.js'
import {
  activatePreset,
  createPresetDraft,
  importPresetZip,
  loadPresetConfig,
  removePreset,
  savePresetJson,
  usePresetState,
} from '../../services/preset/store.js'
import {
  DEFAULT_PRESET_COMPACTION,
  DEFAULT_PRESET_MEMORY,
  DEFAULT_PRESET_PARAMS,
  PresetError,
  type PresetConfig,
  type PresetProtocol,
  type PresetSummary,
} from '../../services/preset/types.js'
import { Button } from '../base/Button.js'
import {
  IconRefreshOutline16,
  IconSearchOutline16,
  IconTrashOutline16,
  IconUploadOutline14,
} from '../base/icons.js'
import { Modal } from '../base/Modal.js'
import { Select, type SelectOption } from '../base/Select.js'
import { showToast } from '../base/toastState.js'
import settingsStyles from './Settings.module.css'
import styles from './PresetSection.module.css'

/** Preset 分组的滑杆图标：与设置弹窗里的 InfoIcon / StyleIcon 一样用 16px 内联 SVG */
export const PresetIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
    <path
      d="M2.8 4.4h10.4M2.8 8h10.4M2.8 11.6h10.4"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
    />
    <circle cx="5.6" cy="4.4" r="1.5" fill="currentColor" />
    <circle cx="10.4" cy="8" r="1.5" fill="currentColor" />
    <circle cx="7.2" cy="11.6" r="1.5" fill="currentColor" />
  </svg>
)

/** 每个 Preset 错误码对应的文案 key；未知错误退回带原始 message 的通用文案。 */
const presetErrorKeys: Record<string, TranslationKey> = {
  tooLarge: 'presetErrorTooLarge',
  tooManyFiles: 'presetErrorTooManyFiles',
  notZip: 'presetErrorNotZip',
  noConfig: 'presetErrorNoConfig',
  badConfig: 'presetErrorBadConfig',
  badPath: 'presetErrorBadPath',
  missingFile: 'presetErrorMissingFile',
  badFileType: 'presetErrorBadFileType',
}

/** 错误对象按当前语言展示：已知 PresetError 用错误码文案，其余带上原始 message。 */
type Status = (TranslationMessage & { error?: boolean }) | null

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const presetErrorStatus = (error: unknown, fallback: TranslationKey): Status =>
  error instanceof PresetError
    ? {
        key: Object.hasOwn(presetErrorKeys, error.code) ? presetErrorKeys[error.code] : fallback,
        error: true,
      }
    : { key: fallback, params: { message: errorText(error) }, error: true }

/* -------------------------------------------------------------------------------------------------
 * 草稿模型：每个预设一份 draft（config + 数值输入的原文 + 未保存标记）。
 * 数值字段以输入原文为准，保存前统一按 preset/zip.ts 的规则做范围校验。
 * ----------------------------------------------------------------------------------------------- */

type NumericField =
  | 'temperature'
  | 'top_p'
  | 'max_tokens'
  | 'presence_penalty'
  | 'frequency_penalty'
  | 'seed'
  | 'trigger_tokens'
  | 'keep_recent_messages'
  | 'max_results'

type TextField = NumericField | 'stop'

type TextMap = Record<TextField, string>

type Draft = {
  config: PresetConfig
  /** 数值字段的输入原文：保存时以它为准并做范围校验 */
  text: TextMap
  /** 与 store 里的配置不一致（新建预设初始为 true） */
  dirty: boolean
}

type FieldError = { key: TranslationKey; params?: TranslationParams }

type FieldErrors = Partial<Record<TextField | 'base_url' | 'model', FieldError>>

type NumberRule = {
  min: number
  max: number
  integer: boolean
  optional?: boolean
  message: TranslationKey
}

const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER

/** 与 services/preset/zip.ts 的校验规则保持一致 */
const NUMBER_RULES: Record<NumericField, NumberRule> = {
  temperature: { min: 0, max: 2, integer: false, message: 'presetFieldNumberRange' },
  top_p: { min: 0, max: 1, integer: false, message: 'presetFieldNumberRange' },
  max_tokens: {
    min: 1,
    max: MAX_SAFE_INTEGER,
    integer: true,
    message: 'presetFieldPositiveInteger',
  },
  presence_penalty: { min: -2, max: 2, integer: false, message: 'presetFieldNumberRange' },
  frequency_penalty: { min: -2, max: 2, integer: false, message: 'presetFieldNumberRange' },
  seed: {
    min: -MAX_SAFE_INTEGER,
    max: MAX_SAFE_INTEGER,
    integer: true,
    optional: true,
    message: 'presetFieldSeedInvalid',
  },
  trigger_tokens: {
    min: 1,
    max: MAX_SAFE_INTEGER,
    integer: true,
    message: 'presetFieldPositiveInteger',
  },
  keep_recent_messages: { min: 0, max: 100, integer: true, message: 'presetFieldIntegerRange' },
  max_results: { min: 1, max: 50, integer: true, message: 'presetFieldIntegerRange' },
}

const NUMERIC_FIELDS: NumericField[] = [
  'temperature',
  'top_p',
  'max_tokens',
  'presence_penalty',
  'frequency_penalty',
  'seed',
  'trigger_tokens',
  'keep_recent_messages',
  'max_results',
]

const EMPTY_ERRORS: FieldErrors = {}

const URL_PATTERN = /^https?:\/\/\S+$/i

const ruleError = (rule: NumberRule): FieldError =>
  rule.message === 'presetFieldPositiveInteger' || rule.message === 'presetFieldSeedInvalid'
    ? { key: rule.message }
    : { key: rule.message, params: { min: rule.min, max: rule.max } }

/** 解析一个数值输入：返回数值、null（可留空字段的空值）或行内错误 */
const parseNumberField = (field: NumericField, raw: string): number | null | FieldError => {
  const rule = NUMBER_RULES[field]
  const text = raw.trim()
  if (!text) {
    return rule.optional ? null : ruleError(rule)
  }
  const value = Number(text)
  if (!Number.isFinite(value)) {
    return ruleError(rule)
  }
  if (rule.integer && !Number.isSafeInteger(value)) {
    return ruleError(rule)
  }
  if (value < rule.min || value > rule.max) {
    return ruleError(rule)
  }
  return value
}

const isFieldError = (value: number | null | FieldError): value is FieldError =>
  typeof value === 'object' && value !== null

const validateDraft = (text: TextMap, config: PresetConfig): FieldErrors => {
  const errors: FieldErrors = {}
  for (const field of NUMERIC_FIELDS) {
    const parsed = parseNumberField(field, text[field])
    if (isFieldError(parsed)) {
      errors[field] = parsed
    }
  }
  const baseUrl = config.base_url.trim()
  if (!baseUrl) {
    errors.base_url = { key: 'presetFieldRequired' }
  } else if (!URL_PATTERN.test(baseUrl)) {
    errors.base_url = { key: 'presetFieldUrl' }
  }
  if (!config.model.trim()) {
    errors.model = { key: 'presetFieldRequired' }
  }
  return errors
}

const numberFromText = (field: NumericField, text: TextMap, fallback: number): number => {
  const parsed = parseNumberField(field, text[field])
  return typeof parsed === 'number' ? parsed : fallback
}

const stopFromText = (text: TextMap): string[] =>
  text.stop
    .split(/[,，]/)
    .map((item) => item.trim())
    .filter(Boolean)

const textFromConfig = (config: PresetConfig): TextMap => ({
  temperature: String(config.params.temperature),
  top_p: String(config.params.top_p),
  max_tokens: String(config.params.max_tokens),
  stop: config.params.stop.join(', '),
  presence_penalty: String(config.params.presence_penalty),
  frequency_penalty: String(config.params.frequency_penalty),
  seed: config.params.seed === null ? '' : String(config.params.seed),
  trigger_tokens: String(config.compaction.trigger_tokens),
  keep_recent_messages: String(config.compaction.keep_recent_messages),
  max_results: String(config.memory.max_results),
})

const draftFromConfig = (config: PresetConfig, dirty: boolean): Draft => ({
  config,
  text: textFromConfig(config),
  dirty,
})

/** 把草稿整理成可保存的配置：数值以输入原文解析，空白提示词 / 空 stop 项归一 */
const configFromDraft = (draft: Draft): PresetConfig => {
  const { config, text } = draft
  const seed = parseNumberField('seed', text.seed)
  const prompt = config.system_prompt?.trim()
  const compactionPrompt = config.compaction.prompt?.trim()
  return {
    ...config,
    base_url: config.base_url.trim().replace(/\/+$/, ''),
    model: config.model.trim(),
    system_prompt: prompt ? config.system_prompt : undefined,
    params: {
      ...config.params,
      temperature: numberFromText('temperature', text, config.params.temperature),
      top_p: numberFromText('top_p', text, config.params.top_p),
      max_tokens: numberFromText('max_tokens', text, config.params.max_tokens),
      stop: stopFromText(text),
      presence_penalty: numberFromText('presence_penalty', text, config.params.presence_penalty),
      frequency_penalty: numberFromText('frequency_penalty', text, config.params.frequency_penalty),
      seed: typeof seed === 'number' ? seed : null,
    },
    compaction: {
      ...config.compaction,
      trigger_tokens: numberFromText('trigger_tokens', text, config.compaction.trigger_tokens),
      keep_recent_messages: numberFromText(
        'keep_recent_messages',
        text,
        config.compaction.keep_recent_messages
      ),
      prompt: compactionPrompt ? config.compaction.prompt : null,
    },
    memory: {
      ...config.memory,
      max_results: numberFromText('max_results', text, config.memory.max_results),
    },
  }
}

/** 新建预设：id 按 createPresetDraft 的规则生成，名字换成界面上的默认名 */
const createNewPresetConfig = (name: string): PresetConfig => {
  const config = JSON.parse(createPresetDraft()) as PresetConfig & { $comment?: string }
  delete config.$comment
  return { ...config, name }
}

/** 读不到完整配置时，用列表摘要拼一份基础配置，至少能继续编辑与保存 */
const summaryConfig = (summary: PresetSummary): PresetConfig => ({
  schema: 1,
  id: summary.id,
  name: summary.name,
  description: summary.description,
  author: summary.author,
  version: summary.version,
  protocol: summary.protocol,
  base_url: summary.baseUrl,
  model: summary.model,
  params: { ...DEFAULT_PRESET_PARAMS, stop: [] },
  compaction: { ...DEFAULT_PRESET_COMPACTION },
  memory: { ...DEFAULT_PRESET_MEMORY },
})

const formatMemoryTime = (timestamp: number): string =>
  Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : ''

/** 不可变地移除一条记录（避免 delete 动态键） */
const withoutKey = <T,>(record: Record<string, T>, key: string): Record<string, T> =>
  Object.fromEntries(Object.entries(record).filter(([name]) => name !== key))

const MEMORY_SECTION_KEYS: Record<string, TranslationKey> = {
  [MEMORY_SECTIONS.core]: 'presetMemorySectionCore',
  [MEMORY_SECTIONS.preference]: 'presetMemorySectionPreference',
  [MEMORY_SECTIONS.project]: 'presetMemorySectionProject',
  [MEMORY_SECTIONS.decision]: 'presetMemorySectionDecision',
  [MEMORY_SECTIONS.todo]: 'presetMemorySectionTodo',
}

type SubTab = 'api' | 'params' | 'prompt' | 'memory' | 'compaction'

const SUB_TABS: { value: SubTab; label: TranslationKey }[] = [
  { value: 'api', label: 'presetSubtabApi' },
  { value: 'params', label: 'presetSubtabParams' },
  { value: 'prompt', label: 'presetSubtabPrompt' },
  { value: 'memory', label: 'presetSubtabMemory' },
  { value: 'compaction', label: 'presetSubtabCompaction' },
]

const PROTOCOL_OPTIONS: SelectOption<PresetProtocol>[] = [
  { value: 'anthropic', label: 'anthropic' },
  { value: 'openai', label: 'openai' },
  { value: 'responses', label: 'responses' },
]

const REASONING_EFFORTS = ['low', 'medium', 'high']

type DraftApi = {
  errors: FieldErrors
  setConfig: (mutate: (config: PresetConfig) => PresetConfig) => void
  setText: (field: TextField, value: string) => void
}

type PanelProps = { draft: Draft; api: DraftApi }

/** 字段外壳：标签 + 控件 + 行内错误或说明 */
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

const Switch = ({
  checked,
  label,
  onChange,
}: {
  checked: boolean
  label: string
  onChange: (checked: boolean) => void
}) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={label}
    className={clsx(styles.switch, checked && styles.switchOn)}
    onClick={() => onChange(!checked)}
  >
    <span className={styles.switchThumb} aria-hidden="true" />
  </button>
)

const SwitchField = ({
  label,
  checked,
  onChange,
}: {
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
}) => (
  <div className={styles.switchRow}>
    <div className={styles.fieldLabel}>{label}</div>
    <Switch checked={checked} label={label} onChange={onChange} />
  </div>
)

/** 数值输入：显示草稿里的输入原文，错误由保存前置校验产生 */
const NumberField = ({
  field,
  label,
  api,
  draft,
}: {
  field: NumericField
  label: string
  api: DraftApi
  draft: Draft
}) => {
  const t = useTranslate()
  const id = useId()
  const rule = NUMBER_RULES[field]
  const error = api.errors[field]
  return (
    <Field label={label} htmlFor={id} error={error ? t(error.key, error.params) : undefined}>
      <input
        id={id}
        className={clsx(styles.input, error && styles.inputInvalid)}
        type="number"
        inputMode={rule.integer ? 'numeric' : 'decimal'}
        step={rule.integer ? 1 : 'any'}
        min={rule.optional ? undefined : rule.min}
        max={rule.optional ? undefined : rule.max}
        value={draft.text[field]}
        aria-invalid={error ? true : undefined}
        onChange={(event) => api.setText(field, event.target.value)}
      />
    </Field>
  )
}

/**
 * Preset 设置分组：顶部一排预设标签 + 右侧「新建」，下方操作栏（启用 / 恢复 / 保存 / 删除），
 * 编辑区分 API、模型参数、提示词、记忆、上下文压缩 5 个子标签。
 * 每个预设一份草稿，切换标签不丢；只有保存时才写回 store。
 */
export const PresetSection = () => {
  const t = useTranslate()
  const { ready, presets, activeId, active, importing, error } = usePresetState()
  const [importStatus, setImportStatus] = useState<Status>(null)
  const [saveStatus, setSaveStatus] = useState<Status>(null)
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [extraIds, setExtraIds] = useState<string[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [showErrors, setShowErrors] = useState<Record<string, boolean>>({})
  const [pending, setPending] = useState<{ id: string; action: 'activate' | 'restore' } | null>(
    null
  )
  const [saving, setSaving] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<{
    id: string
    name: string
    stored: boolean
  } | null>(null)
  const [deleting, setDeleting] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const tabRefs = useRef(new Map<string, HTMLButtonElement>())

  // 异步回调里读最新值，避免把整个 store 放进 effect 依赖
  const draftsRef = useRef(drafts)
  draftsRef.current = drafts
  const presetsRef = useRef(presets)
  presetsRef.current = presets
  const activeRef = useRef(active)
  activeRef.current = active
  const activeIdRef = useRef(activeId)
  activeIdRef.current = activeId
  const loadingRef = useRef(new Set<string>())

  // 选中项：当前启用项 → 第一个 → 空；导入 / 保存 / 删除导致列表变化后修正
  useEffect(() => {
    if (!ready) {
      return
    }
    setSelectedId((current) => {
      if (
        current &&
        (presets.some((preset) => preset.id === current) || extraIds.includes(current))
      ) {
        return current
      }
      if (activeId && presets.some((preset) => preset.id === activeId)) {
        return activeId
      }
      return presets[0]?.id ?? extraIds[0] ?? null
    })
  }, [activeId, extraIds, presets, ready])

  // 选中预设第一次显示时读取完整配置；启用项直接用 store 里已合并提示词文件的配置
  useEffect(() => {
    const id = selectedId
    if (!ready || !id || draftsRef.current[id] || loadingRef.current.has(id)) {
      return
    }
    loadingRef.current.add(id)
    // 读取完成后总是写回草稿：中途切到别的标签再切回来也不会卡在加载态
    void (async () => {
      try {
        let config: PresetConfig | null = null
        try {
          config =
            id === activeIdRef.current && activeRef.current
              ? activeRef.current
              : await loadPresetConfig(id)
        } catch {
          config = null
        }
        let fallback = false
        if (!config) {
          const summary = presetsRef.current.find((preset) => preset.id === id)
          if (!summary) {
            showToast({ key: 'presetFailed', type: 'error' })
            return
          }
          config = summaryConfig(summary)
          fallback = true
          showToast({
            key: 'presetLoadConfigFallback',
            params: { name: summary.name },
            type: 'error',
          })
        }
        const resolved: PresetConfig = config
        // 读不到完整配置时用列表信息兜底，标记为未保存，用户可以「保存」修复
        setDrafts((prev) =>
          prev[id] ? prev : { ...prev, [id]: draftFromConfig(resolved, fallback) }
        )
      } finally {
        loadingRef.current.delete(id)
      }
    })()
  }, [ready, selectedId])

  // 新建 / 切换标签后把选中的标签滚进可视区
  useEffect(() => {
    if (selectedId) {
      tabRefs.current.get(selectedId)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    }
  }, [selectedId])

  const tabItems = [
    ...presets.map((preset) => {
      const draft = drafts[preset.id]
      return {
        id: preset.id,
        name: draft?.config.name ?? preset.name,
        dirty: draft?.dirty ?? false,
        stored: true,
      }
    }),
    ...extraIds
      .filter((id) => !presets.some((preset) => preset.id === id))
      .map((id) => {
        const draft = drafts[id]
        return {
          id,
          name: draft?.config.name ?? t('presetNewDefaultName'),
          dirty: draft?.dirty ?? false,
          stored: false,
        }
      }),
  ]
  const selected = selectedId ? (drafts[selectedId] ?? null) : null
  const selectedStored = selectedId !== null && presets.some((preset) => preset.id === selectedId)
  const isActive = selectedId !== null && selectedId === activeId
  const errors =
    selected && selectedId && showErrors[selectedId]
      ? validateDraft(selected.text, selected.config)
      : EMPTY_ERRORS
  const storeErrorStatus: Status =
    error === null
      ? null
      : Object.hasOwn(presetErrorKeys, error)
        ? { key: presetErrorKeys[error], error: true }
        : { key: 'presetFailed', error: true }

  const onPick = async (file: File) => {
    setImportStatus(null)
    try {
      await importPresetZip(file)
      showToast({ key: 'presetImported' })
    } catch (error) {
      setImportStatus(presetErrorStatus(error, 'presetImportFailed'))
    }
  }

  const selectTab = (id: string) => {
    setSelectedId(id)
    setSaveStatus(null)
  }

  const createNew = () => {
    const base = createNewPresetConfig(t('presetNewDefaultName'))
    let id = base.id
    let suffix = 1
    while (draftsRef.current[id] || presetsRef.current.some((preset) => preset.id === id)) {
      suffix += 1
      id = `${base.id}-${suffix}`
    }
    const config = id === base.id ? base : { ...base, id }
    setDrafts((prev) => ({ ...prev, [config.id]: draftFromConfig(config, true) }))
    setExtraIds((prev) => [...prev, config.id])
    setSelectedId(config.id)
    setSaveStatus(null)
  }

  const patchConfig = (mutate: (config: PresetConfig) => PresetConfig) => {
    const id = selectedId
    if (!id) {
      return
    }
    setDrafts((prev) => {
      const draft = prev[id]
      if (!draft) {
        return prev
      }
      return { ...prev, [id]: { ...draft, config: mutate(draft.config), dirty: true } }
    })
  }

  const patchText = (field: TextField, value: string) => {
    const id = selectedId
    if (!id) {
      return
    }
    setDrafts((prev) => {
      const draft = prev[id]
      if (!draft) {
        return prev
      }
      return { ...prev, [id]: { ...draft, text: { ...draft.text, [field]: value }, dirty: true } }
    })
  }

  const save = async () => {
    const id = selectedId
    if (!id || saving) {
      return
    }
    const draft = draftsRef.current[id]
    if (!draft) {
      return
    }
    const issues = validateDraft(draft.text, draft.config)
    setShowErrors((prev) => ({ ...prev, [id]: true }))
    if (Object.keys(issues).length > 0) {
      setSaveStatus({ key: 'presetValidationFailed', error: true })
      return
    }
    setSaving(true)
    setSaveStatus(null)
    try {
      const config = configFromDraft(draft)
      await savePresetJson(JSON.stringify(config))
      const stored = (await loadPresetConfig(config.id)) ?? config
      setDrafts((prev) => {
        const current = prev[id]
        if (!current) {
          return prev
        }
        return { ...prev, [id]: draftFromConfig(stored, false) }
      })
      setExtraIds((prev) => prev.filter((extra) => extra !== id))
      setShowErrors((prev) => ({ ...prev, [id]: false }))
      showToast({ key: 'presetSaved' })
    } catch (error) {
      setSaveStatus(presetErrorStatus(error, 'presetSaveFailed'))
    } finally {
      setSaving(false)
    }
  }

  const activate = async () => {
    const id = selectedId
    if (!id || pending || saving) {
      return
    }
    if (!presetsRef.current.some((preset) => preset.id === id)) {
      return
    }
    setPending({ id, action: 'activate' })
    try {
      await activatePreset(id)
    } catch {
      showToast({ key: 'presetActivateFailed', type: 'error' })
    } finally {
      setPending(null)
    }
  }

  const restore = async () => {
    const id = selectedId
    if (!id || pending || saving) {
      return
    }
    if (!presetsRef.current.some((preset) => preset.id === id)) {
      return
    }
    setPending({ id, action: 'restore' })
    try {
      const config =
        id === activeIdRef.current && activeRef.current
          ? activeRef.current
          : await loadPresetConfig(id)
      if (!config) {
        showToast({ key: 'presetFailed', type: 'error' })
        return
      }
      setDrafts((prev) => (prev[id] ? { ...prev, [id]: draftFromConfig(config, false) } : prev))
      setShowErrors((prev) => ({ ...prev, [id]: false }))
      setSaveStatus(null)
    } catch {
      showToast({ key: 'presetFailed', type: 'error' })
    } finally {
      setPending(null)
    }
  }

  const confirmDelete = async () => {
    if (!deleteTarget || deleting) {
      return
    }
    const target = deleteTarget
    setDeleting(true)
    try {
      if (target.stored) {
        await removePreset(target.id)
      }
      // 删除后选中相邻标签：优先右边，其次左边
      const order = tabItems.map((tab) => tab.id)
      const index = order.indexOf(target.id)
      const nextId = order[index + 1] ?? order[index - 1] ?? null
      setDrafts((prev) => withoutKey(prev, target.id))
      setExtraIds((prev) => prev.filter((id) => id !== target.id))
      setShowErrors((prev) => withoutKey(prev, target.id))
      setSelectedId((current) => (current === target.id ? nextId : current))
      setDeleteTarget(null)
      showToast({ key: 'presetDeleted' })
    } catch {
      showToast({ key: 'presetDeleteFailed', type: 'error' })
    } finally {
      setDeleting(false)
    }
  }

  const api: DraftApi = { errors, setConfig: patchConfig, setText: patchText }
  const status = importStatus ?? saveStatus

  return (
    <div className={styles.section} aria-busy={importing || saving}>
      <div className={styles.header}>
        <div className={styles.headerText}>
          <div className={styles.title}>{t('presetSectionTitle')}</div>
          <div className={styles.description}>{t('presetSectionDescription')}</div>
          <div className={styles.hint}>{t('presetImportHint')}</div>
        </div>
        <Button
          variant="outlined"
          size="m"
          className={styles.headerButton}
          disabled={importing}
          onClick={() => fileRef.current?.click()}
        >
          <IconUploadOutline14 />
          {t(importing ? 'presetImporting' : 'presetImport')}
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
      {status ? (
        <div
          className={clsx(styles.status, status.error && styles.statusError)}
          role={status.error ? 'alert' : 'status'}
        >
          {t(status.key, status.params)}
        </div>
      ) : storeErrorStatus ? (
        <div className={clsx(styles.status, styles.statusError)} role="alert">
          {t(storeErrorStatus.key, storeErrorStatus.params)}
        </div>
      ) : null}
      {!ready ? (
        <div className={styles.status} role="status">
          {t('presetLoading')}
        </div>
      ) : (
        <>
          {tabItems.length > 0 ? (
            <div className={styles.tabsRow}>
              <div role="tablist" aria-label={t('presetTabListLabel')} className={styles.tabScroll}>
                {tabItems.map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    aria-selected={tab.id === selectedId}
                    className={clsx(styles.tab, tab.id === selectedId && styles.tabSelected)}
                    ref={(node) => {
                      if (node) {
                        tabRefs.current.set(tab.id, node)
                      } else {
                        tabRefs.current.delete(tab.id)
                      }
                    }}
                    onClick={() => selectTab(tab.id)}
                  >
                    <span className={styles.tabName}>{tab.name}</span>
                    {tab.id === activeId ? (
                      <span className={styles.tabBadge}>{t('presetActive')}</span>
                    ) : null}
                    {tab.dirty ? (
                      <>
                        <span className={styles.dirtyDot} aria-hidden="true" />
                        <span className={styles.srOnly}>{t('presetUnsaved')}</span>
                      </>
                    ) : null}
                  </button>
                ))}
              </div>
              <Button
                variant="outlined"
                size="m"
                className={styles.newTabButton}
                disabled={importing || saving}
                onClick={createNew}
              >
                <span className={styles.plusIcon} aria-hidden="true">
                  ＋
                </span>
                {t('presetNew')}
              </Button>
            </div>
          ) : null}
          {selected && selectedId ? (
            <>
              <div className={styles.toolbar}>
                <div className={styles.toolbarHint}>{selected.dirty ? t('presetUnsaved') : ''}</div>
                <div className={styles.toolbarActions}>
                  <Button
                    variant="outlined"
                    size="m"
                    disabled={!selectedStored || isActive || pending !== null || saving}
                    onClick={() => void activate()}
                  >
                    {t(
                      isActive
                        ? 'presetActive'
                        : pending?.id === selectedId && pending?.action === 'activate'
                          ? 'presetActivating'
                          : 'presetActivate'
                    )}
                  </Button>
                  <Button
                    variant="outlined"
                    size="m"
                    disabled={!selectedStored || !selected.dirty || pending !== null || saving}
                    onClick={() => void restore()}
                  >
                    {t(
                      pending?.id === selectedId && pending?.action === 'restore'
                        ? 'presetRestoring'
                        : 'presetRestore'
                    )}
                  </Button>
                  <Button
                    size="m"
                    disabled={!selected.dirty || saving || pending !== null}
                    onClick={() => void save()}
                  >
                    {t(saving ? 'presetSaving' : 'presetSave')}
                  </Button>
                  <Button
                    variant="dangerOutlined"
                    size="m"
                    disabled={saving || deleting}
                    onClick={() =>
                      setDeleteTarget({
                        id: selectedId,
                        name: selected.config.name,
                        stored: selectedStored,
                      })
                    }
                  >
                    {t('presetDelete')}
                  </Button>
                </div>
              </div>
              <DraftEditor draft={selected} api={api} />
            </>
          ) : selectedId ? (
            <div className={styles.status} role="status">
              {t('presetLoading')}
            </div>
          ) : (
            <div className={styles.empty}>
              <div className={styles.emptyTitle}>{t('presetEmpty')}</div>
              <div className={styles.emptyHint}>{t('presetEmptyHint')}</div>
              <Button size="m" disabled={importing} onClick={createNew}>
                {t('presetNew')}
              </Button>
            </div>
          )}
        </>
      )}
      {deleteTarget ? (
        <Modal
          title={t('presetDeleteConfirmTitle')}
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
                {t(deleting ? 'presetDeleting' : 'presetDelete')}
              </Button>
            </div>
          }
        >
          <div>{t('presetDeleteConfirm')}</div>
          <div className={styles.deleteName}>{deleteTarget.name}</div>
        </Modal>
      ) : null}
    </div>
  )
}

/** 编辑区：5 个子标签共用一个草稿，切换预设时子标签位置保持不变 */
const DraftEditor = ({ draft, api }: PanelProps) => {
  const t = useTranslate()
  const [tab, setTab] = useState<SubTab>('api')
  const id = useId()
  return (
    <div className={styles.editor}>
      <div role="tablist" aria-label={t('presetSubtabsLabel')} className={styles.subTabs}>
        {SUB_TABS.map((item) => (
          <button
            key={item.value}
            type="button"
            role="tab"
            id={`${id}-tab-${item.value}`}
            aria-selected={tab === item.value}
            aria-controls={`${id}-panel-${item.value}`}
            className={clsx(styles.subTab, tab === item.value && styles.subTabActive)}
            onClick={() => setTab(item.value)}
          >
            {t(item.label)}
          </button>
        ))}
      </div>
      <div
        id={`${id}-panel-${tab}`}
        role="tabpanel"
        aria-labelledby={`${id}-tab-${tab}`}
        className={styles.editorPanel}
      >
        {tab === 'api' ? <ApiPanel draft={draft} api={api} /> : null}
        {tab === 'params' ? <ParamsPanel draft={draft} api={api} /> : null}
        {tab === 'prompt' ? <PromptPanel draft={draft} api={api} /> : null}
        {tab === 'memory' ? <MemoryPanel draft={draft} api={api} /> : null}
        {tab === 'compaction' ? <CompactionPanel draft={draft} api={api} /> : null}
      </div>
    </div>
  )
}

/** API 设置：协议、地址、模型；API Key 属于全局设置，不放进预设 */
const ApiPanel = ({ draft, api }: PanelProps) => {
  const t = useTranslate()
  const id = useId()
  const { config } = draft
  const baseUrlError = api.errors.base_url
  const modelError = api.errors.model
  return (
    <div className={styles.panelBody}>
      <Field label={t('presetFieldProtocol')}>
        <Select
          ariaLabel={t('presetFieldProtocol')}
          className={styles.select}
          value={config.protocol}
          options={PROTOCOL_OPTIONS}
          onChange={(protocol) => api.setConfig((current) => ({ ...current, protocol }))}
        />
      </Field>
      <Field
        label={t('presetFieldBaseUrl')}
        htmlFor={`${id}-base-url`}
        error={baseUrlError ? t(baseUrlError.key, baseUrlError.params) : undefined}
      >
        <input
          id={`${id}-base-url`}
          className={clsx(styles.input, baseUrlError && styles.inputInvalid)}
          type="url"
          inputMode="url"
          spellCheck={false}
          value={config.base_url}
          aria-invalid={baseUrlError ? true : undefined}
          onChange={(event) =>
            api.setConfig((current) => ({ ...current, base_url: event.target.value }))
          }
        />
      </Field>
      <Field
        label={t('presetFieldModel')}
        htmlFor={`${id}-model`}
        error={modelError ? t(modelError.key, modelError.params) : undefined}
      >
        <input
          id={`${id}-model`}
          className={clsx(styles.input, modelError && styles.inputInvalid)}
          spellCheck={false}
          value={config.model}
          aria-invalid={modelError ? true : undefined}
          onChange={(event) =>
            api.setConfig((current) => ({ ...current, model: event.target.value }))
          }
        />
      </Field>
      <div className={styles.note}>{t('presetApiKeyNote')}</div>
    </div>
  )
}

/** 模型参数：采样与生成参数，所有数值字段在保存前按 zip.ts 的规则校验 */
const ParamsPanel = ({ draft, api }: PanelProps) => {
  const t = useTranslate()
  const stopId = useId()
  const reasoningOptions: SelectOption<string>[] = [
    { value: '', label: t('presetReasoningEffortNone') },
    ...REASONING_EFFORTS.map((effort) => ({ value: effort, label: effort })),
  ]
  return (
    <div className={styles.panelBody}>
      <div className={styles.grid}>
        <NumberField
          field="temperature"
          label={t('presetFieldTemperature')}
          api={api}
          draft={draft}
        />
        <NumberField field="top_p" label={t('presetFieldTopP')} api={api} draft={draft} />
        <NumberField field="max_tokens" label={t('presetFieldMaxTokens')} api={api} draft={draft} />
        <NumberField
          field="presence_penalty"
          label={t('presetFieldPresencePenalty')}
          api={api}
          draft={draft}
        />
        <NumberField
          field="frequency_penalty"
          label={t('presetFieldFrequencyPenalty')}
          api={api}
          draft={draft}
        />
        <NumberField field="seed" label={t('presetFieldSeed')} api={api} draft={draft} />
      </div>
      <Field label={t('presetFieldStop')} htmlFor={stopId} hint={t('presetFieldStopHint')}>
        <input
          id={stopId}
          className={styles.input}
          spellCheck={false}
          value={draft.text.stop}
          onChange={(event) => api.setText('stop', event.target.value)}
        />
      </Field>
      <Field label={t('presetFieldReasoningEffort')}>
        <Select
          ariaLabel={t('presetFieldReasoningEffort')}
          className={styles.select}
          value={draft.config.params.reasoning_effort ?? ''}
          options={reasoningOptions}
          onChange={(value) =>
            api.setConfig((current) => ({
              ...current,
              params: { ...current.params, reasoning_effort: value === '' ? null : value },
            }))
          }
        />
      </Field>
    </div>
  )
}

/** 提示词：留空使用应用自带；显示字数 */
const PromptPanel = ({ draft, api }: PanelProps) => {
  const t = useTranslate()
  const id = useId()
  const prompt = draft.config.system_prompt ?? ''
  return (
    <div className={styles.panelBody}>
      <div className={styles.note}>{t('presetPromptNote')}</div>
      <Field
        label={t('presetSubtabPrompt')}
        htmlFor={id}
        hint={t('presetPromptCount', { count: prompt.length })}
      >
        <textarea
          id={id}
          className={styles.textarea}
          rows={10}
          spellCheck={false}
          value={prompt}
          onChange={(event) =>
            api.setConfig((current) => ({ ...current, system_prompt: event.target.value }))
          }
        />
      </Field>
    </div>
  )
}

/** 记忆：只读列表来自 services/memory/store.ts（subscribeMemory + listMemories / searchMemories） */
const MemoryPanel = ({ draft, api }: PanelProps) => {
  const t = useTranslate()
  const memory = useSyncExternalStore(subscribeMemory, getMemoryState)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<MemoryEntry[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  const refreshList = useCallback(async () => {
    setBusy(true)
    setFailed(false)
    try {
      await listMemories()
      setResults(null)
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    void refreshList()
  }, [refreshList])

  const runSearch = useCallback(async () => {
    const keyword = query.trim()
    if (!keyword) {
      await refreshList()
      return
    }
    setBusy(true)
    setFailed(false)
    try {
      setResults(await searchMemories({ query: keyword, limit: 20 }))
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }, [query, refreshList])

  const deleteEntry = async (entryId: string) => {
    setBusy(true)
    setFailed(false)
    try {
      await removeMemory(entryId)
      const keyword = query.trim()
      if (results !== null && keyword) {
        setResults(await searchMemories({ query: keyword, limit: 20 }))
      } else {
        await listMemories()
        setResults(null)
      }
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  const sectionLabel = (section: string): string => {
    const key = MEMORY_SECTION_KEYS[section]
    return key ? t(key) : (MEMORY_SECTION_LABELS[section] ?? t('presetMemorySectionUnknown'))
  }

  const entries = results ?? memory.entries

  return (
    <div className={styles.panelBody}>
      <SwitchField
        label={t('presetMemoryEnabled')}
        checked={draft.config.memory.enabled}
        onChange={(enabled) =>
          api.setConfig((current) => ({
            ...current,
            memory: { ...current.memory, enabled },
          }))
        }
      />
      <NumberField
        field="max_results"
        label={t('presetMemoryMaxResults')}
        api={api}
        draft={draft}
      />
      <div className={styles.note}>{t('presetMemoryNote')}</div>
      <div className={styles.memoryHeader}>
        <div className={styles.fieldLabel}>{t('presetMemoryListLabel')}</div>
        <Button variant="outlined" size="s" disabled={busy} onClick={() => void refreshList()}>
          <IconRefreshOutline16 />
          {t('presetMemoryRefresh')}
        </Button>
      </div>
      <div className={styles.memorySearchRow}>
        <input
          className={styles.input}
          type="search"
          value={query}
          placeholder={t('presetMemorySearchPlaceholder')}
          aria-label={t('presetMemorySearchPlaceholder')}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              void runSearch()
            }
          }}
        />
        <Button variant="outlined" size="m" disabled={busy} onClick={() => void runSearch()}>
          <IconSearchOutline16 />
          {t('presetMemorySearch')}
        </Button>
      </div>
      {failed ? (
        <div className={clsx(styles.status, styles.statusError)} role="alert">
          {t('presetMemoryLoadFailed')}
        </div>
      ) : null}
      {busy ? (
        <div className={styles.memoryEmpty} role="status">
          {t('presetMemoryLoading')}
        </div>
      ) : entries.length === 0 ? (
        <div className={styles.memoryEmpty}>{t('presetMemoryEmpty')}</div>
      ) : (
        <ul className={styles.memoryList} aria-label={t('presetMemoryListLabel')}>
          {entries.map((entry) => (
            <li key={entry.id} className={styles.memoryItem}>
              <div className={styles.memoryHead}>
                <span className={styles.memorySection}>{sectionLabel(entry.section)}</span>
                <span className={styles.memoryTime}>{formatMemoryTime(entry.createdAt)}</span>
                <Button
                  variant="dangerOutlined"
                  size="s"
                  className={styles.memoryDelete}
                  aria-label={t('presetMemoryDelete')}
                  disabled={busy}
                  onClick={() => void deleteEntry(entry.id)}
                >
                  <IconTrashOutline16 />
                </Button>
              </div>
              <div className={styles.memoryContent}>{entry.content}</div>
              {entry.tags.length > 0 ? (
                <div className={styles.memoryTags}>
                  {entry.tags.map((tag) => (
                    <span key={tag} className={styles.memoryTag}>
                      {tag}
                    </span>
                  ))}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** 上下文压缩：阈值、保留条数与可选的自定义摘要提示词 */
const CompactionPanel = ({ draft, api }: PanelProps) => {
  const t = useTranslate()
  const id = useId()
  const { config } = draft
  return (
    <div className={styles.panelBody}>
      <SwitchField
        label={t('presetCompactionEnabled')}
        checked={config.compaction.enabled}
        onChange={(enabled) =>
          api.setConfig((current) => ({
            ...current,
            compaction: { ...current.compaction, enabled },
          }))
        }
      />
      <div className={styles.grid}>
        <NumberField
          field="trigger_tokens"
          label={t('presetFieldTriggerTokens')}
          api={api}
          draft={draft}
        />
        <NumberField
          field="keep_recent_messages"
          label={t('presetFieldKeepRecentMessages')}
          api={api}
          draft={draft}
        />
      </div>
      <Field
        label={t('presetCompactionPrompt')}
        htmlFor={id}
        hint={t('presetCompactionPromptNote')}
      >
        <textarea
          id={id}
          className={styles.textarea}
          rows={6}
          spellCheck={false}
          value={config.compaction.prompt ?? ''}
          onChange={(event) =>
            api.setConfig((current) => ({
              ...current,
              compaction: { ...current.compaction, prompt: event.target.value },
            }))
          }
        />
      </Field>
    </div>
  )
}
