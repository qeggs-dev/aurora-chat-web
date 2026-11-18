import { create } from 'zustand'

/** 移动端抽屉关闭原因：决定退出时播哪些动效（逐项退出只在「收起侧边栏 / 开启新对话」时播） */
export type MobileSiderCloseReason = 'plain' | 'collapse' | 'newChat' | 'selection'

/** 移动端侧边栏抽屉：顶栏菜单按钮打开，点遮罩、切换会话或开启新对话后关闭 */
export const useMobileSider = create(() => ({
  open: false,
  closeReason: 'plain' as MobileSiderCloseReason,
}))

export const openMobileSider = () => useMobileSider.setState({ open: true })

/** 关闭抽屉；reason 供退出动效编排使用（选中会话 = selection，收起/新对话 = list 类） */
export const closeMobileSider = (reason: MobileSiderCloseReason = 'plain') =>
  useMobileSider.setState({ open: false, closeReason: reason })
