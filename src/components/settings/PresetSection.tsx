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
  DEFAULT_PRESET_NAME,
  importPresetZip,
  loadPresetConfig,
  removePreset,
  savePresetJson,
  usePresetState,
} from '../../services/preset/store.js'
import { PRESET_TEMPLATE_VARIABLES } from '../../services/preset/template.js'
import {
  DEFAULT_PRESET_COMPACTION,
  DEFAULT_PRESET_ID,
  DEFAULT_PRESET_MEMORY,
  DEFAULT_PRESET_PARAMS,
  isBuiltinPreset,
  PresetError,
  resolvePreset,
  type PresetConfig,
  type PresetProtocol,
  type PresetSummary,
} from '../../services/preset/types.js'
import { APP_SYSTEM_PROMPT } from '../../services/chat/reply.js'
import { Button } from '../base/Button.js'
import {
  IconRefreshOutline16,
  IconSearchOutline16,
  IconTrashOutline16,
  IconUploadOutline14,
} from '../base/icons.js'
import { PackIcon } from '../base/PackIcon.js'
import { STYLE_SLOTS } from '../../services/style/types.js'
import { Modal } from '../base/Modal.js'
import { Select, type SelectOption } from '../base/Select.js'
import { showToast } from '../base/toastState.js'
import { listModels } from '../../services/api/client.js'
import { useSettings } from '../../services/settings.js'
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
  reservedId: 'presetErrorReservedId',
  importedReadOnly: 'presetErrorImportedReadOnly',
  missingDescription: 'presetErrorMissingDescription',
  missingAuthor: 'presetErrorMissingAuthor',
  missingVersion: 'presetErrorMissingVersion',
  missingCopyright: 'presetErrorMissingCopyright',
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

/** 元信息必填字段与展示名：保存被拒时在状态栏列出具体字段 */
const METADATA_FIELD_LABELS: {
  field: 'description' | 'author' | 'version' | 'copyright'
  key: TranslationKey
}[] = [
  { field: 'description', key: 'presetFieldDescription' },
  { field: 'author', key: 'presetFieldAuthor' },
  { field: 'version', key: 'presetFieldVersion' },
  { field: 'copyright', key: 'presetFieldCopyright' },
]

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
  /** 内置预设（默认预设 / 内置演示包）：字段留空 = 系统默认，不可删除 */
  builtin: boolean
}

type FieldError = { key: TranslationKey; params?: TranslationParams }

type FieldErrors = Partial<
  Record<
    TextField | 'base_url' | 'model' | 'name' | 'description' | 'author' | 'version' | 'copyright',
    FieldError
  >
>

type NumberRule = {
  min: number
  max: number
  integer: boolean
  optional?: boolean
  message: TranslationKey
}

const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER

/**
 * 应用自带默认配置（未启用任何预设时实际生效的值）。
 * 默认预设里留空的字段用它做 placeholder，让用户看到当前真正生效的值而不是笼统的「使用系统默认」。
 */
const SYSTEM_DEFAULT_PRESET = resolvePreset(null)

/** 应用自带提示词的首行预览（默认预设的提示词空 textarea 的 placeholder） */
const APP_PROMPT_PREVIEW =
  APP_SYSTEM_PROMPT.split('\n')
    .find((line) => line.trim())
    ?.trim() ?? ''

/**
 * 与 services/preset/zip.ts 的校验规则保持一致。
 * 采样参数（temperature / top_p / max_tokens / penalties）全部可选：留空 = 不发送该参数。
 */
