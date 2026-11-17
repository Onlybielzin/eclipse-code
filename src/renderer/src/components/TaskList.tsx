import { useMemo, useRef, useState } from 'react'
import {
  isArchivedWorkflowStatus,
  isTerminalTask,
  PROVIDER_LABELS,
  type Task,
  type TaskWorkflowStatus,
} from '@shared/domain'
import { formatShortElapsed, splitTasks, STATE_ICON_CLASS } from '../store/format'
import { useNow } from '../store/useNow'
import { EMPTY_TASK_FILTERS, filterTasks, normalizeTaskFilters } from '../store/taskFilters'
import { useAppState, useStore } from '../store/context'
import { NewTaskModal } from './NewTaskModal'
import { SidePanels } from './SidePanels'
import { TaskStatusMenu } from './TaskStatusMenu'
import {
  TaskFilterButton,
  TaskFilterChips,
  TaskQuickFilters,
  TaskSearch,
  useTaskFilters,
} from './TaskFilters'

/**
 * Coluna esquerda: lista unica de tarefas abertas (mais recentes primeiro) e, no fim, o
 * bloco recolhido "Encerradas" (Concluída e Cancelada). A lista rola sozinha; os paineis
 * Status e Time ficam no rodape (SidePanels).
 */
export function TaskList() {
  const store = useStore()
  const tasks = useAppState((s) => s.tasks)
  const subtasks = useAppState((s) => s.subtasks)
  const expanded = useAppState((s) => s.expanded)
  const roles = useAppState((s) => s.roles)
  const selectedTaskId = useAppState((s) => s.selectedTaskId)
  const selectedSubtaskId = useAppState((s) => s.selectedSubtaskId)
  const projectId = useAppState((s) => s.projectId)
  const [creating, setCreating] = useState(false)
  const addButton = useRef<HTMLButtonElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [archivedCollapsed, setArchivedCollapsed] = useState(true)
  const [filters, setFilters] = useTaskFilters(projectId)
  const [query, setQuery] = useState('')
  // Tarefas em que o usuario abriu as subtarefas encerradas pela linha "N encerradas".
  const [doneOpen, setDoneOpen] = useState<Record<string, boolean>>({})
  // Clique direito numa tarefa abre o menu de status no ponto do clique.
  const [statusMenuAt, setStatusMenuAt] = useState<{
    taskId: string
    x: number
    y: number
    nonce: number
  } | null>(null)
  // Busca nao e salva: troca de projeto comeca sem texto.
  const [queryProject, setQueryProject] = useState(projectId)
  if (queryProject !== projectId) {
    setQueryProject(projectId)
    setQuery('')
  }
  // Filtro so esconde linhas: nao mexe na selecao do store (F2).
  const visibleTasks = useMemo(
    () => filterTasks(tasks, filters, query, subtasks),
    [tasks, filters, query, subtasks],
  )
  const { open: openTasks, archived } = useMemo(() => splitTasks(visibleTasks), [visibleTasks])
  const clearFilters = () => {
    setFilters(EMPTY_TASK_FILTERS)
    setQuery('')
  }
  /** Painel Status: filtra a lista so por esse status; Concluída e Cancelada abrem o bloco. */
  const filterByStatus = (status: TaskWorkflowStatus) => {
    setFilters(normalizeTaskFilters({ ...filters, statuses: [status] }))
    if (isArchivedWorkflowStatus(status)) setArchivedCollapsed(false)
    scrollRef.current?.scrollTo?.({ top: 0 })
  }
  // Sem tarefa aberta visivel, o bloco abre sozinho (a lista nao parece vazia); o estado salvo fica.
  const archivedShown = !archivedCollapsed || (openTasks.length === 0 && archived.length > 0)

  const leadMeta = (task: Task): string => {
    const role = task.leadRoleId ? roles[task.leadRoleId] : undefined
    if (isTerminalTask(task)) return 'terminal'
    if (task.kind === 'solo') {
      const agent = role?.model ?? (task.soloProvider ? PROVIDER_LABELS[task.soloProvider] : '')
      return agent ? `avulso · ${agent}` : 'avulso'
    }
    return role ? `Líder${role.model ? ` · ${role.model}` : ''}` : 'Líder'
  }

  const renderTask = (task: Task) => {
    const subs = subtasks[task.id] ?? []
    // Encerradas (pronta, bloqueada, cancelada) ficam recolhidas numa linha,
    // a menos que o filtro mande mostrar, o usuario abra ou uma esteja aberta.
    const done = subs.filter((x) => isDoneSubtask(x.state))
    const showAllDone = filters.showDoneSubtasks || doneOpen[task.id] === true
    const shown = showAllDone
      ? subs
      : subs.filter((x) => !isDoneSubtask(x.state) || x.id === selectedSubtaskId)
    const hiddenDone = subs.length - shown.length
    const open = expanded[task.id] === true
    const isSel = selectedTaskId === task.id && selectedSubtaskId === null
    return (
      <div key={task.id}>
        <div
          className={`row ${isSel ? 'sel' : ''}`}
          data-testid={`task-${task.id}`}
          role="treeitem"
          aria-selected={isSel}
          aria-expanded={subs.length > 0 ? open : undefined}
          tabIndex={0}
          onClick={() => store.selectTask(task.id)}
          onContextMenu={(e) => {
            e.preventDefault()
            setStatusMenuAt({
              taskId: task.id,
              x: e.clientX,
              y: e.clientY,
              nonce: Date.now(),
            })
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              store.selectTask(task.id)
            }
          }}
        >
          <span
            className="chev"
            aria-label={subs.length > 0 ? (open ? 'recolher' : 'expandir') : undefined}
            onClick={(e) => {
              if (subs.length === 0) return
              e.stopPropagation()
              store.toggleExpanded(task.id)
            }}
          >
            {subs.length > 0 ? (open ? '⌄' : '›') : ''}
          </span>
          <TaskStatusMenu
            status={task.workflowStatus}
            taskTitle={task.name}
            onChange={(status) => void store.setTaskStatus(task.id, status)}
            openAt={statusMenuAt?.taskId === task.id ? statusMenuAt : null}
          />
          <span className="t" title={task.title}>
            {task.name}
          </span>
          <span className="m" title={leadMeta(task)}>
            <ShortAgo at={task.updatedAt} />
          </span>
        </div>
        {open &&
          shown.map((sub) => {
            const subSel = selectedSubtaskId === sub.id
            const role = roles[sub.roleId]
            return (
              <div
                key={sub.id}
                className={`row child ${subSel ? 'sel' : ''}`}
                role="treeitem"
                aria-selected={subSel}
                tabIndex={0}
                onClick={() => void store.selectSubtask(sub.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    void store.selectSubtask(sub.id)
                  }
                }}
              >
                <i className={`ic ${STATE_ICON_CLASS[sub.state]}`} />
                <span className="t">
                  {role ? `${role.name} · ` : ''}
                  {sub.title}
                </span>
              </div>
            )
          })}
        {open && hiddenDone > 0 && (
          <button
            type="button"
            className="row child done-toggle"
            onClick={() => setDoneOpen((d) => ({ ...d, [task.id]: !d[task.id] }))}
          >
            <span className="done-ic" aria-hidden="true">
              ✓
            </span>
            <span className="t">
              {hiddenDone} encerrada{hiddenDone === 1 ? '' : 's'}
            </span>
          </button>
        )}
        {open && !filters.showDoneSubtasks && doneOpen[task.id] && done.length > 0 && (
          <button
            type="button"
            className="row child done-toggle"
            onClick={() => setDoneOpen((d) => ({ ...d, [task.id]: false }))}
          >
            <span className="t">esconder encerradas</span>
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="col col-left">
      <section className="col-tasks" aria-label="Tarefas">
        <div className="colhead">
          Tarefas
          <span className="colhead-n">{tasks.length}</span>
          <button
            type="button"
            ref={addButton}
            className="primary add-task"
            disabled={projectId === null}
            onClick={() => setCreating(true)}
            aria-haspopup="dialog"
          >
            + tarefa
          </button>
        </div>
        {creating && (
          <NewTaskModal
            onClose={() => {
              setCreating(false)
              addButton.current?.focus()
            }}
          />
        )}
        {projectId !== null && (
          <TaskSearch value={query} onChange={setQuery}>
            <TaskFilterButton filters={filters} onChange={setFilters} />
          </TaskSearch>
        )}
        {projectId !== null && <TaskQuickFilters filters={filters} onChange={setFilters} />}
        <TaskFilterChips filters={filters} onChange={setFilters} />
        <div ref={scrollRef} className="scroll" role="tree" aria-label="Lista de tarefas">
          {tasks.length === 0 && !creating && (
            <p className="empty">Nenhuma tarefa aberta. Use "+ tarefa" para criar a primeira.</p>
          )}
          {tasks.length > 0 && visibleTasks.length === 0 && (
            <div className="empty filter-empty" data-testid="filter-empty">
              <p>Nenhuma tarefa com esses filtros.</p>
              <button type="button" className="linkish" onClick={clearFilters}>
                Limpar filtros
              </button>
            </div>
          )}
          {openTasks.map(renderTask)}
          {archived.length > 0 && (
            <div role="group" aria-label="Encerradas">
              <button
                type="button"
                className="grp"
                aria-expanded={archivedShown}
                data-testid="group-encerradas"
                onClick={() => setArchivedCollapsed((c) => !c)}
              >
                <span className="grp-chev" aria-hidden="true">
                  {archivedShown ? '⌄' : '›'}
                </span>
                <span className="grp-label">Encerradas</span>
                <span className="grp-count" aria-label={`${archived.length} tarefas`}>
                  {archived.length}
                </span>
              </button>
              {archivedShown && archived.map(renderTask)}
            </div>
          )}
        </div>
      </section>
      <SidePanels onPickStatus={filterByStatus} />
    </div>
  )
}

/** Tempo da linha: o relogio de 30 s redesenha so este trecho, nao a lista toda. */
function ShortAgo({ at }: { at: number }) {
  return <>{formatShortElapsed(at, useNow())}</>
}

function isDoneSubtask(state: string): boolean {
  return state === 'completed' || state === 'failed' || state === 'canceled'
}
