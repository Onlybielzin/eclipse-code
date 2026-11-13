import type { Subtask, SubtaskState, Task, UserQuestion } from '@shared/domain'

/** Classe CSS do icone de estado (mesmas da maquete). */
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
  label: string
  tasks: Task[]
}

/** Tarefas de time em "Em andamento"; avulsas em "Avulsos". Mais recentes primeiro. */
export function groupTasks(tasks: readonly Task[]): TaskGroup[] {
  const open = tasks.filter((t) => t.status === 'open')
  const byRecent = (a: Task, b: Task) => b.createdAt - a.createdAt
  const team = open.filter((t) => t.kind === 'team').sort(byRecent)
  const solo = open.filter((t) => t.kind === 'solo').sort(byRecent)
  const groups: TaskGroup[] = []
  if (team.length > 0) groups.push({ label: 'Em andamento', tasks: team })
  if (solo.length > 0) groups.push({ label: 'Avulsos', tasks: solo })
  return groups
}

/** Substitui por id, ou acrescenta no fim. */
export function upsertById<T extends { id: string }>(list: readonly T[], item: T): T[] {
  const idx = list.findIndex((x) => x.id === item.id)
  if (idx === -1) return [...list, item]
  const next = list.slice()
  next[idx] = item
  return next
}
