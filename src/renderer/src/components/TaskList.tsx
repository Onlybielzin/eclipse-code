import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import {
  PROVIDER_LABELS,
  PROVIDERS,
  type Provider,
  type Task,
  type TaskWorkflowStatus,
} from '@shared/domain'
import { groupTasks, STATE_ICON_CLASS } from '../store/format'
import { EMPTY_TASK_FILTERS, filterTasks, includeStatus } from '../store/taskFilters'
import { useAppState, useStore } from '../store/context'
import { SidePanels } from './SidePanels'
import { TaskStatusMenu } from './TaskStatusMenu'
import { TaskFilterButton, TaskFilterChips, TaskSearch, useTaskFilters } from './TaskFilters'

/** Grupos recolhidos ao abrir a tela. */
const COLLAPSED_BY_DEFAULT: Partial<Record<TaskWorkflowStatus, boolean>> = { lancado: true }

/**
 * Coluna esquerda: tarefas agrupadas por status (ordem de TASK_WORKFLOW_STATUSES), com
 * subtarefas embaixo. Avulsos entram no grupo do seu status. A lista ocupa o espaco de
 * cima e rola sozinha; os paineis Status e Time ficam no rodape (SidePanels).
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
  const [collapsed, setCollapsed] =
    useState<Partial<Record<TaskWorkflowStatus, boolean>>>(COLLAPSED_BY_DEFAULT)
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
  const groups = useMemo(() => groupTasks(visibleTasks), [visibleTasks])
  const clearFilters = () => {
    setFilters(EMPTY_TASK_FILTERS)
    setQuery('')
  }
  const scrollRef = useRef<HTMLDivElement>(null)
  // Pedido do painel Status: expande o grupo e, depois de renderizar, rola e foca.
  const [focusRequest, setFocusRequest] = useState<{ status: TaskWorkflowStatus } | null>(null)

  useEffect(() => {
    if (!focusRequest) return
    const header = scrollRef.current?.querySelector<HTMLElement>(
      `[data-testid="group-${focusRequest.status}"]`,
    )
    header?.scrollIntoView?.({ block: 'start', behavior: 'smooth' })
    header?.focus()
    setFocusRequest(null)
  }, [focusRequest])

  /** Painel Status: se o filtro esconde o status, inclui antes de rolar ate o grupo. */
  const showGroup = (status: TaskWorkflowStatus) => {
    const next = includeStatus(filters, status)
    if (next !== filters) setFilters(next)
    setCollapsed((c) => (c[status] ? { ...c, [status]: false } : c))
    setFocusRequest({ status })
  }

  const leadMeta = (task: Task): string => {
    const role = task.leadRoleId ? roles[task.leadRoleId] : undefined
    if (task.kind === 'solo') {
      const agent = role?.model ?? (task.soloProvider ? PROVIDER_LABELS[task.soloProvider] : '')
      return agent ? `avulso · ${agent}` : 'avulso'
    }
    return role ? `Líder${role.model ? ` · ${role.model}` : ''}` : 'Líder'
  }

  return (
    <div className="col col-left">
      <section className="col-tasks" aria-label="Tarefas">
        <div className="colhead">
          Tarefas
          <button
            type="button"
            className="sp linkish"
            disabled={projectId === null}
            onClick={() => setCreating((v) => !v)}
            aria-expanded={creating}
          >
            + nova
          </button>
          {projectId !== null && <TaskFilterButton filters={filters} onChange={setFilters} />}
        </div>
        {creating && <NewTaskForm onDone={() => setCreating(false)} />}
        {projectId !== null && <TaskSearch value={query} onChange={setQuery} />}
        <TaskFilterChips filters={filters} onChange={setFilters} />
        <div className="scroll" role="tree" aria-label="Lista de tarefas" ref={scrollRef}>
          {tasks.length === 0 && !creating && (
            <p className="empty">Nenhuma tarefa aberta. Use "+ nova" para criar a primeira.</p>
          )}
          {tasks.length > 0 && groups.length === 0 && (
            <div className="empty filter-empty" data-testid="filter-empty">
              <p>Nenhuma tarefa com esses filtros.</p>
              <button type="button" className="linkish" onClick={clearFilters}>
                Limpar filtros
              </button>
            </div>
          )}
          {groups.map((group) => {
            const isCollapsed = collapsed[group.status] === true
            return (
              <div key={group.status} role="group" aria-label={group.label}>
                <button
                  type="button"
                  className="grp"
                  aria-expanded={!isCollapsed}
                  data-testid={`group-${group.status}`}
                  onClick={() => setCollapsed((c) => ({ ...c, [group.status]: !isCollapsed }))}
                >
                  <span className="grp-chev" aria-hidden="true">
                    {isCollapsed ? '›' : '⌄'}
                  </span>
                  <span className="grp-label">{group.label}</span>
                  <span className="grp-count" aria-label={`${group.tasks.length} tarefas`}>
                    {group.tasks.length}
                  </span>
                </button>
                {!isCollapsed &&
                  group.tasks.map((task) => {
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
                            aria-label={
                              subs.length > 0 ? (open ? 'recolher' : 'expandir') : undefined
                            }
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
                            taskTitle={task.title}
                            onChange={(status) => void store.setTaskStatus(task.id, status)}
                            openAt={statusMenuAt?.taskId === task.id ? statusMenuAt : null}
                          />
                          <span className="t">{task.title}</span>
                          <span className="m">{leadMeta(task)}</span>
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
                        {open &&
                          !filters.showDoneSubtasks &&
                          doneOpen[task.id] &&
                          done.length > 0 && (
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
                  })}
              </div>
            )
          })}
        </div>
      </section>
      <SidePanels onPickStatus={showGroup} />
    </div>
  )
}

/** Criar tarefa: nome -> worktree. Avulso pode rodar na raiz do projeto. */
export function NewTaskForm({ onDone }: { onDone: () => void }) {
  const store = useStore()
  const [title, setTitle] = useState('')
  const [kind, setKind] = useState<'team' | 'solo'>('team')
  const [provider, setProvider] = useState<Provider>('claude')
  const [useWorktree, setUseWorktree] = useState(true)
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const name = title.trim()
    if (!name) return
    setBusy(true)
    const task = await store.createTask({
      title: name,
      kind,
      useWorktree: kind === 'team' ? true : useWorktree,
      ...(kind === 'solo' ? { soloProvider: provider } : {}),
    })
    setBusy(false)
    if (task) onDone()
  }

  return (
    <form className="newtask" onSubmit={(e) => void submit(e)} aria-label="Nova tarefa">
      <label className="lbl">
        Nome
        <input
          className="field"
          autoFocus
          value={title}
          maxLength={200}
          placeholder="ex: relatório por oferta"
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>
      <div className="seg" role="radiogroup" aria-label="Tipo">
        <label>
          <input type="radio" checked={kind === 'team'} onChange={() => setKind('team')} /> Com
          Líder e time
        </label>
        <label>
          <input type="radio" checked={kind === 'solo'} onChange={() => setKind('solo')} /> Avulso
        </label>
      </div>
      {kind === 'solo' && (
        <>
          <label className="lbl">
            Agente
            <select
              className="field"
              value={provider}
              onChange={(e) => setProvider(e.target.value as Provider)}
            >
              {PROVIDERS.map((p) => (
                <option key={p} value={p}>
                  {PROVIDER_LABELS[p]}
                </option>
              ))}
            </select>
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={useWorktree}
              onChange={(e) => setUseWorktree(e.target.checked)}
            />{' '}
            Criar worktree própria
          </label>
        </>
      )}
      <p className="muted small">
        {kind === 'team' || useWorktree
          ? 'Cria uma worktree e uma branch com esse nome.'
          : 'Roda na pasta raiz do projeto, sem worktree.'}
      </p>
      <div className="answer">
        <button type="submit" className="primary" disabled={busy || !title.trim()}>
          {busy ? 'Criando...' : 'Criar tarefa'}
        </button>
        <button type="button" className="ghost" onClick={onDone}>
          Cancelar
        </button>
      </div>
    </form>
  )
}

function isDoneSubtask(state: string): boolean {
  return state === 'completed' || state === 'failed' || state === 'canceled'
}
