import { create } from 'zustand'
import { useSettings } from '../../services/settings.js'

/** 设置弹窗的分组：通用设置 / 数据管理 / 用量统计 / 样式 / Preset / 关于 */
export type SettingsSection = 'general' | 'data' | 'usage' | 'style' | 'preset' | 'about'

/** 打开设置时触发按钮的视口矩形：PC 端弹窗从按钮放大 / 缩回按钮 */
export type SettingsOriginRect = { left: number; top: number; width: number; height: number }

/** 设置弹窗：侧边栏底部、没有 API Key 时的操作与 401 提示都可以打开；section 为打开时选中的分组 */
export const useSettingsDialog = create(() => ({
  open: false,
  section: 'general' as SettingsSection,
  origin: null as SettingsOriginRect | null,
}))

export const openSettings = (
  section: SettingsSection,
  origin: SettingsOriginRect | null = null
) => useSettingsDialog.setState({ open: true, section, origin })

/** 只标记关闭：origin 保留到退出动画播完，供缩回按钮使用 */
export const closeSettings = () => useSettingsDialog.setState({ open: false })

/** 没有 API Key 时打开设置并选中 API Key 所在的「数据管理」，返回是否已有 Key */
export const ensureApiKey = () => {
  if (useSettings.getState().apiKey) {
    return true
  }
  openSettings('data')
  return false
}
