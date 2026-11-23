import { useEffect, useRef, useState, type CSSProperties } from 'react'
import {
  TASK_WORKFLOW_STATUS_LABELS,
  TASK_WORKFLOW_STATUSES,
  type TaskWorkflowStatus,
} from '@shared/domain'
import { TASK_STATUS_ICON_CLASS } from '../store/format'

/** Icone do status da tarefa (so desenho). */
export function TaskStatusIcon({ status }: { status: TaskWorkflowStatus }) {
  return <i className={`ic ${TASK_STATUS_ICON_CLASS[status]}`} aria-hidden="true" />
}

/**
 * Icone de status clicavel. Abre um menu com os status que o usuario escolhe (esperando_outra so o app escreve); escolher um pede ao main
 * (tasks.setStatus). A tela nao muda o status sozinha: espera a resposta.
 */
export function TaskStatusMenu({
  status,
  taskTitle,
  onChange,
  variant = 'icon',
  openAt,
}: {
  status: TaskWorkflowStatus
  taskTitle: string
  onChange: (status: TaskWorkflowStatus) => void
  /** 'icon': so o circulo (linha da lista). 'pill': circulo + nome + seta (cabecalho). */
  variant?: 'icon' | 'pill'
  /** Abre o menu nesse ponto (clique direito na linha). nonce novo = abrir de novo. */
  openAt?: { x: number; y: number; nonce: number } | null
}) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<CSSProperties>({})
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const label = TASK_WORKFLOW_STATUS_LABELS[status]

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (menuRef.current?.contains(target) || buttonRef.current?.contains(target)) return
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
    menuRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus()
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  useEffect(() => {
    if (!openAt) return
    setPos({ top: openAt.y, left: openAt.x })
    setOpen(true)
  }, [openAt])

  const toggle = () => {
    // Menu em position: fixed para nao ser cortado pelo scroll da coluna.
    const rect = buttonRef.current?.getBoundingClientRect()
    if (rect) setPos({ top: rect.bottom + 4, left: rect.left })
    setOpen((v) => !v)
  }

  return (
    <span className="status-pick" onClick={(e) => e.stopPropagation()}>
      <button
        ref={buttonRef}
        type="button"
        className={variant === 'pill' ? 'status-btn status-pill' : 'status-btn'}
        title={`${label} · clique para trocar o status`}
        aria-label={`Status de ${taskTitle}: ${label}. Trocar status`}
        aria-haspopup="menu"
        aria-expanded={open}
        data-status={status}
        onClick={toggle}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <TaskStatusIcon status={status} />
        {variant === 'pill' && (
          <>
            <span className="status-pill-label">{label}</span>
            <span className="status-pill-chev" aria-hidden="true">
              ⌄
            </span>
          </>
        )}
      </button>
      {open && (
        <div
          ref={menuRef}
          className="status-menu"
          role="menu"
          aria-label={`Trocar status de ${taskTitle}`}
          style={pos}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
            e.preventDefault()
            const items = [
              ...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ??
                []),
            ]
            const idx = items.findIndex((el) => el === document.activeElement)
            const next = e.key === 'ArrowDown' ? idx + 1 : idx - 1
            items[(next + items.length) % items.length]?.focus()
          }}
        >
          {TASK_WORKFLOW_STATUSES.filter((s) => s !== 'esperando_outra').map((s) => (
            <button
              key={s}
              type="button"
              role="menuitemradio"
              aria-checked={s === status}
              className={`status-opt ${s === status ? 'cur' : ''}`}
              onClick={() => {
                setOpen(false)
                if (s !== status) onChange(s)
              }}
            >
              <TaskStatusIcon status={s} />
              {TASK_WORKFLOW_STATUS_LABELS[s]}
            </button>
          ))}
        </div>
      )}
    </span>
  )
}