const NUMBER_RULES: Record<NumericField, NumberRule> = {
  temperature: {
    min: 0,
    max: 2,
    integer: false,
    optional: true,
    message: 'presetFieldNumberRange',
  },
  top_p: { min: 0, max: 1, integer: false, optional: true, message: 'presetFieldNumberRange' },
  max_tokens: {
    min: 1,
    max: MAX_SAFE_INTEGER,
    integer: true,
    optional: true,
    message: 'presetFieldPositiveInteger',
  },
  presence_penalty: {
    min: -2,
    max: 2,
    integer: false,
    optional: true,
    message: 'presetFieldNumberRange',
  },
  frequency_penalty: {
    min: -2,
    max: 2,
    integer: false,
    optional: true,
    message: 'presetFieldNumberRange',
  },
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

/** 采样参数：留空时不写进请求体；其它数值字段（压缩 / 记忆）是应用内设置，语义不同 */
const API_PARAM_FIELDS: ReadonlySet<NumericField> = new Set<NumericField>([
  'temperature',
  'top_p',
  'max_tokens',
  'presence_penalty',
  'frequency_penalty',
  'seed',
])

/** 只有内置默认预设（id default）展示「系统默认：<具体值>」；其它内置演示包仍用通用文案 */
const isDefaultPresetDraft = (draft: Draft): boolean =>
  draft.builtin && draft.config.id === DEFAULT_PRESET_ID

/**
 * 采样参数空输入时的 placeholder 参考值：只用于展示「不填时接口大概会用什么」，
 * 留空不会把该值写进请求体。压缩 / 记忆字段仍然是应用内设置，用各自的系统默认。
 */
const SYSTEM_DEFAULT_NUMBER_TEXT: Record<NumericField, string | null> = {
  temperature: String(DEFAULT_PRESET_PARAMS.temperature),
  top_p: String(DEFAULT_PRESET_PARAMS.top_p),
  max_tokens: String(DEFAULT_PRESET_PARAMS.max_tokens),
  presence_penalty: String(DEFAULT_PRESET_PARAMS.presence_penalty),
  frequency_penalty: String(DEFAULT_PRESET_PARAMS.frequency_penalty),
  seed: null,
  trigger_tokens: String(SYSTEM_DEFAULT_PRESET.compaction.trigger_tokens),
  keep_recent_messages: String(SYSTEM_DEFAULT_PRESET.compaction.keep_recent_messages),
  max_results: String(SYSTEM_DEFAULT_PRESET.memory.max_results),
}

const EMPTY_ERRORS: FieldErrors = {}

const URL_PATTERN = /^https?:\/\/\S+$/i
const MAX_NAME_LENGTH = 80
const MAX_COPYRIGHT_LENGTH = 500
/** 与 services/preset/zip.ts 的 MAX_TEXT_FIELD 一致：描述 / 作者 / 版本 */
const MAX_METADATA_LENGTH = 400

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

/**
 * 保存前校验：
 * - 采样参数全部可选（留空 = 不发送），已填写的按范围校验；
 * - 普通预设必填协议 / Base URL / 模型，且描述 / 作者 / 版本 / 版权声明（trim 后非空）；
 * - 内置预设（默认预设）豁免上述必填项，只有名称始终必填；已填写的字段仍按原规则校验。
 */
const validateDraft = (draft: Draft): FieldErrors => {
  const { text, config, builtin } = draft
  const errors: FieldErrors = {}
  for (const field of NUMERIC_FIELDS) {
    const parsed = parseNumberField(field, text[field])
    if (isFieldError(parsed)) {
      errors[field] = parsed
    }
  }
  const baseUrl = (config.base_url ?? '').trim()
  if (!baseUrl) {
    if (!builtin) {
      errors.base_url = { key: 'presetFieldRequired' }
    }
  } else if (!URL_PATTERN.test(baseUrl)) {
    errors.base_url = { key: 'presetFieldUrl' }
  }
  if (!(config.model ?? '').trim() && !builtin) {
    errors.model = { key: 'presetFieldRequired' }
  }
  const name = config.name.trim()
  if (!name) {
    errors.name = { key: 'presetFieldRequired' }
  } else if (name.length > MAX_NAME_LENGTH) {
    errors.name = { key: 'presetFieldNameTooLong', params: { max: MAX_NAME_LENGTH } }
  }
  const metadata: [keyof FieldErrors, string | undefined][] = [
    ['description', config.description],
    ['author', config.author],
    ['version', config.version],
  ]
  for (const [field, value] of metadata) {
    const textValue = value?.trim() ?? ''
    if (!textValue) {
      if (!builtin) {
        errors[field] = { key: 'presetFieldRequired' }
      }
    } else if (textValue.length > MAX_METADATA_LENGTH) {
      errors[field] = {
        key: 'presetFieldTextTooLong',
        params: { max: MAX_METADATA_LENGTH },
      }
    }
  }
  const copyright = config.copyright?.trim() ?? ''
  if (!copyright) {
    if (!builtin) {
      errors.copyright = { key: 'presetFieldRequired' }
    }
  } else if (copyright.length > MAX_COPYRIGHT_LENGTH) {
    errors.copyright = {
      key: 'presetCopyrightTooLong',
      params: { max: MAX_COPYRIGHT_LENGTH },
    }
  } else if (copyright.includes('<') || copyright.includes('>')) {
    errors.copyright = { key: 'presetCopyrightInvalid' }
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

/** 数值输入初值：内置预设未填写的字段留空（placeholder 提示「使用系统默认」） */
const textFromConfig = (config: PresetConfig): TextMap => {
  const params = config.params ?? {}
  const compaction = config.compaction ?? {}
  const memory = config.memory ?? {}
  const numberText = (value: number | null | undefined): string =>
    value === undefined || value === null ? '' : String(value)
  return {
    temperature: numberText(params.temperature),
    top_p: numberText(params.top_p),
    max_tokens: numberText(params.max_tokens),
    stop: params.stop?.join(', ') ?? '',
    presence_penalty: numberText(params.presence_penalty),
    frequency_penalty: numberText(params.frequency_penalty),
    seed: numberText(params.seed),
    trigger_tokens: numberText(compaction.trigger_tokens),
    keep_recent_messages: numberText(compaction.keep_recent_messages),
    max_results: numberText(memory.max_results),
  }
}

/**
 * 内置预设的编辑草稿：协议 / Base URL / 模型 / 记忆 / 压缩把系统默认值真正填进空字段，
 * 让用户看到当前实际生效的配置；提示词与采样参数**不预填**（空着 = 不发送 / 不设置）。
 */
const withSystemDefaults = (config: PresetConfig): PresetConfig => {
  if (!isBuiltinPreset(config)) {
    return config
  }
  const defaults = SYSTEM_DEFAULT_PRESET
  return {
    ...config,
    protocol: config.protocol ?? defaults.protocol,
    base_url: config.base_url?.trim() ? config.base_url : defaults.base_url,
    model: config.model?.trim() ? config.model : defaults.model,
    memory: { ...defaults.memory, ...(config.memory ?? {}) },
    compaction: { ...defaults.compaction, ...(config.compaction ?? {}) },
  }
}

const draftFromConfig = (config: PresetConfig, dirty: boolean): Draft => ({
  config: withSystemDefaults(config),
  text: textFromConfig(withSystemDefaults(config)),
  dirty,
  builtin: isBuiltinPreset(config),
})

/** 从输入原文读一个可选数值：留空或非法时返回 undefined（内置预设留空 = 系统默认） */
const optionalNumberFromText = (field: NumericField, text: TextMap): number | undefined => {
  const parsed = parseNumberField(field, text[field])
  return typeof parsed === 'number' ? parsed : undefined
}

/**
 * 内置默认预设的保存形态：只写入用户填写 / 修改过的字段，留空字段不落盘，
 * 运行时由 resolvePreset 解析成系统默认（行为与无预设一致）。
 */
const partialConfigFromDraft = (draft: Draft): PresetConfig => {
  const { config, text } = draft
  const next: PresetConfig = {
    schema: 1,
    id: config.id,
    name: config.name.trim(),
    ...(draft.builtin ? { builtin: true } : {}),
  }
  const description = config.description?.trim()
  if (description) {
    next.description = description
  }
  const author = config.author?.trim()
  if (author) {
    next.author = author
  }
  const version = config.version?.trim()
  if (version) {
    next.version = version
  }
  const copyright = config.copyright?.trim()
  if (copyright) {
    next.copyright = copyright
  }
  if (config.protocol) {
    next.protocol = config.protocol
  }
  const baseUrl = (config.base_url ?? '').trim().replace(/\/+$/, '')
  if (baseUrl) {
    next.base_url = baseUrl
  }
  const model = (config.model ?? '').trim()
  if (model) {
    next.model = model
  }
  const params: NonNullable<PresetConfig['params']> = {}
  const temperature = optionalNumberFromText('temperature', text)
  if (temperature !== undefined) {
    params.temperature = temperature
  }
  const topP = optionalNumberFromText('top_p', text)
  if (topP !== undefined) {
    params.top_p = topP
  }
  const maxTokens = optionalNumberFromText('max_tokens', text)
  if (maxTokens !== undefined) {
    params.max_tokens = maxTokens
  }
  const presencePenalty = optionalNumberFromText('presence_penalty', text)
  if (presencePenalty !== undefined) {
    params.presence_penalty = presencePenalty
  }
  const frequencyPenalty = optionalNumberFromText('frequency_penalty', text)
  if (frequencyPenalty !== undefined) {
    params.frequency_penalty = frequencyPenalty
  }
  const seed = optionalNumberFromText('seed', text)
  if (seed !== undefined) {
    params.seed = seed
  }
  if (text.stop.trim()) {
    params.stop = stopFromText(text)
  }
  const reasoningEffort = config.params?.reasoning_effort
  if (reasoningEffort) {
    params.reasoning_effort = reasoningEffort
  }
  if (Object.keys(params).length > 0) {
    next.params = params
  }
  const prompt = config.system_prompt
  if (prompt?.trim()) {
    next.system_prompt = prompt
  }
  const compaction: NonNullable<PresetConfig['compaction']> = {}
  if (config.compaction?.enabled !== undefined) {
    compaction.enabled = config.compaction.enabled
  }
  const triggerTokens = optionalNumberFromText('trigger_tokens', text)
  if (triggerTokens !== undefined) {
    compaction.trigger_tokens = triggerTokens
  }
  const keepRecent = optionalNumberFromText('keep_recent_messages', text)
  if (keepRecent !== undefined) {
    compaction.keep_recent_messages = keepRecent
  }
  const compactionPrompt = config.compaction?.prompt
  if (compactionPrompt?.trim()) {
    compaction.prompt = compactionPrompt
  }
  if (Object.keys(compaction).length > 0) {
    next.compaction = compaction
  }
  const memory: NonNullable<PresetConfig['memory']> = {}
  if (config.memory?.enabled !== undefined) {
    memory.enabled = config.memory.enabled
  }
  const maxResults = optionalNumberFromText('max_results', text)
  if (maxResults !== undefined) {
    memory.max_results = maxResults
  }
  if (Object.keys(memory).length > 0) {
    next.memory = memory
  }
  return next
}

/**
 * 普通预设的保存形态：完整配置，协议 / Base URL / 模型与四项元信息必填（与 zip 校验一致）。
 * 采样参数只写显式填写的字段：留空 = 请求体不出现该字段（接口默认值）。
 */
const strictConfigFromDraft = (draft: Draft): PresetConfig => {
  const { config, text } = draft
  const compaction = config.compaction ?? {}
  const memory = config.memory ?? {}
  const prompt = config.system_prompt
  const compactionPrompt = compaction.prompt
  const params: NonNullable<PresetConfig['params']> = {}
  const numericParams = [
    'temperature',
    'top_p',
    'max_tokens',
    'presence_penalty',
    'frequency_penalty',
  ] as const
  for (const field of numericParams) {
    const value = optionalNumberFromText(field, text)
    if (value !== undefined) {
      params[field] = value
    }
  }
  const seed = optionalNumberFromText('seed', text)
  if (seed !== undefined) {
    params.seed = seed
  }
  const stop = stopFromText(text)
  if (stop.length > 0) {
    params.stop = stop
  }
  const reasoningEffort = config.params?.reasoning_effort
  if (reasoningEffort) {
    params.reasoning_effort = reasoningEffort
  }
  return {
    schema: 1,
    id: config.id,
    name: config.name.trim(),
    ...(config.description === undefined ? {} : { description: config.description.trim() }),
    ...(config.author === undefined ? {} : { author: config.author.trim() }),
    ...(config.version === undefined ? {} : { version: config.version.trim() }),
    ...(config.copyright === undefined ? {} : { copyright: config.copyright.trim() }),
    protocol: config.protocol ?? 'anthropic',
    base_url: (config.base_url ?? '').trim().replace(/\/+$/, ''),
    model: (config.model ?? '').trim(),
    ...(prompt?.trim() ? { system_prompt: prompt } : {}),
    ...(Object.keys(params).length > 0 ? { params } : {}),
    compaction: {
      enabled: compaction.enabled ?? DEFAULT_PRESET_COMPACTION.enabled,
      trigger_tokens: numberFromText(
        'trigger_tokens',
        text,
        compaction.trigger_tokens ?? DEFAULT_PRESET_COMPACTION.trigger_tokens
      ),
      keep_recent_messages: numberFromText(
        'keep_recent_messages',
        text,
        compaction.keep_recent_messages ?? DEFAULT_PRESET_COMPACTION.keep_recent_messages
      ),
      prompt: compactionPrompt?.trim() ? compactionPrompt : null,
    },
    memory: {
      enabled: memory.enabled ?? DEFAULT_PRESET_MEMORY.enabled,
      max_results: numberFromText(
        'max_results',
        text,
        memory.max_results ?? DEFAULT_PRESET_MEMORY.max_results
      ),
    },
    ...(config.system_prompt_file ? { system_prompt_file: config.system_prompt_file } : {}),
    ...(config.icon ? { icon: config.icon } : {}),
    ...(config.license ? { license: config.license } : {}),
    ...(config.builtin ? { builtin: true } : {}),
  }
}

/** 把草稿整理成可保存的配置：内置默认预设只落填写过的字段，普通预设保持完整必填配置 */
const configFromDraft = (draft: Draft): PresetConfig =>
  draft.builtin ? partialConfigFromDraft(draft) : strictConfigFromDraft(draft)

/** 新建预设：id 按 createPresetDraft 的规则生成，名字换成界面上的默认名 */
const createNewPresetConfig = (name: string): PresetConfig => {
  const config = JSON.parse(createPresetDraft()) as PresetConfig & { $comment?: string }
  delete config.$comment
  return { ...config, name }
}

/** 读不到完整配置时，用列表摘要拼一份基础配置，至少能继续编辑与保存 */
const summaryConfig = (summary: PresetSummary): PresetConfig =>
  summary.builtin === true || summary.id === DEFAULT_PRESET_ID
    ? { schema: 1, id: summary.id, name: summary.name, builtin: true }
    : {
        schema: 1,
        id: summary.id,
        name: summary.name,
        description: summary.description,
        author: summary.author,
        version: summary.version,
        copyright: summary.copyright,
        protocol: summary.protocol,
        base_url: summary.baseUrl,
        model: summary.model,
        compaction: { ...DEFAULT_PRESET_COMPACTION },
        memory: { ...DEFAULT_PRESET_MEMORY },
      }

const formatMemoryTime = (timestamp: number): string =>
  Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : ''

/** 列表 / 标签上的「作者 · 版本」摘要；两者都没有时为空串 */
const presetMeta = (config: { author?: string; version?: string }): string =>
  [config.author?.trim(), config.version?.trim()].filter(Boolean).join(' · ')

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

type SubTab = 'basic' | 'api' | 'params' | 'prompt' | 'memory' | 'compaction'

const SUB_TABS: { value: SubTab; label: TranslationKey }[] = [
  { value: 'basic', label: 'presetSubtabBasic' },
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
  /** 导入预设只读：所有可编辑控件从这里取 disabled / readOnly */
  readOnly: boolean
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
  disabled = false,
}: {
  checked: boolean
  label: string
  onChange: (checked: boolean) => void
  disabled?: boolean
}) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={label}
    className={clsx(styles.switch, checked && styles.switchOn)}
    disabled={disabled}
    onClick={() => onChange(!checked)}
  >
    <span className={styles.switchThumb} aria-hidden="true" />
  </button>
)

const SwitchField = ({
  label,
  checked,
  onChange,
  disabled = false,
}: {
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
}) => (
  <div className={styles.switchRow}>
    <div className={styles.fieldLabel}>{label}</div>
    <Switch checked={checked} label={label} onChange={onChange} disabled={disabled} />
  </div>
)

/**
 * 数值输入：显示草稿里的输入原文，错误由保存前置校验产生。
 * 采样参数留空 = 不发送该参数；placeholder 给出接口参考值，不写入请求体。
 */
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
  const defaultText = SYSTEM_DEFAULT_NUMBER_TEXT[field]
  const placeholder = API_PARAM_FIELDS.has(field)
    ? defaultText === null
      ? t('presetParamUnsent')
      : t('presetParamUnsentWithDefault', { value: defaultText })
    : isDefaultPresetDraft(draft)
      ? t('presetDefaultValue', { value: defaultText ?? t('presetDefaultEmpty') })
      : draft.builtin
        ? t('presetUseSystemDefault')
        : undefined
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
        placeholder={placeholder}
        readOnly={api.readOnly}
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
    builtin: boolean
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

  /** 默认预设的内置名按界面语言显示；用户改名后显示改名后的名称 */
  const presetName = (id: string, name: string, builtin: boolean): string => {
    const trimmed = name.trim()
    return builtin && id === DEFAULT_PRESET_ID && (!trimmed || trimmed === DEFAULT_PRESET_NAME)
      ? t('presetDefaultName')
      : name
  }

  const tabItems = [
    ...presets.map((preset) => {
      const draft = drafts[preset.id]
      const config = draft?.config ?? preset
      const builtin = draft?.builtin ?? (preset.builtin === true || preset.id === DEFAULT_PRESET_ID)
      return {
        id: preset.id,
        name: presetName(preset.id, config.name, builtin),
        meta: presetMeta(config),
        builtin,
        // 导入包只读：标签上显示「导入」徽标，选中后编辑器进入只读态
        imported: preset.source === 'imported',
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
          meta: draft ? presetMeta(draft.config) : '',
          builtin: draft?.builtin ?? false,
          imported: false,
          dirty: draft?.dirty ?? false,
          stored: false,
        }
      }),
  ]
  const selected = selectedId ? (drafts[selectedId] ?? null) : null
  const selectedStored = selectedId !== null && presets.some((preset) => preset.id === selectedId)
  const selectedBuiltin = selected?.builtin ?? false
  /** 导入的预设只读（默认预设与用户自建预设不受影响） */
  const selectedImported =
    selectedId !== null &&
    presets.some((preset) => preset.id === selectedId && preset.source === 'imported')
  const isActive = selectedId !== null && selectedId === activeId
  /** 当前启用预设的展示名；没有任何启用项时为 null */
  const activePreset =
    activeId === null ? undefined : presets.find((preset) => preset.id === activeId)
  const activeName =
    activePreset === undefined
      ? null
      : presetName(
          activePreset.id,
          activePreset.name,
          activePreset.builtin === true || activePreset.id === DEFAULT_PRESET_ID
        )
  const errors =
    selected && selectedId && showErrors[selectedId] ? validateDraft(selected) : EMPTY_ERRORS
  const storeErrorStatus: Status =
    error === null
      ? null
      : Object.hasOwn(presetErrorKeys, error)
        ? { key: presetErrorKeys[error], error: true }
        : { key: 'presetFailed', error: true }

  const onPick = async (file: File) => {
    setImportStatus(null)
    try {
      const imported = await importPresetZip(file)
      showToast({ key: 'presetImported' })
      // 导入不会抢占当前启用项：切到新预设并明确提示「尚未启用」
      setSelectedId(imported.id)
      if (activeIdRef.current !== imported.id) {
        setImportStatus({ key: 'presetSavedNotActive', params: { name: imported.name } })
      }
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

  /**
   * 从导入预设复制一份可编辑副本：去掉 zip 资源引用（icon / license / system_prompt_file
   * 只能来自导入包，新预设没有对应文件内容），提示词用已合并的文本；保存后就成为自建预设。
   */
  const copyAsNew = () => {
    const id = selectedId
    const draft = id ? draftsRef.current[id] : undefined
    if (!id || !draft) {
      return
    }
    const base: PresetConfig = { ...draft.config }
    delete base.icon
    delete base.license
    delete base.system_prompt_file
    delete base.builtin
    let nextId = `custom-${Date.now().toString(36)}`
    let suffix = 1
    while (draftsRef.current[nextId] || presetsRef.current.some((preset) => preset.id === nextId)) {
      suffix += 1
      nextId = `custom-${Date.now().toString(36)}-${suffix}`
    }
    const config: PresetConfig = {
      ...base,
      id: nextId,
      name: t('presetCopyName', { name: draft.config.name }),
    }
    setDrafts((prev) => ({ ...prev, [nextId]: draftFromConfig(config, true) }))
    setExtraIds((prev) => [...prev, nextId])
    setSelectedId(nextId)
    setSaveStatus(null)
  }

  const patchConfig = (mutate: (config: PresetConfig) => PresetConfig) => {
    const id = selectedId
    // 导入预设只读：字段已禁用，这里再兜底拒绝写入草稿
    if (!id || selectedImported) {
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
    if (!id || selectedImported) {
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
    const issues = validateDraft(draft)
    setShowErrors((prev) => ({ ...prev, [id]: true }))
    if (Object.keys(issues).length > 0) {
      // 元信息缺失时明确列出字段（字段级错误在「基本信息」里同时标红）
      const missingMetadata = METADATA_FIELD_LABELS.filter(({ field }) => issues[field]).map(
        ({ key }) => t(key)
      )
      setSaveStatus(
        missingMetadata.length > 0
          ? {
              key: 'presetMetadataRequiredError',
              params: { fields: missingMetadata.join(t('presetMetadataListSeparator')) },
              error: true,
            }
          : { key: 'presetValidationFailed', error: true }
      )
      return
    }
    setSaving(true)
    setSaveStatus(null)
    try {
      const config = configFromDraft(draft)
      // 保存本身不会切换启用项（只有当前启用项会被重新载入）：非启用预设保存后需手动「启用」
      const wasActive = activeIdRef.current === config.id
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
      if (wasActive) {
        showToast({ key: 'presetSaved' })
      } else {
        // 明确告诉用户：已保存，但请求仍会使用当前启用项，必须点「启用」才生效
        setSaveStatus({ key: 'presetSavedNotActive', params: { name: config.name } })
      }
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
    // 启用读取的是已保存配置：草稿里有未保存修改时先拦住，避免提示词被旧值覆盖
    if (draftsRef.current[id]?.dirty) {
      setSaveStatus({ key: 'presetActivateUnsaved', error: true })
      return
    }
    setPending({ id, action: 'activate' })
    try {
      await activatePreset(id)
      setSaveStatus(null)
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
    // 内置预设不可删除：按钮已禁用，这里再兜底
    if (target.builtin) {
      setDeleteTarget(null)
      return
    }
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

  const api: DraftApi = {
    errors,
    setConfig: patchConfig,
    setText: patchText,
    readOnly: selectedImported,
  }
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
          <PackIcon slot={STYLE_SLOTS.iconUpload} size={14} fallback={<IconUploadOutline14 />} />
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
                    title={`id: ${tab.id}`}
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
                    {tab.meta ? <span className={styles.tabMeta}>{tab.meta}</span> : null}
                    {tab.builtin ? (
                      <span className={styles.tabBadge}>{t('presetBuiltinBadge')}</span>
                    ) : null}
                    {tab.imported ? (
                      <span className={styles.tabBadge}>{t('presetImportedBadge')}</span>
                    ) : null}
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
                  <PackIcon slot={STYLE_SLOTS.iconAdd} size={14} fallback="＋" />
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
                  {selectedImported ? (
                    <Button
                      variant="outlined"
                      size="m"
                      disabled={saving || pending !== null}
                      onClick={copyAsNew}
                    >
                      {t('presetCopyAsNew')}
                    </Button>
                  ) : (
                    <Button
                      size="m"
                      disabled={!selected.dirty || saving || pending !== null}
                      onClick={() => void save()}
                    >
                      {t(saving ? 'presetSaving' : 'presetSave')}
                    </Button>
                  )}
                  <Button
                    variant="dangerOutlined"
                    size="m"
                    disabled={saving || deleting || selectedBuiltin}
                    title={selectedBuiltin ? t('presetBuiltinUndeletable') : undefined}
                    onClick={() =>
                      setDeleteTarget({
                        id: selectedId,
                        name: selected.config.name,
                        stored: selectedStored,
                        builtin: selectedBuiltin,
                      })
                    }
                  >
                    {t('presetDelete')}
                  </Button>
                </div>
              </div>
              {selectedImported ? (
                <div className={styles.importedNote} role="note">
                  <span className={styles.tabBadge}>{t('presetImportedBadge')}</span>
                  <span>{t('presetImportedReadOnly')}</span>
                </div>
              ) : null}
              {selectedStored && !isActive ? (
                <div className={styles.activateNote} role="note">
                  <span className={styles.activateNoteBadge}>{t('presetActivate')}</span>
                  <span>
                    {activeName === null
                      ? t('presetNotActiveHintNone')
                      : t('presetNotActiveHint', { name: activeName })}
                  </span>
                </div>
              ) : null}
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

/** 编辑区：6 个子标签共用一个草稿，切换预设时子标签位置保持不变 */
const DraftEditor = ({ draft, api }: PanelProps) => {
  const t = useTranslate()
  const [tab, setTab] = useState<SubTab>('basic')
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
        {tab === 'basic' ? <BasicPanel draft={draft} api={api} /> : null}
        {tab === 'api' ? <ApiPanel draft={draft} api={api} /> : null}
        {tab === 'params' ? <ParamsPanel draft={draft} api={api} /> : null}
        {tab === 'prompt' ? <PromptPanel draft={draft} api={api} /> : null}
        {tab === 'memory' ? <MemoryPanel draft={draft} api={api} /> : null}
        {tab === 'compaction' ? <CompactionPanel draft={draft} api={api} /> : null}
      </div>
    </div>
  )
}

/**
 * 基本信息：名称（可改、允许重名）、描述、作者、版本、版权声明与只读 ID。
 * id 是系统识别用的唯一标识（类似包名），创建后不可修改；name 只用于展示。
 */
const BasicPanel = ({ draft, api }: PanelProps) => {
  const t = useTranslate()
  const id = useId()
  const { config, builtin } = draft
  const nameError = api.errors.name
  const descriptionError = api.errors.description
  const authorError = api.errors.author
  const versionError = api.errors.version
  const copyrightError = api.errors.copyright
  /** 非内置预设的元信息必填；内置预设留空 = 使用系统默认 */
  const required = !builtin
  const star = required ? ' *' : ''
  const placeholder = builtin ? t('presetUseSystemDefault') : undefined
  return (
    <div className={styles.panelBody}>
      {builtin ? (
        <div className={styles.note}>
          {t('presetBuiltinBadge')} · {t('presetBuiltinUndeletable')}
        </div>
      ) : null}
      <Field
        label={`${t('presetFieldName')} *`}
        htmlFor={`${id}-name`}
        error={nameError ? t(nameError.key, nameError.params) : undefined}
      >
        <input
          id={`${id}-name`}
          className={clsx(styles.input, nameError && styles.inputInvalid)}
          value={config.name}
          readOnly={api.readOnly}
          aria-invalid={nameError ? true : undefined}
          onChange={(event) =>
            api.setConfig((current) => ({ ...current, name: event.target.value }))
          }
        />
      </Field>
      <div className={styles.note}>{t('presetMetadataHint')}</div>
      {required ? <div className={styles.note}>{t('presetMetadataRequiredHint')}</div> : null}
      <Field
        label={`${t('presetFieldDescription')}${star}`}
        htmlFor={`${id}-description`}
        error={descriptionError ? t(descriptionError.key, descriptionError.params) : undefined}
      >
        <textarea
          id={`${id}-description`}
          className={clsx(styles.textarea, descriptionError && styles.inputInvalid)}
          rows={2}
          value={config.description ?? ''}
          placeholder={placeholder}
          readOnly={api.readOnly}
          aria-invalid={descriptionError ? true : undefined}
          onChange={(event) =>
            api.setConfig((current) => ({ ...current, description: event.target.value }))
          }
        />
      </Field>
      <div className={styles.grid}>
        <Field
          label={`${t('presetFieldAuthor')}${star}`}
          htmlFor={`${id}-author`}
          error={authorError ? t(authorError.key, authorError.params) : undefined}
        >
          <input
            id={`${id}-author`}
            className={clsx(styles.input, authorError && styles.inputInvalid)}
            value={config.author ?? ''}
            placeholder={placeholder}
            readOnly={api.readOnly}
            aria-invalid={authorError ? true : undefined}
            onChange={(event) =>
              api.setConfig((current) => ({ ...current, author: event.target.value }))
            }
          />
        </Field>
        <Field
          label={`${t('presetFieldVersion')}${star}`}
          htmlFor={`${id}-version`}
          error={versionError ? t(versionError.key, versionError.params) : undefined}
        >
          <input
            id={`${id}-version`}
            className={clsx(styles.input, versionError && styles.inputInvalid)}
            value={config.version ?? ''}
            placeholder={placeholder}
            readOnly={api.readOnly}
            aria-invalid={versionError ? true : undefined}
            onChange={(event) =>
              api.setConfig((current) => ({ ...current, version: event.target.value }))
            }
          />
        </Field>
      </div>
      <Field
        label={`${t('presetFieldCopyright')}${star}`}
        htmlFor={`${id}-copyright`}
        error={copyrightError ? t(copyrightError.key, copyrightError.params) : undefined}
        hint={t('presetCopyrightHint')}
      >
        <textarea
          id={`${id}-copyright`}
          className={clsx(styles.textarea, copyrightError && styles.inputInvalid)}
          rows={3}
          value={config.copyright ?? ''}
          placeholder={builtin ? t('presetUseSystemDefault') : t('presetCopyrightPlaceholder')}
          readOnly={api.readOnly}
          aria-invalid={copyrightError ? true : undefined}
          onChange={(event) =>
            api.setConfig((current) => ({ ...current, copyright: event.target.value }))
          }
        />
      </Field>
      <Field label={t('presetFieldId')} htmlFor={`${id}-id`} hint={t('presetIdReadonly')}>
        <input
          id={`${id}-id`}
          className={styles.input}
          value={config.id}
          readOnly
          spellCheck={false}
        />
      </Field>
    </div>
  )
}

/** API 设置：协议、地址、模型；API Key 属于全局设置，不放进预设 */
const ApiPanel = ({ draft, api }: PanelProps) => {
  const t = useTranslate()
  const id = useId()
  const { config, builtin } = draft
  const defaultDraft = isDefaultPresetDraft(draft)
  const baseUrlError = api.errors.base_url
  const modelError = api.errors.model
  const apiKey = useSettings((state) => state.apiKey)
  const [models, setModels] = useState<string[]>([])
  const [modelListState, setModelListState] = useState<'idle' | 'loading' | 'error' | 'empty'>(
    'idle'
  )
  const [modelListError, setModelListError] = useState('')

  const loadModelList = async () => {
    if (!apiKey) {
      setModelListState('error')
      setModelListError(t('presetModelListNoKey'))
      return
    }
    setModelListState('loading')
    setModelListError('')
    try {
      const list = await listModels(apiKey)
      setModels(list)
      setModelListState(list.length === 0 ? 'empty' : 'idle')
    } catch (error) {
      // 失败时不保留旧列表，只显示错误，避免列表看起来仍然可用
      setModels([])
      setModelListState('error')
      setModelListError(error instanceof Error ? error.message : String(error))
    }
  }
  const protocolOptions: SelectOption<string>[] = builtin
    ? [
        {
          value: '',
          // 默认预设：直接显示当前生效的协议；其它内置包用通用文案
          label: defaultDraft
            ? t('presetDefaultValue', { value: SYSTEM_DEFAULT_PRESET.protocol })
            : t('presetUseSystemDefault'),
        },
        ...PROTOCOL_OPTIONS,
      ]
    : PROTOCOL_OPTIONS
  const baseUrlPlaceholder = defaultDraft
    ? t('presetDefaultValue', { value: SYSTEM_DEFAULT_PRESET.base_url })
    : builtin
      ? t('presetUseSystemDefault')
      : undefined
  const modelPlaceholder = defaultDraft
    ? t('presetDefaultValue', { value: SYSTEM_DEFAULT_PRESET.model })
    : builtin
      ? t('presetUseSystemDefault')
      : undefined
  return (
    <div className={styles.panelBody}>
      {builtin ? <div className={styles.note}>{t('presetDefaultFieldsHint')}</div> : null}
      <Field label={`${t('presetFieldProtocol')} *`}>
        <Select
          ariaLabel={t('presetFieldProtocol')}
          className={styles.select}
          value={config.protocol ?? ''}
          placeholder={t('presetUseSystemDefault')}
          options={protocolOptions}
          disabled={api.readOnly}
          onChange={(protocol) =>
            api.setConfig((current) => ({
              ...current,
              protocol: protocol === '' ? undefined : (protocol as PresetProtocol),
            }))
          }
        />
      </Field>
      <Field
        label={`${t('presetFieldBaseUrl')} *`}
        htmlFor={`${id}-base-url`}
        error={baseUrlError ? t(baseUrlError.key, baseUrlError.params) : undefined}
      >
        <input
          id={`${id}-base-url`}
          className={clsx(styles.input, baseUrlError && styles.inputInvalid)}
          type="url"
          inputMode="url"
          spellCheck={false}
          value={config.base_url ?? ''}
          placeholder={baseUrlPlaceholder}
          readOnly={api.readOnly}
          aria-invalid={baseUrlError ? true : undefined}
          onChange={(event) =>
            api.setConfig((current) => ({ ...current, base_url: event.target.value }))
          }
        />
      </Field>
      <Field
        label={`${t('presetFieldModel')} *`}
        htmlFor={`${id}-model`}
        error={modelError ? t(modelError.key, modelError.params) : undefined}
      >
        <div className={styles.fieldRow}>
          <input
            id={`${id}-model`}
            className={clsx(styles.input, modelError && styles.inputInvalid)}
            spellCheck={false}
            value={config.model ?? ''}
            placeholder={modelPlaceholder}
            readOnly={api.readOnly}
            aria-invalid={modelError ? true : undefined}
            onChange={(event) =>
              api.setConfig((current) => ({ ...current, model: event.target.value }))
            }
          />
          <Button
            variant="outlined"
            size="s"
            disabled={api.readOnly || modelListState === 'loading'}
            onClick={loadModelList}
          >
            {modelListState === 'loading'
              ? t('presetModelListFetching')
              : t('presetModelListFetch')}
          </Button>
        </div>
        {models.length > 0 ? (
          // 模型列表固定在输入框下方，独立滚动；点一项即写入 model，当前模型高亮
          <div className={styles.modelList} role="listbox" aria-label={t('presetModelListSelect')}>
            {models.map((model) => {
              const selected = model === (config.model ?? '')
              return (
                <button
                  key={model}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className={clsx(styles.modelItem, selected && styles.modelItemSelected)}
                  onClick={() => api.setConfig((current) => ({ ...current, model }))}
                >
                  <span className={styles.modelName}>{model}</span>
                  {selected ? <span className={styles.modelCheck}>✓</span> : null}
                </button>
              )
            })}
          </div>
        ) : null}
        {modelListState === 'loading' ? (
          <div className={styles.modelHint} role="status">
            {t('presetModelListFetching')}
          </div>
        ) : null}
        {modelListState === 'error' ? (
          <div className={styles.modelHint} role="alert">
            {t('presetModelListError')} {modelListError}
          </div>
        ) : null}
        {modelListState === 'empty' ? (
          <div className={styles.modelHint}>{t('presetModelListEmpty')}</div>
        ) : null}
      </Field>
      <div className={styles.note}>{t('presetApiKeyNote')}</div>
    </div>
  )
}

/** 模型参数：采样参数留空 = 不发送（接口默认值），已填写的按 zip.ts 的规则校验 */
const ParamsPanel = ({ draft, api }: PanelProps) => {
  const t = useTranslate()
  const stopId = useId()
  // 留空 = 请求体里不出现 stop / 采样参数；不发送占位提示
  const stopPlaceholder = t('presetParamUnsent')
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
          placeholder={stopPlaceholder}
          readOnly={api.readOnly}
          onChange={(event) => api.setText('stop', event.target.value)}
        />
      </Field>
      <Field label={t('presetFieldReasoningEffort')}>
        <Select
          ariaLabel={t('presetFieldReasoningEffort')}
          className={styles.select}
          value={draft.config.params?.reasoning_effort ?? ''}
          options={reasoningOptions}
          disabled={api.readOnly}
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

/** 提示词：textarea 内容就是完整提示词原文；空 = 请求里不出现 system；支持模板变量 */
const PromptPanel = ({ draft, api }: PanelProps) => {
  const t = useTranslate()
  const id = useId()
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const prompt = draft.config.system_prompt ?? ''
  const defaultDraft = isDefaultPresetDraft(draft)
  // 空 textarea 的说明：留空 = 不发送 system；默认预设额外给出应用自带提示词作为参考
  const placeholder = defaultDraft
    ? t('presetPromptEmptyHint', { preview: APP_PROMPT_PREVIEW })
    : t('presetPromptEmptyHintShort')
  /** 在光标处插入模板变量；插入后把光标放到变量后面继续输入 */
  const insertVariable = (variable: string) => {
    if (api.readOnly) {
      return
    }
    const token = `{{${variable}}}`
    const textarea = textareaRef.current
    const start = textarea?.selectionStart ?? prompt.length
    const end = textarea?.selectionEnd ?? start
    api.setConfig((current) => ({
      ...current,
      system_prompt: `${prompt.slice(0, start)}${token}${prompt.slice(end)}`,
    }))
    const caret = start + token.length
    requestAnimationFrame(() => {
      const element = textareaRef.current
      if (!element) {
        return
      }
      element.focus()
      element.setSelectionRange(caret, caret)
    })
  }
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
          ref={textareaRef}
          className={styles.textarea}
          rows={10}
          spellCheck={false}
          value={prompt}
          placeholder={placeholder}
          readOnly={api.readOnly}
          onChange={(event) =>
            api.setConfig((current) => ({ ...current, system_prompt: event.target.value }))
          }
        />
      </Field>
      <div className={styles.note}>{t('presetPromptTemplateNote')}</div>
      <div
        className={styles.templateVars}
        role="group"
        aria-label={t('presetPromptTemplateVarsLabel')}
      >
        {PRESET_TEMPLATE_VARIABLES.map((variable) => (
          <Button
            key={variable}
            variant="outlined"
            size="s"
            disabled={api.readOnly}
            onClick={() => insertVariable(variable)}
          >
            {`{{${variable}}}`}
          </Button>
        ))}
      </div>
    </div>
  )
}

/** 记忆：只读列表来自 services/memory/store.ts（subscribeMemory + listMemories / searchMemories） */
const MemoryPanel = ({ draft, api }: PanelProps) => {
  const t = useTranslate()
  const defaultDraft = isDefaultPresetDraft(draft)
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
        checked={draft.config.memory?.enabled ?? DEFAULT_PRESET_MEMORY.enabled}
        disabled={api.readOnly}
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
      {defaultDraft ? (
        <div className={styles.note}>
          {t('presetMemoryDefaultHint', {
            state: SYSTEM_DEFAULT_PRESET.memory.enabled
              ? t('presetDefaultOn')
              : t('presetDefaultOff'),
            maxResults: SYSTEM_DEFAULT_PRESET.memory.max_results,
          })}
        </div>
      ) : null}
      <div className={styles.note}>{t('presetMemoryNote')}</div>
      <div className={styles.memoryHeader}>
        <div className={styles.fieldLabel}>{t('presetMemoryListLabel')}</div>
        <Button variant="outlined" size="s" disabled={busy} onClick={() => void refreshList()}>
          <PackIcon slot={STYLE_SLOTS.iconRefresh} size={14} fallback={<IconRefreshOutline16 />} />
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
          <PackIcon slot={STYLE_SLOTS.iconSearch} size={14} fallback={<IconSearchOutline16 />} />
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
                  <PackIcon
                    slot={STYLE_SLOTS.iconDelete}
                    size={14}
                    fallback={<IconTrashOutline16 />}
                  />
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
  const defaultDraft = isDefaultPresetDraft(draft)
  const defaultCompaction = SYSTEM_DEFAULT_PRESET.compaction
  return (
    <div className={styles.panelBody}>
      <SwitchField
        label={t('presetCompactionEnabled')}
        checked={config.compaction?.enabled ?? DEFAULT_PRESET_COMPACTION.enabled}
        disabled={api.readOnly}
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
      {defaultDraft ? (
        <div className={styles.note}>
          {t('presetCompactionDefaultHint', {
            state: defaultCompaction.enabled ? t('presetDefaultOn') : t('presetDefaultOff'),
            triggerTokens: defaultCompaction.trigger_tokens,
            keepRecent: defaultCompaction.keep_recent_messages,
          })}
        </div>
      ) : null}
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
          value={config.compaction?.prompt ?? ''}
          placeholder={draft.builtin ? t('presetUseSystemDefault') : undefined}
          readOnly={api.readOnly}
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
