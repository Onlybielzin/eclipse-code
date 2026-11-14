import { useState } from 'react'
import { PROVIDER_LABELS, type Subtask } from '@shared/domain'
import {
  countCompleted,
  STATE_ICON_CLASS,
  subtaskElapsed,
  subtaskRowLabel,
  subtaskSummary,
} from '../store/format'
import { useNow } from '../store/useNow'
import { useAppState, useStore } from '../store/context'

const EMPTY: Subtask[] = []

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
  const [showClosed, setShowClosed] = useState(false)
  // Bloqueadas e canceladas sao finais e nao pedem acao: ficam num grupo recolhido.
  const closed = subs.filter((x) => x.state === 'failed' || x.state === 'canceled')
  const active = subs.filter((x) => x.state !== 'failed' && x.state !== 'canceled')
  // A subtarefa aberta no meio nunca some da coluna: o grupo abre se ela estiver nele.
  const closedOpen = showClosed || closed.some((x) => x.id === selected)
  const renderSub = (sub: Subtask) => {
    const role = roles[sub.roleId]
    const model = role ? (role.model ?? PROVIDER_LABELS[role.provider]) : null
    const stateLabel = subtaskRowLabel(sub)
    return (
      <button
        type="button"
        key={sub.id}
        className={`sub-item ${selected === sub.id ? 'sel' : ''}`}
        aria-pressed={selected === sub.id}
        data-testid={`subtask-${sub.id}`}
        onClick={() => void store.selectSubtask(sub.id)}
      >
        <i className={`ic ${STATE_ICON_CLASS[sub.state]}`} title={stateLabel} />
        <span className="head">
          <span className="nm">{role?.name ?? 'Membro'}</span>
          <span className="ds">{sub.title}</span>
        </span>
        <span className="who" title={stateLabel}>
          <span className="who-state" data-state={sub.state}>
            {stateLabel}
          </span>
          {model ? ` · ${model}` : ''} · {subtaskElapsed(sub, now)}
        </span>
      </button>
    )
  }

  return (
    <section className="col col-subs" aria-label="Subtarefas">
      <div className="colhead">
        Subtarefas
        {subs.length > 0 && (
          <span className="sp" data-testid="subtask-count">
            {countCompleted(subs)}/{subs.length} prontas
          </span>
        )}
      </div>
      {subs.length > 0 && (
        <div className="seg-wrap">
          <div className="seg-bar" data-testid="subtask-bar" aria-hidden="true">
            {subs.map((x) => (
              <i key={x.id} className="seg" data-state={x.state} />
            ))}
          </div>
          <p className="seg-sum" data-testid="subtask-summary">
            {subtaskSummary(subs, now)}
          </p>
        </div>
      )}
      <div className="scroll">
        {!task && <p className="empty">Nenhuma tarefa aberta.</p>}
        {task && subs.length === 0 && (
          <p className="empty">
            {task.kind === 'solo'
              ? 'Sem subtarefas. É só o terminal.'
              : 'O Líder ainda não criou subtarefas.'}
          </p>
        )}
        {active.map(renderSub)}
        {closed.length > 0 && (
          <div className="sub-closed">
            <button
              type="button"
              className="sub-closed-head"
              aria-expanded={closedOpen}
              onClick={() => setShowClosed(!closedOpen)}
            >
              <span aria-hidden="true">{closedOpen ? '⌄' : '›'}</span>
              <i className={`ic ${STATE_ICON_CLASS.failed}`} aria-hidden="true" />
              Bloqueadas e canceladas
              <span className="sp">{closed.length}</span>
            </button>
            {closedOpen && closed.map(renderSub)}
          </div>
        )}
      </div>
    </section>
  )
}
