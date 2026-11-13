import type { MidTab } from '../store/appStore'
import { useAppState, useStore } from '../store/context'
import { ActivityView } from './ActivityView'
import { DeliveryView } from './DeliveryView'
import { LeaderTerminal } from './LeaderTerminal'

const TABS: { id: MidTab; label: string }[] = [
  { id: 'delivery', label: 'Entrega' },
  { id: 'activity', label: 'Atividade' },
  { id: 'leader', label: 'Líder' },
]

/** Meio: terminal do Lider, ou a subtarefa aberta com abas Entrega, Atividade e Lider. */
export function MiddlePane() {
  const store = useStore()
  const taskId = useAppState((s) => s.selectedTaskId)
  const subtaskId = useAppState((s) => s.selectedSubtaskId)
  const tab = useAppState((s) => s.midTab)
  const task = useAppState((s) => s.tasks.find((t) => t.id === taskId) ?? null)
  const subtask = useAppState((s) =>
    taskId && subtaskId ? (s.subtasks[taskId]?.find((x) => x.id === subtaskId) ?? null) : null,
  )
  const detail = useAppState((s) => (subtaskId ? s.details[subtaskId] : undefined))
  const activity = useAppState((s) => (subtaskId ? s.activity[subtaskId] : undefined))

  if (!task) {
    return (
      <section className="col" aria-label="Centro">
        <div className="colhead">Líder</div>
        <div className="empty">Escolha uma tarefa na lista ou crie uma nova.</div>
      </section>
    )
  }

  const showLeader = !subtask || tab === 'leader'
  const leaderTitle = task.kind === 'team' ? 'Líder · terminal' : 'Terminal'

  return (
    <section className="col" aria-label="Centro">
      <div className="colhead">
        <span className="mid-title">{subtask ? subtask.title : leaderTitle}</span>
        {subtask && (
          <span className="sp tabs" role="tablist" aria-label="Visão da subtarefa">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                aria-pressed={tab === t.id}
                onClick={() => store.setMidTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </span>
        )}
      </div>
      <div className="mid">
        {/* O terminal fica montado enquanto a tarefa nao muda, para nao perder o xterm ao trocar de aba. */}
        <div className="mid-layer" hidden={!showLeader}>
          <LeaderTerminal key={task.id} task={task} />
        </div>
        {subtask && tab === 'delivery' && <DeliveryView subtask={subtask} detail={detail} />}
        {subtask && tab === 'activity' && <ActivityView events={activity} />}
      </div>
    </section>
  )
}
