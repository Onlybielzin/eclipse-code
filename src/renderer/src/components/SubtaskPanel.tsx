import { useEffect, useState } from 'react'
import { PROVIDER_LABELS, SUBTASK_STATE_LABELS, type Subtask } from '@shared/domain'
import { countCompleted, STATE_ICON_CLASS, subtaskElapsed } from '../store/format'
import { useAppState, useStore } from '../store/context'

const EMPTY: Subtask[] = []

/** Relogio de 30 s para o tempo das subtarefas que ainda correm. */
function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}

/** Coluna direita: subtarefas da tarefa aberta, com estado, papel, modelo e tempo. */
export function SubtaskPanel() {
  const store = useStore()
  const taskId = useAppState((s) => s.selectedTaskId)
  const subs =
    useAppState((s) => (s.selectedTaskId ? s.subtasks[s.selectedTaskId] : undefined)) ?? EMPTY
  const selected = useAppState((s) => s.selectedSubtaskId)
  const roles = useAppState((s) => s.roles)
  const task = useAppState((s) => s.tasks.find((t) => t.id === taskId) ?? null)
  const now = useNow()

  return (
    <section className="col" aria-label="Subtarefas">
      <div className="colhead">
        Subtarefas
        {subs.length > 0 && (
          <span className="sp" data-testid="subtask-count">
            {countCompleted(subs)}/{subs.length} prontas
          </span>
        )}
      </div>
      <div className="scroll">
        {!task && <p className="empty">Nenhuma tarefa aberta.</p>}
        {task && subs.length === 0 && (
          <p className="empty">
            {task.kind === 'solo'
              ? 'Sem subtarefas. É só o terminal.'
              : 'O Líder ainda não criou subtarefas.'}
          </p>
        )}
        {subs.map((sub) => {
          const role = roles[sub.roleId]
          const model = role ? (role.model ?? PROVIDER_LABELS[role.provider]) : null
          return (
            <button
              type="button"
              key={sub.id}
              className={`sub-item ${selected === sub.id ? 'sel' : ''}`}
              aria-pressed={selected === sub.id}
              data-testid={`subtask-${sub.id}`}
              onClick={() => void store.selectSubtask(sub.id)}
            >
              <i
                className={`ic ${STATE_ICON_CLASS[sub.state]}`}
                title={SUBTASK_STATE_LABELS[sub.state]}
              />
              <span className="nm">{role?.name ?? 'Membro'}</span>
              <span className="ds">{sub.title}</span>
              <span className="who">
                {SUBTASK_STATE_LABELS[sub.state]}
                {model ? ` · ${model}` : ''} · {subtaskElapsed(sub, now)}
              </span>
            </button>
          )
        })}
      </div>
    </section>
  )
}
