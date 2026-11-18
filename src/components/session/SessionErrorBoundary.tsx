import { Component, type ErrorInfo, type ReactNode } from 'react'
import { translate } from '../../i18n/index.js'

type Props = {
  children: ReactNode
  /** 返回会话列表（清空当前选择）；错误边界的「返回会话列表」按钮调用它 */
  onBack: () => void
}
type State = { message: string | null }

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/**
 * 会话级兜底：单个会话渲染异常时只替换会话区域，其他界面（侧边栏、设置）仍然可用，
 * 并提供「返回会话列表」把界面恢复到可用状态，而不是整树白屏。
 */
export class SessionErrorBoundary extends Component<Props, State> {
  override state: State = { message: null }

  static getDerivedStateFromError(error: unknown): State {
    return { message: messageOf(error) }
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    // oxlint-disable-next-line no-console
    console.error('[session] 会话渲染失败', error, info.componentStack)
  }

  private readonly backToSessions = () => {
    this.setState({ message: null })
    this.props.onBack()
  }

  override render() {
    const { message } = this.state
    if (message === null) {
      return this.props.children
    }
    return (
      <div
        role="alert"
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 16,
          height: '100%',
          padding: 24,
          color: 'var(--dsw-alias-label-primary)',
          textAlign: 'center',
        }}
      >
        <p style={{ margin: 0, fontSize: 14 }}>{translate('sessionRenderFailed')}</p>
        <pre
          style={{
            maxWidth: '80ch',
            maxHeight: '30vh',
            margin: 0,
            overflow: 'auto',
            padding: 12,
            borderRadius: 8,
            background: 'var(--dsw-alias-bg-elevated)',
            fontSize: 13,
            whiteSpace: 'pre-wrap',
            textAlign: 'left',
          }}
        >
          {message}
        </pre>
        <button
          type="button"
          style={{ padding: '8px 20px', fontSize: 14, cursor: 'pointer' }}
          onClick={this.backToSessions}
        >
          {translate('backToSessions')}
        </button>
      </div>
    )
  }
}
