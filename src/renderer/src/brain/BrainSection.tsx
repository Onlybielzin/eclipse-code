import { useId, useState } from 'react'
import { useAppState, useStore } from '../store/context'
import { BrainView } from './BrainView'
import type { EngineFactory } from './engineLoader'

const COLLAPSED_KEY = 'eclipse.brainPanel.collapsed'

/** Começa recolhido: só abre (e só carrega o three) quando o vings pedir. */
function readCollapsed(): boolean {
  try {
    return globalThis.localStorage?.getItem(COLLAPSED_KEY) !== '0'
  } catch {
    return true
  }
}

/**
 * Seção recolhível "Cérebro" no rodapé da coluna da direita, no estilo dos painéis Status e Time.
 * Com o cérebro grande aberto no meio, a seção cede o motor: só um contexto WebGL por vez.
 */
export function BrainSection({ createEngine }: { createEngine?: EngineFactory }) {
  const store = useStore()
  const bodyId = useId()
  const brainOpen = useAppState((s) => s.brainOpen)
  const [collapsed, setCollapsed] = useState(readCollapsed)

  const toggle = () => {
    const next = !collapsed
    setCollapsed(next)
    try {
      globalThis.localStorage?.setItem(COLLAPSED_KEY, next ? '1' : '0')
    } catch {
      // armazenamento indisponivel: so perde a lembranca de recolhido/expandido
    }
  }

  return (
    <section className="side-panel brain-panel" aria-label="Cérebro" data-testid="panel-brain">
      <button
        type="button"
        className="side-head"
        aria-expanded={!collapsed}
        aria-controls={bodyId}
        onClick={toggle}
      >
        <span className="side-chev" aria-hidden="true">
          {collapsed ? '›' : '⌄'}
        </span>
        <span className="side-title">Cérebro</span>
      </button>
      {!collapsed && (
        <div className="side-body brain-body" id={bodyId}>
          {brainOpen ? (
            <p className="side-empty">Aberto no painel central.</p>
          ) : (
            <>
              <BrainView createEngine={createEngine} />
              <button
                type="button"
                className="ghost brain-open"
                data-testid="brain-open"
                onClick={() => store.setBrainOpen(true)}
              >
                Abrir no centro
              </button>
            </>
          )}
        </div>
      )}
    </section>
  )
}
