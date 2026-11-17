import {
  isArchivedWorkflowStatus,
  SUBTASK_STATE_LABELS,
  TASK_WORKFLOW_STATUSES,
  type Role,
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
  cancelado: 'ts-canceled',
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

/**
 * Ordem plana da lista lateral: abertas numa lista so e as arquivadas (Concluída e
 * Cancelada) a parte, para o bloco "Encerradas". Em cada uma, mais recentes primeiro.
 */
export function splitTasks(tasks: readonly Task[]): { open: Task[]; archived: Task[] } {
  const byRecent = (a: Task, b: Task) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt
  const sorted = [...tasks].sort(byRecent)
  return {
    open: sorted.filter((t) => !isArchivedWorkflowStatus(t.workflowStatus)),
    archived: sorted.filter((t) => isArchivedWorkflowStatus(t.workflowStatus)),
  }
}

/** Numero de tarefas por status, sempre com os 6 status (0 quando vazio). */
export function countTasksByStatus(tasks: readonly Task[]): Record<TaskWorkflowStatus, number> {
  const counts = Object.fromEntries(TASK_WORKFLOW_STATUSES.map((s) => [s, 0])) as Record<
    TaskWorkflowStatus,
    number
  >
  for (const t of tasks) counts[t.workflowStatus] += 1
  return counts
}

/** Time do projeto: o Lider primeiro, depois os membros em ordem alfabetica. */
export function sortTeamRoles(roles: readonly Role[]): Role[] {
  return [...roles].sort(
    (a, b) =>
      Number(b.isLead) - Number(a.isLead) ||
      a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base' }),
  )
}

/** Substitui por id, ou acrescenta no fim. */
export function upsertById<T extends { id: string }>(list: readonly T[], item: T): T[] {
  const idx = list.findIndex((x) => x.id === item.id)
  if (idx === -1) return [...list, item]
  const next = list.slice()
  next[idx] = item
  return next
}

/**
 * Rotulo do estado na linha. Em dúvida, a statusMessage diz o motivo (ex: "parada: o app
 * reiniciou", que espera o Lider); nos outros estados fica o rotulo do estado.
 */
export function subtaskRowLabel(sub: Subtask): string {
  if (sub.state === 'input_required' && sub.statusMessage?.trim()) return sub.statusMessage.trim()
  return SUBTASK_STATE_LABELS[sub.state]
}

/** Tempo curto da linha de tarefa: "agora", "3m", "1h", "2d". */
export function formatShortElapsed(fromMs: number, toMs: number): string {
  const min = Math.max(0, Math.floor((toMs - fromMs) / 60_000))
  if (min < 1) return 'agora'
  if (min < 60) return `${min}m`
  if (min < 1440) return `${Math.floor(min / 60)}h`
  return `${Math.floor(min / 1440)}d`
}

/** Ordem e rotulos (singular, plural) da linha de resumo das subtarefas. */
const SUMMARY_PARTS: readonly [SubtaskState, string, string][] = [
  ['completed', 'pronta', 'prontas'],
  ['working', 'trabalhando', 'trabalhando'],
  ['input_required', 'dúvida', 'dúvidas'],
  ['submitted', 'na fila', 'na fila'],
  ['failed', 'bloqueada', 'bloqueadas'],
  ['canceled', 'cancelada', 'canceladas'],
]

/** "3 prontas · 1 trabalhando · 1 dúvida · 62 min": contagem por estado e tempo somado. */
export function subtaskSummary(subtasks: readonly Subtask[], nowMs: number): string {
  const parts = SUMMARY_PARTS.flatMap(([state, one, many]) => {
    const n = subtasks.filter((s) => s.state === state).length
    return n > 0 ? [`${n} ${n === 1 ? one : many}`] : []
  })
  const total = subtasks.reduce((sum, s) => sum + ((s.finishedAt ?? nowMs) - s.createdAt), 0)
  return [...parts, formatElapsed(0, total)].join(' · ')
}
