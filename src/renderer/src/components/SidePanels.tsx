import { useId, useMemo, useState, type ReactNode } from 'react'
import {
  PROVIDER_LABELS,
  TASK_WORKFLOW_STATUS_LABELS,
  TASK_WORKFLOW_STATUSES,
  type TaskWorkflowStatus,
} from '@shared/domain'
import { countTasksByStatus, sortTeamRoles } from '../store/format'
import { useAppState } from '../store/context'
import { TaskStatusIcon } from './TaskStatusMenu'

/** Secoes do rodape da coluna esquerda. Estado recolhido salvo por secao. */
export type SidePanelId = 'status' | 'team'

const PANELS_KEY = 'eclipse.sidePanels.collapsed'

function readCollapsed(): Partial<Record<SidePanelId, boolean>> {
  try {
    const raw = globalThis.localStorage?.getItem(PANELS_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    if (typeof parsed !== 'object' || parsed === null) return {}
    const out: Partial<Record<SidePanelId, boolean>> = {}
    for (const id of ['status', 'team'] as const) {
      const v = (parsed as Record<string, unknown>)[id]
      if (typeof v === 'boolean') out[id] = v
    }
    return out
  } catch {
    return {}
  }
}

function saveCollapsed(state: Partial<Record<SidePanelId, boolean>>): void {
  try {
    globalThis.localStorage?.setItem(PANELS_KEY, JSON.stringify(state))
  } catch {
    // armazenamento indisponivel: so perde a lembranca de recolhido/expandido
  }
}

/** Secao recolhivel no estilo Outline/Timeline do VS Code: cabecalho pequeno e corpo compacto. */
function SidePanel({
  id,
  title,
  count,
  countLabel,
  collapsed,
  onToggle,
  children,
}: {
  id: SidePanelId
  title: string
  count: number
  countLabel: string
  collapsed: boolean
  onToggle: () => void
  children: ReactNode
}) {
  const bodyId = useId()
  return (
    <section className="side-panel" aria-label={title} data-testid={`panel-${id}`}>
      <button
        type="button"
        className="side-head"
        aria-expanded={!collapsed}
        aria-controls={bodyId}
        onClick={onToggle}
      >
        <span className="side-chev" aria-hidden="true">
          {collapsed ? '›' : '⌄'}
        </span>
        <span className="side-title">{title}</span>
        <span className="side-count" aria-label={countLabel} data-testid={`panel-${id}-count`}>
          {count}
        </span>
      </button>
      {!collapsed && (
        <div className="side-body" id={bodyId}>
          {children}
        </div>
      )}
    </section>
  )
}

/**
 * Rodape da coluna esquerda: "Status" (contagem dos 6 status) e "Time" (papeis do projeto).
 * So leitura; clicar num status pede a lista para mostrar o grupo.
 */
export function SidePanels({
  onPickStatus,
}: {
  onPickStatus: (status: TaskWorkflowStatus) => void
}) {
  const tasks = useAppState((s) => s.tasks)
  const roles = useAppState((s) => s.roles)
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const counts = useMemo(() => countTasksByStatus(tasks), [tasks])
  const openTotal = useMemo(() => tasks.filter((t) => t.status === 'open').length, [tasks])
  const team = useMemo(() => sortTeamRoles(Object.values(roles)), [roles])

  const toggle = (id: SidePanelId) =>
    setCollapsed((c) => {
      const next = { ...c, [id]: !c[id] }
      saveCollapsed(next)
      return next
    })

  return (
    <div className="side-panels">
      <SidePanel
        id="status"
        title="Status"
        count={openTotal}
        countLabel={`${openTotal} tarefas abertas`}
        collapsed={collapsed.status === true}
        onToggle={() => toggle('status')}
      >
        <ul className="side-list" aria-label="Tarefas por status">
          {TASK_WORKFLOW_STATUSES.map((status) => (
            <li key={status}>
              <button
                type="button"
                className="side-row"
                data-testid={`status-row-${status}`}
                disabled={counts[status] === 0}
                onClick={() => onPickStatus(status)}
              >
                <TaskStatusIcon status={status} />
                <span className="side-name">{TASK_WORKFLOW_STATUS_LABELS[status]}</span>
                <span className="side-num">{counts[status]}</span>
              </button>
            </li>
          ))}
        </ul>
      </SidePanel>
      <SidePanel
        id="team"
        title="Time"
        count={team.length}
        countLabel={`${team.length} agentes`}
        collapsed={collapsed.team === true}
        onToggle={() => toggle('team')}
      >
        {team.length === 0 ? (
          <p className="side-empty">Nenhum agente neste projeto.</p>
        ) : (
          <ul className="side-list" aria-label="Agentes do projeto">
            {team.map((role) => (
              <li
                key={role.id}
                className="side-row static"
                data-testid={`team-row-${role.id}`}
                title={role.description || undefined}
              >
                <span className="side-name">{role.name}</span>
                {role.isLead && <span className="side-tag">Líder</span>}
                <span className="side-meta">
                  {PROVIDER_LABELS[role.provider]}
                  {role.model ? ` · ${role.model}` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </SidePanel>
    </div>
  )
}
