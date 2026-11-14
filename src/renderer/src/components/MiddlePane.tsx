import type { MidTab } from '../store/appStore'
import { useAppState, useStore } from '../store/context'
import { BrainView } from '../brain/BrainView'
import { ActivityView } from './ActivityView'
import { DeliveryView, QuestionBox } from './DeliveryView'
import { LeaderTerminal } from './LeaderTerminal'
import { TaskStatusMenu } from './TaskStatusMenu'

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
  const brainOpen = useAppState((s) => s.brainOpen)
  const task = useAppState((s) => s.tasks.find((t) => t.id === taskId) ?? null)
  const subtask = useAppState((s) =>
    taskId && subtaskId ? (s.subtasks[taskId]?.find((x) => x.id === subtaskId) ?? null) : null,
  )
  const detail = useAppState((s) => (subtaskId ? s.details[subtaskId] : undefined))
  const activity = useAppState((s) => (subtaskId ? s.activity[subtaskId] : undefined))
  // Pergunta que o Lider repassou (sem subtarefa): aparece em cima do terminal dele.
  const leaderQuestion = useAppState(
    (s) =>
      s.questions.find((q) => q.taskId === taskId && q.subtaskId === null && q.status === 'open') ??
      null,
  )

  const closeBrain = (
    <button type="button" className="ghost sp" onClick={() => store.setBrainOpen(false)}>
      Fechar
    </button>
  )

  if (!task) {
    return (
      <section className="col" aria-label="Centro">
        <div className="colhead">
          {brainOpen ? 'Cérebro' : 'Líder'}
          {brainOpen && closeBrain}
        </div>
        {brainOpen ? (
          <div className="mid">
            <BrainView full />
          </div>
        ) : (
          <div className="empty">Escolha uma tarefa na lista ou crie uma nova.</div>
        )}
      </section>
    )
  }

  const showLeader = !subtask || tab === 'leader'
  const leaderTitle = task.kind === 'team' ? 'Líder · terminal' : 'Terminal'

  return (
    <section className="col" aria-label="Centro">
      <div className="colhead">
        <span className="mid-title">
          {brainOpen ? 'Cérebro' : subtask ? subtask.title : leaderTitle}
        </span>
        {brainOpen && closeBrain}
        {!brainOpen && !subtask && (
          <span className="mid-status" data-testid="mid-status">
            <TaskStatusMenu
              variant="pill"
              status={task.workflowStatus}
              taskTitle={task.title}
              onChange={(status) => void store.setTaskStatus(task.id, status)}
            />
          </span>
        )}
        {!brainOpen && subtask && (
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
        {brainOpen && (
          <div className="mid-layer" data-testid="brain-middle">
            <BrainView full />
          </div>
        )}
        <div className="mid-layer" hidden={brainOpen || !showLeader}>
          {task.status === 'archived' ? (
            <div className="empty" data-testid="task-launched">
              Tarefa concluída e arquivada. Os agentes foram fechados. Para reabrir, troque o status
              no ícone da tarefa.
            </div>
          ) : (
            <>
              {leaderQuestion && (
                <div className="leader-question" data-testid="leader-question">
                  <QuestionBox key={leaderQuestion.id} question={leaderQuestion} />
                </div>
              )}
              <LeaderTerminal key={task.id} task={task} />
            </>
          )}
        </div>
        {!brainOpen && subtask && tab === 'delivery' && (
          <DeliveryView subtask={subtask} detail={detail} />
        )}
        {!brainOpen && subtask && tab === 'activity' && (
          <ActivityView events={activity} working={subtask.state === 'working'} />
        )}
      </div>
    </section>
  )
}
