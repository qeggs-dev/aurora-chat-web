import { createRoot } from 'react-dom/client'
import { App } from './app/App.js'
import { ErrorBoundary } from './components/base/ErrorBoundary.js'
import { setupTheme } from './app/theme.js'
import { ensureKatex } from './services/markdown/katex.js'
import { initLocalePacks } from './services/locale/store.js'
import './app/theme.css'
import './app/motion.css'
import './app/global.css'

ensureKatex()
setupTheme()
// 自定义语言包在启动时从 IndexedDB 加载；加载完成会触发 useTranslate 重新渲染
void initLocalePacks()

createRoot(document.getElementById('root') as HTMLElement).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
)
