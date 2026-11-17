import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import {
  TASK_KINDS,
  TASK_WORKFLOW_STATUS_LABELS,
  TASK_WORKFLOW_STATUSES,
  type TaskWorkflowStatus,
} from '@shared/domain'
import {
  activePreset,
  activeTaskFilterCount,
  applyPreset,
  clearTaskFilters,
  EMPTY_TASK_FILTERS,
  normalizeTaskFilters,
  readTaskFilters,
  saveTaskFilters,
  TASK_FILTER_PRESETS,
  TASK_SORT_LABELS,
  TASK_SORTS,
  TASK_KIND_FILTER_LABELS,
  taskFilterChips,
  toggleValue,
  type TaskFilterChipKey,
  type TaskFilters,
  removeTaskFilter,
} from '../store/taskFilters'
import { TaskStatusIcon } from './TaskStatusMenu'

/**
 * Filtros do projeto aberto. Troca de projeto le os filtros salvos dele; cada mudanca
 * salva no localStorage (sem localStorage, so vale ate fechar).
 */
export function useTaskFilters(
  projectId: string | null,
): [TaskFilters, (next: TaskFilters) => void] {
  const [slot, setSlot] = useState(() => ({ projectId, filters: readTaskFilters(projectId) }))
  // Ajuste durante o render (sem efeito): evita um quadro com os filtros do projeto anterior.
  let current = slot
  if (slot.projectId !== projectId) {
    current = { projectId, filters: readTaskFilters(projectId) }
    setSlot(current)
  }
  const set = useCallback(
    (next: TaskFilters) => {
      const filters = normalizeTaskFilters(next)
      saveTaskFilters(projectId, filters)
      setSlot({ projectId, filters })
    },
    [projectId],
  )
  return [current.filters, set]
}

function FunnelIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M2 3h12l-4.6 5.6v4.2l-2.8 1.4V8.6L2 3z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** Botao de funil com badge e o popover dos filtros (fecha com Esc e clique fora). */
export function TaskFilterButton({
  filters,
  onChange,
}: {
  filters: TaskFilters
  onChange: (next: TaskFilters) => void
}) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<CSSProperties>({})
  const buttonRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const count = activeTaskFilterCount(filters)
  const preset = activePreset(filters)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (popRef.current?.contains(target) || buttonRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
        buttonRef.current?.focus()
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    const first =
      popRef.current?.querySelector<HTMLElement>('fieldset input:checked') ??
      popRef.current?.querySelector<HTMLElement>('button')
    first?.focus()
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const toggle = () => {
    // position: fixed para nao ser cortado pela coluna.
    const rect = buttonRef.current?.getBoundingClientRect()
    if (rect) setPos({ top: rect.bottom + 4, left: Math.max(8, rect.left) })
    setOpen((v) => !v)
  }

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`filter-btn ${count > 0 ? 'on' : ''}`}
        aria-label={count > 0 ? `Filtros (${count} ativos)` : 'Filtros'}
        title="Filtrar tarefas"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={toggle}
      >
        <FunnelIcon />
        {count > 0 && (
          <span className="filter-badge" data-testid="filter-count">
            {count}
          </span>
        )}
      </button>
      {open && (
        <div
          ref={popRef}
          className="filter-pop"
          role="dialog"
          aria-label="Filtros de tarefas"
          style={pos}
        >
          <fieldset className="filter-sec">
            <legend>Ordenar por</legend>
            {TASK_SORTS.map((k) => (
              <label key={k} className="filter-opt">
                <input
                  type="radio"
                  name="task-sort"
                  checked={filters.sort === k}
                  onChange={() => onChange({ ...filters, sort: k })}
                />
                {TASK_SORT_LABELS[k]}
              </label>
            ))}
          </fieldset>
          <fieldset className="filter-sec">
            <legend>Agrupar</legend>
            {[
              { by: false, label: 'Sem grupos' },
              { by: true, label: 'Por status' },
            ].map((o) => (
              <label key={o.label} className="filter-opt">
                <input
                  type="radio"
                  name="task-group"
                  checked={filters.groupByStatus === o.by}
                  onChange={() => onChange({ ...filters, groupByStatus: o.by })}
                />
                {o.label}
              </label>
            ))}
          </fieldset>
          <div className="filter-presets" role="group" aria-label="Atalhos">
            {TASK_FILTER_PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                className={`filter-preset ${preset === p.id ? 'cur' : ''}`}
                aria-pressed={preset === p.id}
                onClick={() => onChange(applyPreset(filters, p.id))}
              >
                {p.label}
              </button>
            ))}
          </div>
          <fieldset className="filter-sec">
            <legend>Status</legend>
            {TASK_WORKFLOW_STATUSES.map((s) => (
              <label key={s} className="filter-opt">
                <input
                  type="checkbox"
                  checked={filters.statuses.includes(s)}
                  onChange={() =>
                    onChange({ ...filters, statuses: toggleValue(filters.statuses, s) })
                  }
                />
                <TaskStatusIcon status={s} />
                {TASK_WORKFLOW_STATUS_LABELS[s]}
              </label>
            ))}
          </fieldset>
          <fieldset className="filter-sec">
            <legend>Tipo</legend>
            {TASK_KINDS.map((k) => (
              <label key={k} className="filter-opt">
                <input
                  type="checkbox"
                  checked={filters.kinds.includes(k)}
                  onChange={() => onChange({ ...filters, kinds: toggleValue(filters.kinds, k) })}
                />
                {TASK_KIND_FILTER_LABELS[k]}
              </label>
            ))}
          </fieldset>
          <fieldset className="filter-sec">
            <legend>Agente</legend>
            <label className="filter-opt" title="Membro trabalhando ou na fila">
              <input
                type="checkbox"
                checked={filters.runningOnly}
                onChange={() => onChange({ ...filters, runningOnly: !filters.runningOnly })}
              />
              Só com agente rodando
            </label>
          </fieldset>
          <fieldset className="filter-sec">
            <legend>Subtarefas</legend>
            <label className="filter-opt" title="Prontas, bloqueadas e canceladas">
              <input
                type="checkbox"
                checked={filters.showDoneSubtasks}
                onChange={() =>
                  onChange({ ...filters, showDoneSubtasks: !filters.showDoneSubtasks })
                }
              />
              Mostrar as encerradas
            </label>
          </fieldset>
          <div className="filter-foot">
            <button
              type="button"
              className="linkish"
              disabled={count === 0}
              onClick={() => onChange(clearTaskFilters(filters))}
            >
              Limpar filtros
            </button>
          </div>
        </div>
      )}
    </>
  )
}

