import { useMemo, useState, type FormEvent } from 'react'
import {
  PROVIDER_LABELS,
  PROVIDERS,
  type Provider,
  type Task,
  type TaskWorkflowStatus,
} from '@shared/domain'
import { groupTasks, STATE_ICON_CLASS } from '../store/format'
import { useAppState, useStore } from '../store/context'
import { TaskStatusMenu } from './TaskStatusMenu'

/** Grupos recolhidos ao abrir a tela. */
const COLLAPSED_BY_DEFAULT: Partial<Record<TaskWorkflowStatus, boolean>> = { lancado: true }

/**
 * Coluna esquerda: tarefas agrupadas por status (ordem de TASK_WORKFLOW_STATUSES), com
 * subtarefas embaixo. Avulsos entram no grupo do seu status.
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
  const groups = useMemo(() => groupTasks(tasks), [tasks])

  const leadMeta = (task: Task): string => {
    const role = task.leadRoleId ? roles[task.leadRoleId] : undefined
    if (task.kind === 'solo') {
      const agent = role?.model ?? (task.soloProvider ? PROVIDER_LABELS[task.soloProvider] : '')
      return agent ? `avulso · ${agent}` : 'avulso'
    }
    return role ? `Líder${role.model ? ` · ${role.model}` : ''}` : 'Líder'
  }

  return (
    <section className="col" aria-label="Tarefas">
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
      </div>
      {creating && <NewTaskForm onDone={() => setCreating(false)} />}
      <div className="scroll" role="tree" aria-label="Lista de tarefas">
        {groups.length === 0 && !creating && (
          <p className="empty">Nenhuma tarefa aberta. Use "+ nova" para criar a primeira.</p>
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
                        />
                        <span className="t">{task.title}</span>
                        <span className="m">{leadMeta(task)}</span>
                      </div>
                      {open &&
                        subs.map((sub) => {
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
                    </div>
                  )
                })}
            </div>
          )
        })}
      </div>
    </section>
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
