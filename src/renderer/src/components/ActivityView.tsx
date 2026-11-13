import { useEffect, useRef } from 'react'
import type { ActivityEvent, JsonValue } from '@shared/domain'

const EMPTY: ActivityEvent[] = []

const TOOL_STATUS: Record<string, string> = {
  pending: 'pendente',
  in_progress: 'rodando',
  completed: 'ok',
  failed: 'falhou',
}

const STOP_TEXT: Record<string, string> = {
  end_turn: 'fim normal',
  max_tokens: 'limite de tokens',
  max_turn_requests: 'limite de pedidos',
  refusal: 'recusa',
  cancelled: 'cancelado',
}

function preview(value: JsonValue | null): string {
  if (value === null) return ''
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length > 240 ? `${text.slice(0, 240)}...` : text
}

function clock(at: number): string {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}

function Line({ ev }: { ev: ActivityEvent }) {
  const p = ev.payload
  switch (p.kind) {
    case 'prompt':
      return (
        <div className="act act-prompt">
          <span className="act-tag">prompt</span>
          <p className="pre">{p.text}</p>
        </div>
      )
    case 'text':
      return (
        <div className="act act-text">
          <p className="pre">{p.text}</p>
        </div>
      )
    case 'thought':
      return (
        <div className="act act-thought">
          <p className="pre">{p.text}</p>
        </div>
      )
    case 'tool_call':
      return (
        <div className="act act-tool">
          <span className="act-tag">ferramenta</span>
          <b>{p.title}</b>
          {p.toolKind && <span className="muted"> · {p.toolKind}</span>}
          <span className="muted"> · {TOOL_STATUS[p.status]}</span>
          {p.input !== null && <code className="act-io">{preview(p.input)}</code>}
        </div>
      )
    case 'tool_result':
      return (
        <div className={`act act-tool ${p.status === 'failed' ? 'act-bad' : ''}`}>
          <span className="act-tag">resultado</span>
          <span className="muted">{TOOL_STATUS[p.status]}</span>
          {p.output && <code className="act-io">{preview(p.output)}</code>}
        </div>
      )
    case 'error':
      return (
        <div className="act act-bad">
          <span className="act-tag">erro</span>
          {p.message}
        </div>
      )
    case 'turn_end':
      return (
        <div className="act act-end" role="separator">
          fim do turno ·{' '}
          {p.error
            ? `erro: ${p.error.message}`
            : p.stopReason
              ? STOP_TEXT[p.stopReason]
              : 'sem motivo'}
        </div>
      )
  }
}

/** Aba "Atividade": lista ao vivo do que o membro fez, com rolagem que segue o fim. */
export function ActivityView({ events = EMPTY }: { events?: ActivityEvent[] }) {
  const listRef = useRef<HTMLDivElement | null>(null)
  const stickRef = useRef(true)

  useEffect(() => {
    const el = listRef.current
    if (el && stickRef.current) el.scrollTop = el.scrollHeight
  }, [events.length])

  return (
    <div
      className="activity"
      data-testid="activity"
      ref={listRef}
      onScroll={(e) => {
        const el = e.currentTarget
        stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
      }}
    >
      {events.length === 0 && (
        <p className="muted">Nada ainda. A atividade aparece aqui ao vivo.</p>
      )}
      {events.map((ev) => (
        <div key={`${ev.sessionId}:${ev.seq}`} className="act-row">
          <span className="act-time">{clock(ev.at)}</span>
          <Line ev={ev} />
        </div>
      ))}
    </div>
  )
}
