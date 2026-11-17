/**
 * Filtros da lista de tarefas (estilo Paperclip: popover + chips). Funcoes puras; o estado
 * e so da tela (nao e dominio) e fica salvo por projeto no localStorage.
 *
 * Invariantes:
 *   F1. Lista vazia numa categoria = sem filtro nessa categoria. Marcar todos os valores
 *       equivale a nao marcar nenhum (normalizeTaskFilters reduz para []).
 *   F2. Filtro nunca muda dominio nem selecao: so decide quais linhas aparecem.
 *   F3. Cada categoria ativa vira exatamente um chip; o badge do botao conta os chips.
 *
 * "Agente rodando": a tela so tem sinal confiavel das subtarefas (state 'working' ou
 * 'submitted'). O turno do Lider nao chega ao store da tela, entao nao entra no filtro.
 */
import {
  TASK_KINDS,
  isArchivedWorkflowStatus,
  TASK_WORKFLOW_STATUS_LABELS,
  TASK_WORKFLOW_STATUSES,
  type Subtask,
  type Task,
  type TaskKind,
  type TaskWorkflowStatus,
} from '@shared/domain'

export const TASK_SORTS = ['updated', 'created', 'name', 'status'] as const
export type TaskSort = (typeof TASK_SORTS)[number]

export const TASK_SORT_LABELS: Record<TaskSort, string> = {
  updated: 'Atualizada',
  created: 'Criada',
  name: 'Nome',
  status: 'Status',
}

export interface TaskFilters {
  statuses: TaskWorkflowStatus[]
  kinds: TaskKind[]
  runningOnly: boolean
  /** Opcao de visao (nao conta como filtro): mostra as subtarefas encerradas na lista. */
  showDoneSubtasks: boolean
  /** Opcao de visao: ordem da lista. */
  sort: TaskSort
  /** Opcao de visao: separa as abertas em grupos por status. */
  groupByStatus: boolean
}

export const EMPTY_TASK_FILTERS: TaskFilters = {
  statuses: [],
  kinds: [],
  runningOnly: false,
  showDoneSubtasks: false,
  sort: 'updated',
  groupByStatus: false,
}

export const TASK_KIND_FILTER_LABELS: Record<TaskKind, string> = {
  team: 'Equipe',
  solo: 'Avulso',
}

export type TaskFilterPresetId = 'open' | 'needs_me' | 'all'

export const TASK_FILTER_PRESETS: readonly {
  id: TaskFilterPresetId
  label: string
  statuses: readonly TaskWorkflowStatus[]
}[] = [
  {
    id: 'open',
    label: 'Abertas',
    statuses: TASK_WORKFLOW_STATUSES.filter((s) => !isArchivedWorkflowStatus(s)),
  },
  { id: 'needs_me', label: 'Precisam de mim', statuses: ['pergunta', 'em_revisao'] },
  { id: 'all', label: 'Todas', statuses: [] },
]

/** Ordem canonica, sem repetidos, e "todos marcados" vira "nenhum" (F1). */
export function normalizeTaskFilters(filters: TaskFilters): TaskFilters {
  const statuses = TASK_WORKFLOW_STATUSES.filter((s) => filters.statuses.includes(s))
  const kinds = TASK_KINDS.filter((k) => filters.kinds.includes(k))
  return {
    statuses: statuses.length === TASK_WORKFLOW_STATUSES.length ? [] : statuses,
    kinds: kinds.length === TASK_KINDS.length ? [] : kinds,
    runningOnly: filters.runningOnly,
    showDoneSubtasks: filters.showDoneSubtasks === true,
    sort: TASK_SORTS.includes(filters.sort) ? filters.sort : EMPTY_TASK_FILTERS.sort,
    groupByStatus: filters.groupByStatus === true,
  }
}

/** "Limpar filtros": zera os filtros e mantem a ordenacao e o agrupamento. */
export function clearTaskFilters(filters: TaskFilters): TaskFilters {
  return { ...EMPTY_TASK_FILTERS, sort: filters.sort, groupByStatus: filters.groupByStatus }
}

export function toggleValue<T>(list: readonly T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value]
}

/** Preset escolhe so os status; tipo e "rodando" ficam como estavam. */
export function applyPreset(filters: TaskFilters, id: TaskFilterPresetId): TaskFilters {
  const preset = TASK_FILTER_PRESETS.find((p) => p.id === id)
  return normalizeTaskFilters({ ...filters, statuses: [...(preset?.statuses ?? [])] })
}

/** Preset cujos status batem exatamente com o filtro atual (para marcar o botao). */
export function activePreset(filters: TaskFilters): TaskFilterPresetId | null {
  const current = normalizeTaskFilters(filters).statuses
  const match = TASK_FILTER_PRESETS.find(
    (p) =>
      normalizeTaskFilters({ ...EMPTY_TASK_FILTERS, statuses: [...p.statuses] }).statuses.join() ===
      current.join(),
  )
  return match?.id ?? null
}

/** O status aparece com esses filtros de status? */
export function statusVisible(filters: TaskFilters, status: TaskWorkflowStatus): boolean {
  return filters.statuses.length === 0 || filters.statuses.includes(status)
}

