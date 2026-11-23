import { useState } from 'react'
import { isTerminalTask } from '@shared/domain'
import type { MidTab } from '../store/appStore'
import { useAppState, useStore } from '../store/context'
import { BrainView } from '../brain/BrainView'
import { WallView } from '../wall/WallView'
import { ActivityView } from './ActivityView'
import { DeliveryView, QuestionBox } from './DeliveryView'
import { LeaderTerminal } from './LeaderTerminal'
import { ShellTab, StartTab } from './TaskProcessTab'
import { TaskStatusMenu } from './TaskStatusMenu'
import { TaskWaiting } from './TaskWaiting'

const LEADER_TABS: { id: MidTab; label: string }[] = [
  { id: 'leader', label: 'Líder' },
  { id: 'start', label: 'Iniciar' },
  { id: 'terminal', label: 'Terminal' },
]
const TERMINAL_TABS: { id: MidTab; label: string }[] = [
  { id: 'terminal', label: 'Terminal' },
  { id: 'start', label: 'Iniciar' },
]
const SUBTASK_TABS: { id: MidTab; label: string }[] = [
  { id: 'delivery', label: 'Entrega' },
  { id: 'activity', label: 'Atividade' },
  ...LEADER_TABS,
]

/** Meio: terminal do Lider, ou a subtarefa aberta com abas Entrega, Atividade e Lider. */
export function MiddlePane() {
  const store = useStore()
  const taskId = useAppState((s) => s.selectedTaskId)
  const subtaskId = useAppState((s) => s.selectedSubtaskId)
  const storeTab = useAppState((s) => s.midTab)
  const brainOpen = useAppState((s) => s.brainOpen)
  const wallOpen = useAppState((s) => s.wallOpen)
  // Cerebro e Parede ocupam o meio inteiro; o terminal do Lider segue montado, escondido.
  const full = brainOpen || wallOpen
  const fullTitle = wallOpen ? 'Parede' : 'Cérebro'
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

  // Em espera nao abre o Lider so por estar selecionada: o usuario clica em Retomar.
  const [resumedId, setResumedId] = useState<string | null>(null)
  if (resumedId && task?.workflowStatus !== 'em_espera') setResumedId(null)
  const closeBrain = (
    <button
      type="button"
      className="ghost sp"
      onClick={() => (wallOpen ? store.setWallOpen(false) : store.setBrainOpen(false))}
    >
      Fechar
    </button>
  )

  if (!task) {
    return (
      <section className="col" aria-label="Centro">
        <div className="colhead">
          {full ? fullTitle : 'Líder'}
          {full && closeBrain}
        </div>
        {full ? (
          <div className="mid">{wallOpen ? <WallView /> : <BrainView full />}</div>
        ) : (
          <div className="empty">Escolha uma tarefa na lista ou crie uma nova.</div>
        )}
      </section>
    )
  }

  // Terminal não tem Líder: qualquer aba que não seja Iniciar mostra o shell.
  const terminalOnly = !subtask && isTerminalTask(task)
  const tab = terminalOnly && storeTab !== 'start' ? 'terminal' : storeTab
  const procTab = tab === 'start' || tab === 'terminal'
  const showLeader = subtask ? tab === 'leader' : !procTab
  const tabs = subtask ? SUBTASK_TABS : terminalOnly ? TERMINAL_TABS : LEADER_TABS
  const midTitle = procTab ? (tab === 'start' ? 'Iniciar' : 'Terminal') : null
  const leaderTitle = task.kind === 'team' ? 'Líder · terminal' : 'Terminal'

  return (
    <section className="col" aria-label="Centro">
      <div className="colhead">
        <span className="mid-title">
          {!full && !subtask && (
            <span className="mid-prompt" aria-hidden="true">
              ›_
            </span>
          )}
          {full ? fullTitle : (midTitle ?? (subtask ? subtask.title : leaderTitle))}
        </span>
        {full && closeBrain}
        {!full && !subtask && (
          <span className="mid-status" data-testid="mid-status">
            <TaskStatusMenu
              variant="pill"
              status={task.workflowStatus}
              taskTitle={task.name}
              onChange={(status) => void store.setTaskStatus(task.id, status)}
            />
          </span>
        )}
        {!full && !subtask && <span className="mid-task">{task.name}</span>}
        {!full && (
          <span className="sp tabs" role="tablist" aria-label="Visão do meio">
            {tabs.map((t) => (
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
        {wallOpen && <WallView />}
        {!terminalOnly && (
          <div className="mid-layer" hidden={full || !showLeader}>
            {task.status === 'archived' ? (
              <div className="empty" data-testid="task-launched">
                Tarefa {task.workflowStatus === 'cancelado' ? 'cancelada' : 'concluída'} e
                arquivada. Os agentes foram fechados. Para reabrir, troque o status no ícone da
                tarefa.
              </div>
            ) : task.workflowStatus === 'esperando_outra' ? (
              <TaskWaiting task={task} />
            ) : task.workflowStatus === 'em_espera' && resumedId !== task.id ? (
              <div className="empty" data-testid="task-standby">
                <p>Tarefa em espera. Os agentes estão fechados.</p>
                <button type="button" onClick={() => setResumedId(task.id)}>
                  Retomar
                </button>
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
        )}
        {!full && procTab && (
          <div className="mid-layer">
            {task.status === 'archived' ? (
              <div className="empty">Tarefa arquivada: os processos foram parados.</div>
            ) : tab === 'start' ? (
              <StartTab key={task.id} task={task} />
            ) : (
              <ShellTab key={task.id} task={task} />
            )}
          </div>
        )}
        {!full && subtask && tab === 'delivery' && (
          <DeliveryView subtask={subtask} detail={detail} />
        )}
        {!full && subtask && tab === 'activity' && (
          <ActivityView events={activity} working={subtask.state === 'working'} />
        )}
      </div>
    </section>
  )
}
