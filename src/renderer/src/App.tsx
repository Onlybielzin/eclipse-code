import { useEffect } from 'react'
import { MiddlePane } from './components/MiddlePane'
import { SubtaskPanel } from './components/SubtaskPanel'
import { TaskList } from './components/TaskList'
import { TitleBar } from './components/TitleBar'
import type { AppStore } from './store/appStore'
import { StoreProvider, useAppState, useStore } from './store/context'

function ErrorBar() {
  const store = useStore()
  const error = useAppState((s) => s.error)
  if (!error) return null
  return (
    <div className="errorbar" role="alert">
      {error}
      <button type="button" className="ghost" onClick={() => store.clearError()}>
        Fechar
      </button>
    </div>
  )
}

function Shell() {
  const status = useAppState((s) => s.status)
  const hasProject = useAppState((s) => s.projectId !== null)
  return (
    <div className="app">
      <TitleBar />
      <ErrorBar />
      {status === 'loading' ? (
        <div className="empty">Carregando...</div>
      ) : !hasProject ? (
        <div className="empty">
          Nenhum projeto ainda. Use "+ projeto" e informe a pasta do repositório.
        </div>
      ) : (
        <div className="cols">
          <TaskList />
          <MiddlePane />
          <SubtaskPanel />
        </div>
      )}
    </div>
  )
}

/** Tela de 3 colunas da maquete: tarefas, Líder ou entrega, subtarefas. */
export function App({ store }: { store: AppStore }) {
  useEffect(() => {
    void store.start()
    return () => store.stop()
  }, [store])
  return (
    <StoreProvider store={store}>
      <Shell />
    </StoreProvider>
  )
}
