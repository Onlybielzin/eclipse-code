import { useEffect } from 'react'
import type { MobileCol } from '../store/appStore'
import { useAppState, useStore } from '../store/context'

const TABS: { id: MobileCol; label: string }[] = [
  { id: 'tasks', label: 'Tarefas' },
  { id: 'middle', label: 'Líder' },
  { id: 'subtasks', label: 'Subtarefas' },
]

/**
 * Barra de abas fixa do celular. Sair da lista empurra uma entrada no history, e o botão
 * voltar do Android (popstate) volta para a lista.
 */
export function MobileNav() {
  const store = useStore()
  const col = useAppState((s) => s.mobileCol)

  useEffect(() => {
    if (col !== 'tasks' && !(window.history.state as { eclipseCol?: boolean } | null)?.eclipseCol)
      window.history.pushState({ eclipseCol: true }, '')
  }, [col])

  useEffect(() => {
    const onPop = () => store.setMobileCol('tasks')
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [store])

  const pick = (id: MobileCol) => {
    store.setMobileCol(id)
    // A entrada empurrada sobra ao voltar para a lista: desfaz para o voltar não ficar duplo.
    if (id === 'tasks' && (window.history.state as { eclipseCol?: boolean } | null)?.eclipseCol)
      window.history.back()
  }

  return (
    <nav className="mobile-nav" aria-label="Colunas">
      {TABS.map((t) => (
        <button key={t.id} type="button" aria-pressed={col === t.id} onClick={() => pick(t.id)}>
          {t.label}
        </button>
      ))}
    </nav>
  )
}
