import { useEffect, useState } from 'react'
import type { UserNotice } from '@shared/ipc'
import { useAppState, useStore } from '../store/context'

/** Tempo até o aviso sumir sozinho. */
export const NOTICE_TIMEOUT_MS = 8_000

function NoticeToast({ notice }: { notice: UserNotice }) {
  const store = useStore()
  const [hover, setHover] = useState(false)
  const [focused, setFocused] = useState(false)
  const held = hover || focused
  // O mouse em cima ou o foco dentro seguram; ao soltar, a contagem recomeça.
  useEffect(() => {
    if (held) return
    const timer = setTimeout(() => store.dismissNotice(notice.id), NOTICE_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [held, notice.id, store])

  return (
    <div
      className="toast"
      role="status"
      data-testid={`notice-${notice.id}`}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        // Foco que passa para outro elemento do mesmo toast não solta.
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false)
      }}
    >
      <button type="button" className="toast-open" onClick={() => void store.openNotice(notice)}>
        <small className="muted">{notice.projectName}</small>
        <b>{notice.taskName}</b>
        <span>{notice.text}</span>
      </button>
      <button
        type="button"
        className="ghost toast-close"
        aria-label="Fechar aviso"
        onClick={() => store.dismissNotice(notice.id)}
      >
        ×
      </button>
    </div>
  )
}

/** Avisos rápidos no canto inferior direito; clicar abre a tarefa. */
export function NoticeToasts() {
  const notices = useAppState((s) => s.notices)
  if (notices.length === 0) return null
  return (
    <div className="toasts">
      {notices.map((n) => (
        <NoticeToast key={n.id} notice={n} />
      ))}
    </div>
  )
}
