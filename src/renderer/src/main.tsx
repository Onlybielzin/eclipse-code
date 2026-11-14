import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { AppStore } from './store/appStore'
import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import './styles.css'

const container = document.getElementById('root')
if (!container) throw new Error('elemento #root ausente')
// Sem a ponte do preload a tela ficaria presa em "Carregando...". Mostra o erro.
const bridge = (window as { eclipse?: typeof window.eclipse }).eclipse
if (!bridge) {
  container.innerHTML =
    '<div class="empty">A ponte com o app não carregou (preload). Veja o log do app.</div>'
} else {
  // O xterm mede a célula ao abrir; sem a fonte pronta a grade sai errada.
  await document.fonts.load('13px "Geist Mono Variable"').catch(() => {})
  const store = new AppStore(bridge)
  createRoot(container).render(
    <StrictMode>
      <App store={store} />
    </StrictMode>,
  )
}
