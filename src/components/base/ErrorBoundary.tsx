import { Component, type ErrorInfo, type ReactNode } from 'react'
import { translate } from '../../i18n/index.js'

type Props = { children: ReactNode }
type State = { error: Error | null }

const toError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error))

/**
 * 应用根节点兜底：初始渲染（模块求值、App 首帧）抛出异常时显示错误信息与「重新加载」，
 * 而不是整页白屏。错误边界只捕获渲染期异常，不处理事件回调里的错误。
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null }

  static getDerivedStateFromError(error: unknown): State {
    return { error: toError(error) }
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    // oxlint-disable-next-line no-console
    console.error('[render] 应用渲染失败', error, info.componentStack)
  }

  override render() {
    const { error } = this.state
    if (!error) {
      return this.props.children
    }
    return (
      <div
        role="alert"
        style={{
          position: 'fixed',
          inset: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 16,
          padding: 24,
          background: '#fff',
          color: '#1f2329',
          fontFamily: 'system-ui, sans-serif',
          textAlign: 'center',
        }}
      >
        <h1 style={{ margin: 0, fontSize: 20 }}>{translate('appCrashed')}</h1>
        <pre
          style={{
            maxWidth: '80ch',
            maxHeight: '40vh',
            margin: 0,
            overflow: 'auto',
            padding: 12,
            borderRadius: 8,
            background: '#f5f6f7',
            fontSize: 13,
            whiteSpace: 'pre-wrap',
            textAlign: 'left',
          }}
        >
          {error.message}
        </pre>
        <button
          type="button"
          style={{ padding: '8px 20px', fontSize: 14, cursor: 'pointer' }}
          onClick={() => window.location.reload()}
        >
          {translate('reloadApp')}
        </button>
      </div>
    )
  }
}