/** Busca por titulo: filtra enquanto digita; Esc limpa. O funil entra como filho, dentro do campo. */
export function TaskSearch({
  value,
  onChange,
  children,
}: {
  value: string
  onChange: (v: string) => void
  children?: ReactNode
}) {
  return (
    <div className="task-search">
      <div className="task-search-box">
        <svg
          className="task-search-ic"
          width="13"
          height="13"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
        >
          <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.5" />
          <path
            d="M10.5 10.5L14 14"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
        <input
          type="text"
          className="task-search-input"
          aria-label="Buscar tarefa por título"
          placeholder="Buscar tarefa…"
          value={value}
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && value !== '') {
              e.stopPropagation()
              onChange('')
            }
          }}
        />
        {children}
      </div>
    </div>
  )
}

/** Atalhos de status da maquete; reusam os filtros de status (sem logica nova). */
const QUICK_FILTERS: readonly {
  label: string
  dot: string | null
  statuses: TaskWorkflowStatus[]
}[] = [
  {
    label: 'Abertas',
    dot: null,
    statuses: [...(TASK_FILTER_PRESETS.find((p) => p.id === 'open')?.statuses ?? [])],
  },
  { label: 'Pergunta', dot: 'var(--st-pink)', statuses: ['pergunta'] },
  { label: 'Revisão', dot: 'var(--st-violet)', statuses: ['em_revisao'] },
]

/** Chips rapidos abaixo da busca: um clique filtra, outro clique limpa os status. */
export function TaskQuickFilters({
  filters,
  onChange,
}: {
  filters: TaskFilters
  onChange: (next: TaskFilters) => void
}) {
  const key = (statuses: readonly TaskWorkflowStatus[]) =>
    normalizeTaskFilters({ ...EMPTY_TASK_FILTERS, statuses: [...statuses] }).statuses.join()
  return (
    <div className="quick-chips" role="toolbar" aria-label="Filtros rápidos">
      {QUICK_FILTERS.map((q) => {
        const on = key(q.statuses) === key(filters.statuses)
        return (
          <button
            key={q.label}
            type="button"
            className={`quick-chip ${on ? 'on' : ''}`}
            aria-pressed={on}
            onClick={() => onChange({ ...filters, statuses: on ? [] : q.statuses })}
          >
            {q.dot && <i className="quick-dot" style={{ background: q.dot }} />}
            {q.label}
          </button>
        )
      })}
    </div>
  )
}

/** Chips dos filtros ativos (estilo FilterBar do Paperclip); o x remove a categoria. */
export function TaskFilterChips({
  filters,
  onChange,
}: {
  filters: TaskFilters
  onChange: (next: TaskFilters) => void
}) {
  const chips = taskFilterChips(filters)
  if (chips.length === 0) return null
  const remove = (key: TaskFilterChipKey) => onChange(removeTaskFilter(filters, key))
  return (
    <div className="filter-chips" aria-label="Filtros ativos" role="list">
      {chips.map((chip) => (
        <span
          key={chip.key}
          className="filter-chip"
          role="listitem"
          data-testid={`chip-${chip.key}`}
        >
          <span className="filter-chip-label">{chip.label}</span>
          <button
            type="button"
            className="filter-chip-x"
            aria-label={`Remover filtro ${chip.label}`}
            onClick={() => remove(chip.key)}
          >
            ×
          </button>
        </span>
      ))}
    </div>
  )
}
