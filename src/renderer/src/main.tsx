import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { AppStore } from './store/appStore'
import './styles.css'

const container = document.getElementById('root')
if (!container) throw new Error('elemento #root ausente')
const store = new AppStore(window.eclipse)
createRoot(container).render(
  <StrictMode>
    <App store={store} />
  </StrictMode>,
)
