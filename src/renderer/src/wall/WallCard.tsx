import { SUBTASK_STATE_LABELS, TASK_WORKFLOW_STATUS_LABELS } from '@shared/domain'
import type { WallTask } from '@shared/wall'
import { TaskStatusIcon } from '../components/TaskStatusMenu'

const fmt = (n: number) => n.toLocaleString('pt-BR')
const STATE_CLASS = { working: 'hot', input_required: 'ask', completed: 'ok' } as Record<string, string>

/** Um cartao da grade: projeto, titulo, status, membros, arquivo, codigo ao vivo e contagem. */
export function WallCard({ task, flash }: { task: WallTask; flash: number }) {
  const asking = task.openQuestions > 0
  return (
    <article
      className={`wall-card ${asking ? 'ask' : ''}`}
      tabIndex={0}
      aria-label={`${task.projectName}: ${task.title}. ${TASK_WORKFLOW_STATUS_LABELS[task.workflowStatus]}.`}
    >
      {flash > 0 && (
        <span key={flash} className="wall-flash" aria-hidden="true">
          <b>Subtarefa pronta</b>
        </span>
      )}
      <div className="wall-card-top">
        <span className="wall-proj">{task.projectName}</span>
        <span className={`wall-chip st-${task.workflowStatus}`}>
          <TaskStatusIcon status={task.workflowStatus} />
          {TASK_WORKFLOW_STATUS_LABELS[task.workflowStatus]}
        </span>
      </div>
      <div className="wall-title">{task.title}</div>
      <div className="wall-members">
        {task.members.map((m) => (
          <div key={m.subtaskId} className="wall-m">
            <span className="wall-m-name">{m.role}</span>
            <span className={`wall-m-state ${STATE_CLASS[m.state] ?? ''}`}>
              {SUBTASK_STATE_LABELS[m.state]}
            </span>
          </div>
        ))}
      </div>
      <div className="wall-file" title={task.lastFile ?? undefined}>
        {task.lastFile ?? 'sem alterações ainda'}
      </div>
      <div className="wall-code" aria-hidden="true">
        {task.lastLines.map((l, i) => (
          <div key={`${i}-${l}`} className={`wall-ln ${l.startsWith('+') ? 'add' : 'del'}`}>
            <span className="wall-mk">{l.slice(0, 1)}</span>
            <span className="wall-ln-t">{l.slice(1) || ' '}</span>
          </div>
        ))}
      </div>
      <div className="wall-foot">
        <span className="a">+{fmt(task.linesAdded)}</span>
        <span className="d">−{fmt(task.linesRemoved)}</span>
      </div>
    </article>
  )
}
