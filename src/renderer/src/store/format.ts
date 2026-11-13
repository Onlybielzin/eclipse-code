import {
  TASK_WORKFLOW_STATUS_LABELS,
  TASK_WORKFLOW_STATUSES,
  type Subtask,
  type SubtaskState,
  type Task,
  type TaskWorkflowStatus,
  type UserQuestion,
} from '@shared/domain'

/**
 * Classe CSS do icone de status da tarefa. Mesma familia do Paperclip: circulo com borda
 * da cor do status e preenchimento/simbolo por status.
 */
export const TASK_STATUS_ICON_CLASS: Record<TaskWorkflowStatus, string> = {
  a_fazer: 'ts-todo',
  em_andamento: 'ts-progress',
  pergunta: 'ts-question',
  em_revisao: 'ts-review',
  pronto_lancar: 'ts-ready',
  lancado: 'ts-launched',
}

/** Classe CSS do icone de estado da subtarefa (mesma familia visual do status da tarefa). */
export const STATE_ICON_CLASS: Record<SubtaskState, string> = {
  submitted: 'st-submitted',
  working: 'st-working',
  input_required: 'st-input',
  completed: 'st-completed',
  failed: 'st-failed',
  canceled: 'st-canceled',
}

export const STATE_BADGE_CLASS: Record<SubtaskState, string> = {
  submitted: 'b-submitted',
  working: 'b-working',
  input_required: 'b-input',
  completed: 'b-completed',
  failed: 'b-failed',
  canceled: 'b-submitted',
}

/** Tempo decorrido curto em portugues: "agora", "4 min", "1 h 5 min". */
export function formatElapsed(fromMs: number, toMs: number): string {
  const totalMin = Math.max(0, Math.floor((toMs - fromMs) / 60_000))
  if (totalMin < 1) return 'agora'
  if (totalMin < 60) return `${totalMin} min`
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return m === 0 ? `${h} h` : `${h} h ${m} min`
}

/** Tempo da subtarefa: ate terminar, ou ate agora se ainda corre. */
export function subtaskElapsed(subtask: Subtask, nowMs: number): string {
  return formatElapsed(subtask.createdAt, subtask.finishedAt ?? nowMs)
}

export function countCompleted(subtasks: readonly Subtask[]): number {
  return subtasks.filter((s) => s.state === 'completed').length
}

export function openQuestions(questions: readonly UserQuestion[]): UserQuestion[] {
  return questions.filter((q) => q.status === 'open')
}

export interface TaskGroup {
  status: TaskWorkflowStatus
  label: string
  tasks: Task[]
}

/**
 * Agrupa por status de trabalho, na ordem de TASK_WORKFLOW_STATUSES. Grupo vazio some.
 * Time e avulso ficam juntos no grupo do status. Dentro do grupo, mais recentes primeiro.
 */
export function groupTasks(tasks: readonly Task[]): TaskGroup[] {
  const byRecent = (a: Task, b: Task) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt
  return TASK_WORKFLOW_STATUSES.flatMap((status) => {
    const list = tasks.filter((t) => t.workflowStatus === status).sort(byRecent)
    return list.length > 0
      ? [{ status, label: TASK_WORKFLOW_STATUS_LABELS[status], tasks: list }]
      : []
  })
}

/** Substitui por id, ou acrescenta no fim. */
export function upsertById<T extends { id: string }>(list: readonly T[], item: T): T[] {
  const idx = list.findIndex((x) => x.id === item.id)
  if (idx === -1) return [...list, item]
  const next = list.slice()
  next[idx] = item
  return next
}
