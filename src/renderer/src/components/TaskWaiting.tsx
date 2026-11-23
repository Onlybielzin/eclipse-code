import { useEffect, useState } from 'react'
import type { Task } from '@shared/domain'
import { useAppState, useStore } from '../store/context'

/**
 * Meio da tarefa em "Esperando outra": no lugar do terminal do Lider, a linha de espera
 * (texto pronto do main) e o botao que manda a tarefa para "A fazer".
 */
export function TaskWaiting({ task }: { task: Task }) {
  const store = useStore()
  // A outra muda de status por evento da lista: busca de novo a cada mudanca.
  const tasks = useAppState((s) => s.tasks)
  const [message, setMessage] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    store
      .call('tasks.waitInfo', { taskId: task.id })
      .then((info) => alive && setMessage(info?.message ?? null))
      .catch(() => alive && setMessage(null))
    return () => {
      alive = false
    }
  }, [store, task.id, tasks])
  return (
    <div className="empty" data-testid="task-waiting">
      <p>{message ?? 'Esperando outra tarefa.'}</p>
      <button type="button" onClick={() => void store.setTaskStatus(task.id, 'a_fazer')}>
        Iniciar agora
      </button>
    </div>
  )
}
