import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import type { Project } from '@shared/domain'
import type { ProjectSummary, ProjectsSummary } from '@shared/ipc'
import { matchesProject, shortenPath } from '../store/projectPicker'
import { useAppState, useStore } from '../store/context'
import { ProjectEditModal } from './ProjectEditModal'

function ChevronIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M4 6l4 4 4-4"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M3 8.5l3.2 3L13 4.5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function PencilIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M11 2.5l2.5 2.5L5.5 13H3v-2.5z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** Ctrl+O (Cmd+O no Mac), fora do terminal e sem modal aberto. */
function isOpenShortcut(e: KeyboardEvent): boolean {
  if (e.defaultPrevented || e.shiftKey || e.altKey || !(e.ctrlKey || e.metaKey)) return false
  if (e.key.toLowerCase() !== 'o') return false
  // No terminal do Lider, Ctrl+O e do agente (Claude Code usa para o transcript).
  if (e.target instanceof Element && e.target.closest('.term-host, .xterm')) return false
  return document.querySelector('[aria-modal="true"]') === null
}

/**
 * Seletor de projeto do topo (estilo quick pick): botao com o projeto atual; abre um
 * popover com busca, lista com contadores e "Adicionar projeto". Trocar de projeto usa
 * store.openProject.
 */
export function ProjectPicker({ onAddProject }: { onAddProject: () => void }) {
  const store = useStore()
  const projects = useAppState((s) => s.projects)
  const projectId = useAppState((s) => s.projectId)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [summary, setSummary] = useState<ProjectsSummary | null>(null)
  const [editing, setEditing] = useState<Project | null>(null)
  const [pos, setPos] = useState<CSSProperties>({})
  const buttonRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listId = useId()

  const wallOpen = useAppState((s) => s.wallOpen)
  const current = projects.find((p) => p.id === projectId) ?? null
  // Branch da tarefa aberta; sem tarefa ou sem branch, so o projeto.
  const branch = useAppState((s) => s.tasks.find((t) => t.id === s.selectedTaskId)?.branch ?? null)
  const filtered = useMemo(
    () => projects.filter((p) => matchesProject(p, query)),
    [projects, query],
  )
  const counts = useMemo(() => {
    const map = new Map<string, ProjectSummary>()
    for (const s of summary?.projects ?? []) map.set(s.projectId, s)
    return map
  }, [summary])

  const openPicker = useCallback(() => {
    // position: fixed para nao ser cortado pelo topo.
    const rect = buttonRef.current?.getBoundingClientRect()
    if (rect) setPos({ top: rect.bottom + 4, left: Math.max(8, rect.left) })
    setQuery('')
    setActive(
      Math.max(
        0,
        projects.findIndex((p) => p.id === projectId),
      ),
    )
    setOpen(true)
    inputRef.current?.focus()
  }, [projects, projectId])

  const close = useCallback((refocus: boolean) => {
    setOpen(false)
    if (refocus) buttonRef.current?.focus()
  }, [])

  // Atalho global Ctrl+O.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isOpenShortcut(e)) return
      e.preventDefault()
      openPicker()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openPicker])

  // Contadores frescos a cada abertura (o ultimo valor fica enquanto chega o novo).
  useEffect(() => {
    if (!open) return
    let alive = true
    void store.loadProjectsSummary().then((value) => {
      if (alive && value) setSummary(value)
    })
    return () => {
      alive = false
    }
  }, [open, store])

  // Esc e clique fora fecham; foco inicial na busca (ou no "Adicionar" sem projetos).
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (popRef.current?.contains(target) || buttonRef.current?.contains(target)) return
      close(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      close(true)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    const first = inputRef.current ?? popRef.current?.querySelector<HTMLButtonElement>('button')
    first?.focus()
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, close])

  // Destaque sempre visivel ao navegar com o teclado.
  useEffect(() => {
    if (!open) return
    const el = popRef.current?.querySelector<HTMLElement>('[data-active="true"]')
    el?.scrollIntoView?.({ block: 'nearest' })
  }, [open, active])

  const activeProject = filtered[Math.min(active, filtered.length - 1)]

  const choose = (project: Project) => {
    close(true)
    if (project.id !== projectId) void store.openProject(project.id)
  }

  const onSearchKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    const last = filtered.length - 1
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        if (last >= 0) setActive((i) => (i >= last ? 0 : i + 1))
        return
      case 'ArrowUp':
        e.preventDefault()
        if (last >= 0) setActive((i) => (i <= 0 ? last : i - 1))
        return
      case 'Home':
        e.preventDefault()
        setActive(0)
        return
      case 'End':
        e.preventDefault()
        setActive(Math.max(0, last))
        return
      case 'F2':
        e.preventDefault()
        if (activeProject) edit(activeProject)
        return
      case 'Enter': {
        e.preventDefault()
        const target = filtered[Math.min(active, last)]
        if (target) choose(target)
        return
      }
    }
  }

  const edit = (project: Project) => {
    close(false)
    setEditing(project)
  }

  const add = () => {
    close(false)
    onAddProject()
  }

  const optionId = (id: string) => `${listId}-opt-${id}`
  const homeDir = summary?.homeDir ?? null

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`proj-btn ${open ? 'open' : ''}`}
        aria-label={
          wallOpen
            ? 'Projeto: Todos os projetos'
            : current
              ? `Projeto: ${current.name}`
              : 'Escolher projeto'
        }
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Trocar projeto (Ctrl+O)"
        onClick={() => (open ? close(true) : openPicker())}
      >
        <span className={`proj-btn-name ${current ? '' : 'none'}`}>
          {wallOpen ? 'Todos os projetos' : (current?.name ?? 'Nenhum projeto')}
        </span>
        {current && branch && !wallOpen && (
          <>
            <span className="proj-sep" aria-hidden="true">
              /
            </span>
            <span className="proj-branch" title={branch}>
              {branch}
            </span>
          </>
        )}
        <kbd className="proj-kbd" aria-hidden="true">
          Ctrl O
        </kbd>
        <ChevronIcon />
      </button>
      {open && (
        <div
          ref={popRef}
          className="proj-pop"
          role="dialog"
          aria-label="Trocar projeto"
          style={pos}
        >
          {projects.length === 0 ? (
            <div className="proj-empty">
              <b>Nenhum projeto ainda</b>
              <span>Adicione a pasta de um repositório para criar tarefas.</span>
            </div>
          ) : (
            <>
              <input
                ref={inputRef}
                type="text"
                className="proj-search"
                role="combobox"
                aria-label="Buscar projeto"
                aria-expanded="true"
                aria-controls={listId}
                aria-autocomplete="list"
                aria-activedescendant={activeProject ? optionId(activeProject.id) : undefined}
                placeholder="Buscar projeto…"
                spellCheck={false}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value)
                  setActive(0)
                }}
                onKeyDown={onSearchKey}
              />
              <ul id={listId} className="proj-list" role="listbox" aria-label="Projetos">
                {filtered.map((p, i) => {
                  const isActive = p.id === activeProject?.id
                  const isCurrent = p.id === projectId
                  const c = counts.get(p.id)
                  return (
                    <li
                      key={p.id}
                      id={optionId(p.id)}
                      role="option"
                      aria-selected={isActive}
                      aria-current={isCurrent ? 'true' : undefined}
                      data-active={isActive}
                      data-testid={`project-option-${p.id}`}
                      className={`proj-item ${isActive ? 'active' : ''}`}
                      onMouseMove={() => {
                        if (!isActive) setActive(i)
                      }}
                      // Mantem o foco na busca para o teclado continuar valendo.
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => choose(p)}
                    >
                      <span className="proj-check">{isCurrent && <CheckIcon />}</span>
                      <span className="proj-main">
                        <span className="proj-name">{p.name}</span>
                        <span className="proj-path" title={p.rootPath}>
                          {shortenPath(p.rootPath, homeDir)}
                        </span>
                      </span>
                      {c && (
                        <span className="proj-meta">
                          {c.needsYou > 0 && (
                            <span className="proj-need" data-testid={`project-need-${p.id}`}>
                              {c.needsYou} precisa{c.needsYou === 1 ? '' : 'm'} de você
                            </span>
                          )}
                          <span
                            className="proj-count"
                            data-testid={`project-open-${p.id}`}
                            title={`${c.openTasks} tarefa${c.openTasks === 1 ? '' : 's'} aberta${c.openTasks === 1 ? '' : 's'}`}
                          >
                            {c.openTasks}
                          </span>
                        </span>
                      )}
                      <button
                        type="button"
                        className="proj-edit"
                        // So atalho de mouse: teclado e leitor de tela usam F2 e o botao do rodape.
                        tabIndex={-1}
                        aria-hidden="true"
                        title="Editar projeto"
                        onClick={(e) => {
                          e.stopPropagation()
                          edit(p)
                        }}
                      >
                        <PencilIcon />
                      </button>
                    </li>
                  )
                })}
              </ul>
              {filtered.length === 0 && <p className="proj-none">Nenhum projeto encontrado.</p>}
            </>
          )}
          <div className="proj-foot">
            <button type="button" className="proj-add" onClick={add}>
              + Adicionar projeto
            </button>
            <button
              type="button"
              className="proj-add proj-edit-active"
              disabled={!activeProject}
              onClick={() => activeProject && edit(activeProject)}
            >
              Editar projeto <kbd className="proj-kbd">F2</kbd>
            </button>
          </div>
        </div>
      )}
      {editing && <ProjectEditModal project={editing} onClose={() => setEditing(null)} />}
    </>
  )
}
