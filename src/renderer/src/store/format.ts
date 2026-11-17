import {
  isArchivedWorkflowStatus,
  SUBTASK_STATE_LABELS,
  TASK_WORKFLOW_STATUSES,
  TASK_WORKFLOW_STATUS_LABELS,
  type Role,
  type Subtask,
  type SubtaskState,
  type Task,
  type TaskWorkflowStatus,
  type UserQuestion,
} from '@shared/domain'
import type { TaskSort } from './taskFilters'

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

/** Ordem dos status abertos na ordenacao "Status" e nos grupos. */
const OPEN_STATUS_ORDER: readonly TaskWorkflowStatus[] = [
  'pergunta',
  'em_andamento',
  'em_revisao',
  'a_fazer',
  'pronto_lancar',
]

/**
 * Ordena pela escolha do usuario. "Pergunta para voce" fica sempre em cima (R1); o resto
 * segue a ordem pedida, com updatedAt e createdAt (mais recentes primeiro) como desempate.
 */
export function sortTasks(tasks: readonly Task[], sort: TaskSort = 'updated'): Task[] {
  const byRecent = (a: Task, b: Task) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt
  // Encerradas (fora da lista) vao para o fim da ordem por status.
  const rank = (t: Task) => {
    const i = OPEN_STATUS_ORDER.indexOf(t.workflowStatus)
    return i === -1 ? OPEN_STATUS_ORDER.length : i
  }
  const by: Record<TaskSort, (a: Task, b: Task) => number> = {
    updated: byRecent,
    created: (a, b) => b.createdAt - a.createdAt,
    name: (a, b) =>
      a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base' }) || b.updatedAt - a.updatedAt,
    status: (a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt,
  }
  const asking = (t: Task) => Number(t.workflowStatus !== 'pergunta')
  return [...tasks].sort((a, b) => asking(a) - asking(b) || by[sort](a, b))
}

/**
 * Ordem plana da lista lateral: abertas numa lista so e as arquivadas (Concluída e
 * Cancelada) a parte, para o bloco "Encerradas". Cada lado segue a ordem escolhida.
 */
export function splitTasks(
  tasks: readonly Task[],
  sort: TaskSort = 'updated',
): { open: Task[]; archived: Task[] } {
  const sorted = sortTasks(tasks, sort)
  return {
    open: sorted.filter((t) => !isArchivedWorkflowStatus(t.workflowStatus)),
    archived: sorted.filter((t) => isArchivedWorkflowStatus(t.workflowStatus)),
  }
}

export interface TaskGroup {
  status: TaskWorkflowStatus
  label: string
  tasks: Task[]
}

/**
 * Grupos por status das tarefas abertas ja ordenadas (splitTasks), na ordem de
 * OPEN_STATUS_ORDER ("Pergunta para você" primeiro). Grupo vazio some.
 */
export function groupOpenTasks(open: readonly Task[]): TaskGroup[] {
  return OPEN_STATUS_ORDER.flatMap((status) => {
    const tasks = open.filter((t) => t.workflowStatus === status)
    return tasks.length > 0 ? [{ status, label: TASK_WORKFLOW_STATUS_LABELS[status], tasks }] : []
  })
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
