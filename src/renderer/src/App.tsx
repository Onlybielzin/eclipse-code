import { useEffect, useState } from 'react'
import type { AppInfo } from '@shared/ipc'

/**
 * TODO(renderer): tres colunas da maquete (sem-canvas-lista-de-tarefas.html):
 * tarefas a esquerda, terminal do Lider ou entrega no meio, subtarefas a direita,
 * e "Precisa de você" no topo.
 */
export function App() {
  const [info, setInfo] = useState<AppInfo | null>(null)

  useEffect(() => {
    void window.eclipse.invoke('app.info', {}).then((result) => {
      if (result.ok) setInfo(result.value)
    })
  }, [])

  return (
    <main className="shell">
      <h1>Eclipse Code</h1>
      <p>Esqueleto do app novo. Nenhuma tarefa ainda.</p>
      {info && (
        <p className="muted">
          Electron {info.electron} · dados em {info.userDataPath}
        </p>
      )}
    </main>
  )
}
