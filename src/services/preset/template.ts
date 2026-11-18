/**
 * 系统提示词模板：把 `{{preset.*}}` / `{{env.*}}` 变量渲染成当前生效配置的实际值。
 *
 * 预设与应用自带的 system prompt 都可以当模板用，用户可自行组合变量；
 * 渲染只在拼请求时发生，不改写预设里保存的原文。未识别的变量**原样保留**，
 * 没有变量时输出与输入完全一致（不会因为接入模板而改变现有提示词）。
 */
import { DEFAULT_PRESET_ID, resolvePreset, type ResolvedPreset } from './types.js'

/** 运行时环境快照（与 chat/runtimeInfo 的 RuntimeEnv 结构一致，这里不反向依赖 chat 层） */
export type PresetTemplateEnv = {
  platform: string
  app: string
  version?: string
  locale: string
  theme: string
}

/** 未启用预设（默认预设无任何覆盖字段）时，dump 里显示的「应用自带默认配置」名称 */
export const BUILTIN_DEFAULT_PRESET_NAME = '应用自带的默认配置'

/**
 * 提示词模板支持的变量（稳定顺序，UI 的变量按钮与文档都按这个表走）。
 * 不含 `preset.system_prompt` 与任何时间变量：前者会递归，后者会破坏 KV cache。
 */
export const PRESET_TEMPLATE_VARIABLES = [
  'preset.name',
  'preset.id',
  'preset.protocol',
  'preset.base_url',
  'preset.model',
  'preset.params',
  'preset.memory',
  'preset.compaction',
  'preset.dump',
  'env.platform',
  'env.app',
  'env.version',
  'env.locale',
  'env.theme',
] as const

export type PresetTemplateVariable = (typeof PRESET_TEMPLATE_VARIABLES)[number]

/**
 * 生效预设的内容摘要（含名称 / id / 协议 / 端点 / 模型 / 参数 / 记忆 / 压缩）。
 * 不含 system_prompt 自身（模板就写在提示词里，套进去会递归）；
 * 也不含 API Key（预设里本来就没有，Key 是全局设置）。
 */
export type PresetDump = {
  name: string
  id: string
  protocol: string
  base_url: string
  model: string
  params: ResolvedPreset['params']
  memory: ResolvedPreset['memory']
  compaction: ResolvedPreset['compaction']
}

/**
 * 构造生效预设摘要：`null`（未启用预设）时用 `resolvePreset(null)` 的系统默认，
 * 并给出「应用自带的默认配置」名称与内置默认 id，而不是空串或原样占位符。
 */
export const presetDump = (resolved: ResolvedPreset | null): PresetDump => {
  const value = resolved ?? resolvePreset(null)
  return {
    name: resolved ? value.name : BUILTIN_DEFAULT_PRESET_NAME,
    id: resolved ? value.id : DEFAULT_PRESET_ID,
    protocol: value.protocol,
    base_url: value.base_url,
    model: value.model,
    params: value.params,
    memory: value.memory,
    compaction: value.compaction,
  }
}

/** 变量名 → 渲染文本；缺失的变量（例如拿不到版本号）不放进表里，交给调用方保留原样 */
export const presetTemplateValues = (
  resolved: ResolvedPreset | null,
  env: PresetTemplateEnv
): Record<string, string> => {
  const dump = presetDump(resolved)
  const values: Record<string, string> = {
    'preset.name': dump.name,
    'preset.id': dump.id,
    'preset.protocol': dump.protocol,
    'preset.base_url': dump.base_url,
    'preset.model': dump.model,
    'preset.params': JSON.stringify(dump.params),
    'preset.memory': JSON.stringify(dump.memory),
    'preset.compaction': JSON.stringify(dump.compaction),
    'preset.dump': JSON.stringify(dump, null, 2),
    'env.platform': env.platform,
    'env.app': env.app,
    'env.locale': env.locale,
    'env.theme': env.theme,
  }
  // 版本号在构建产物之外拿不到：此时保留 `{{env.version}}`，而不是替换成空串
  if (env.version) {
    values['env.version'] = env.version
  }
  return values
}

/** 双花括号变量：允许 `{{ preset.model }}` 这种内部带空格的写法 */
const VARIABLE_PATTERN = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g

/**
 * 渲染提示词模板。未知变量与暂无值的变量保留原样，多次出现逐个替换；
 * 插入的值不会被再次渲染（单趟替换，不存在递归展开）。
 */
export const renderPromptTemplate = (
  text: string,
  resolved: ResolvedPreset | null,
  env: PresetTemplateEnv
): string => {
  if (!text.includes('{{')) {
    return text
  }
  const values = presetTemplateValues(resolved, env)
  return text.replace(VARIABLE_PATTERN, (match, name: string) => values[name] ?? match)
}