/** Algum membro trabalhando ou na fila (subtarefa 'working' ou 'submitted'). */
export function hasRunningAgent(subtasks: readonly Subtask[] | undefined): boolean {
  return (subtasks ?? []).some((s) => s.state === 'working' || s.state === 'submitted')
}

/** Minusculas e sem acento, para a busca por titulo. */
export function foldText(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
}

export function filterTasks(
  tasks: readonly Task[],
  filters: TaskFilters,
  query: string,
  subtasks: Readonly<Record<string, readonly Subtask[]>>,
): Task[] {
  const needle = foldText(query.trim())
  return tasks.filter(
    (t) =>
      statusVisible(filters, t.workflowStatus) &&
      (filters.kinds.length === 0 || filters.kinds.includes(t.kind)) &&
      (!filters.runningOnly || hasRunningAgent(subtasks[t.id])) &&
      (needle === '' || foldText(t.name).includes(needle) || foldText(t.title).includes(needle)),
  )
}

export type TaskFilterChipKey = 'status' | 'kind' | 'running'

export interface TaskFilterChip {
  key: TaskFilterChipKey
  label: string
}

function statusChipLabel(statuses: readonly TaskWorkflowStatus[]): string {
  const preset = activePreset({ ...EMPTY_TASK_FILTERS, statuses: [...statuses] })
  if (preset === 'needs_me') return 'Precisam de mim'
  const hidden = TASK_WORKFLOW_STATUSES.filter((s) => !statuses.includes(s))
  // Mais curto dizer o que some quando quase tudo esta marcado ("Sem Lançado").
  if (hidden.length < statuses.length) {
    return `Sem ${hidden.map((s) => TASK_WORKFLOW_STATUS_LABELS[s]).join(', ')}`
  }
  return statuses.map((s) => TASK_WORKFLOW_STATUS_LABELS[s]).join(', ')
}

/** Um chip por categoria ativa (F3). */
export function taskFilterChips(filters: TaskFilters): TaskFilterChip[] {
  const f = normalizeTaskFilters(filters)
  const chips: TaskFilterChip[] = []
  if (f.statuses.length > 0) chips.push({ key: 'status', label: statusChipLabel(f.statuses) })
  if (f.kinds.length > 0) {
    chips.push({ key: 'kind', label: f.kinds.map((k) => TASK_KIND_FILTER_LABELS[k]).join(', ') })
  }
  if (f.runningOnly) chips.push({ key: 'running', label: 'Agente rodando' })
  return chips
}

export function activeTaskFilterCount(filters: TaskFilters): number {
  return taskFilterChips(filters).length
}

export function removeTaskFilter(filters: TaskFilters, key: TaskFilterChipKey): TaskFilters {
  switch (key) {
    case 'status':
      return { ...filters, statuses: [] }
    case 'kind':
      return { ...filters, kinds: [] }
    case 'running':
      return { ...filters, runningOnly: false }
  }
}

// -- armazenamento por projeto -------------------------------------------------

const STORAGE_PREFIX = 'eclipse.taskFilters.'

export function taskFiltersKey(projectId: string): string {
  return STORAGE_PREFIX + projectId
}

/** Le com validacao; qualquer coisa estranha vira "sem filtro". Nunca lanca. */
export function parseTaskFilters(raw: string | null | undefined): TaskFilters {
  if (!raw) return EMPTY_TASK_FILTERS
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return EMPTY_TASK_FILTERS
    const obj = parsed as Record<string, unknown>
    const strings = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
    return normalizeTaskFilters({
      statuses: strings(obj.statuses).filter((s): s is TaskWorkflowStatus =>
        (TASK_WORKFLOW_STATUSES as readonly string[]).includes(s),
      ),
      kinds: strings(obj.kinds).filter((k): k is TaskKind =>
        (TASK_KINDS as readonly string[]).includes(k),
      ),
      runningOnly: obj.runningOnly === true,
      showDoneSubtasks: obj.showDoneSubtasks === true,
      sort: TASK_SORTS.find((x) => x === obj.sort) ?? EMPTY_TASK_FILTERS.sort,
      groupByStatus: obj.groupByStatus === true,
    })
  } catch {
    return EMPTY_TASK_FILTERS
  }
}

export function readTaskFilters(projectId: string | null): TaskFilters {
  if (projectId === null) return EMPTY_TASK_FILTERS
  try {
    return parseTaskFilters(globalThis.localStorage?.getItem(taskFiltersKey(projectId)))
  } catch {
    return EMPTY_TASK_FILTERS
  }
}

export function saveTaskFilters(projectId: string | null, filters: TaskFilters): void {
  if (projectId === null) return
  try {
    const { sort, groupByStatus } = EMPTY_TASK_FILTERS
    if (
      activeTaskFilterCount(filters) === 0 &&
      filters.sort === sort &&
      filters.groupByStatus === groupByStatus
    ) {
      globalThis.localStorage?.removeItem(taskFiltersKey(projectId))
    } else {
      globalThis.localStorage?.setItem(taskFiltersKey(projectId), JSON.stringify(filters))
    }
  } catch {
    // armazenamento indisponivel: os filtros so valem ate fechar a tela
  }
}
