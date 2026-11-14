import { useEffect, useMemo, useRef, useState } from 'react'
import type { ActivityEvent, JsonValue } from '@shared/domain'

const EMPTY: ActivityEvent[] = []
/** Linhas de saida mostradas por ferramenta antes de "mais N linhas". */
const OUTPUT_LINES = 12

const STOP_TEXT: Record<string, string> = {
  end_turn: 'fim normal',
  max_tokens: 'limite de tokens',
  max_turn_requests: 'limite de pedidos',
  refusal: 'recusa',
  cancelled: 'cancelado',
}

/** Titulos genericos que o ACP manda antes do titulo real chegar numa atualizacao. */
const GENERIC_TITLES = new Set(['Terminal', 'terminal', 'Read', 'Edit', 'Write', ''])

function clock(at: number): string {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}

function inputText(value: JsonValue | null): string | null {
  if (value === null) return null
  if (typeof value === 'string') return value
  if (typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, JsonValue>
    for (const key of ['command', 'file_path', 'path', 'pattern', 'url', 'query']) {
      const v = obj[key]
      if (typeof v === 'string' && v) return v
    }
    if (Object.keys(obj).length === 0) return null
  }
  const text = JSON.stringify(value)
  return text.length > 300 ? `${text.slice(0, 300)}...` : text
}

/** Tira a cerca ``` que o adaptador poe em volta da saida. */
function cleanOutput(text: string): string {
  return text.replace(/^```[^\n]*\n?/, '').replace(/\n?```\s*$/, '')
}

interface ToolBlock {
  type: 'tool'
  key: string
  at: number
  title: string
  kind: string | null
  status: string
  input: string | null
  output: string | null
  failed: boolean
}

type Block = ToolBlock | { type: 'event'; key: string; at: number; ev: ActivityEvent }

/** Junta as atualizacoes de cada ferramenta (titulo, estado, entrada, saida) num bloco so. */
export function buildBlocks(events: readonly ActivityEvent[]): Block[] {
  const blocks: Block[] = []
  const tools = new Map<string, ToolBlock>()
  for (const ev of events) {
    const p = ev.payload
    if (p.kind === 'tool_call') {
      const existing = tools.get(p.toolCallId)
      const input = inputText(p.input)
      if (existing) {
        if (!GENERIC_TITLES.has(p.title) || GENERIC_TITLES.has(existing.title)) {
          existing.title = p.title || existing.title
        }
        existing.status = p.status
        existing.kind = p.toolKind ?? existing.kind
        if (input) existing.input = input
        if (p.status === 'failed') existing.failed = true
        continue
      }
      const block: ToolBlock = {
        type: 'tool',
        key: `${ev.sessionId}:${ev.seq}`,
        at: ev.at,
        title: p.title,
        kind: p.toolKind,
        status: p.status,
        input,
        output: null,
        failed: p.status === 'failed',
      }
      tools.set(p.toolCallId, block)
      blocks.push(block)
      continue
    }
    if (p.kind === 'tool_result') {
      const block = tools.get(p.toolCallId)
      if (block) {
        block.status = p.status
        block.failed = p.status === 'failed'
        if (p.output) block.output = cleanOutput(p.output)
        continue
      }
    }
    blocks.push({ type: 'event', key: `${ev.sessionId}:${ev.seq}`, at: ev.at, ev })
  }
  return blocks
}

function ToolView({ block }: { block: ToolBlock }) {
  const [open, setOpen] = useState(false)
  const running = block.status === 'pending' || block.status === 'in_progress'
  const showInput = block.input && block.input !== block.title
  const lines = block.output ? block.output.split('\n') : []
  const hidden = open ? 0 : Math.max(0, lines.length - OUTPUT_LINES)
  const shown = hidden > 0 ? lines.slice(0, OUTPUT_LINES) : lines
  return (
    <div className={`tl tl-tool ${block.failed ? 'tl-bad' : ''}`} title={clock(block.at)}>
      <div className="tl-head">
        <span className={`tl-dot ${running ? 'tl-run' : block.failed ? 'tl-fail' : 'tl-ok'}`}>
          ⏺
        </span>
        <b>{block.title || block.kind || 'ferramenta'}</b>
        {showInput && <span className="tl-arg">({block.input})</span>}
        {running && <span className="tl-muted"> rodando...</span>}
      </div>
      {shown.length > 0 && (
        <pre className="tl-out">
          <span className="tl-branch">⎿ </span>
          {shown.join('\n')}
        </pre>
      )}
      {hidden > 0 && (
        <button type="button" className="tl-more" onClick={() => setOpen(true)}>
          + {hidden} linhas
        </button>
      )}
    </div>
  )
}

function EventView({ ev }: { ev: ActivityEvent }) {
  const p = ev.payload
  switch (p.kind) {
    case 'prompt':
      return (
        <div className="tl tl-prompt" title={clock(ev.at)}>
          <span className="tl-muted">&gt; </span>
          {p.text}
        </div>
      )
    case 'text':
      return (
        <div className="tl tl-text" title={clock(ev.at)}>
          <span className="tl-dot tl-say">⏺</span>
          {p.text}
        </div>
      )
    case 'thought':
      return (
        <div className="tl tl-thought" title={clock(ev.at)}>
          ✻ {p.text}
        </div>
      )
    case 'error':
      return (
        <div className="tl tl-bad" title={clock(ev.at)}>
          ✗ {p.message}
        </div>
      )
    case 'turn_end':
      return (
        <div className="tl tl-end" role="separator" title={clock(ev.at)}>
          ── fim do turno ·{' '}
          {p.error
            ? `erro: ${p.error.message}`
            : p.stopReason
              ? STOP_TEXT[p.stopReason]
              : 'sem motivo'}{' '}
          · {clock(ev.at)} ──
        </div>
      )
    default:
      return null
  }
}

/**
 * Aba "Atividade": o que o membro (Claude ou Codex sem tela) esta fazendo, no formato de
 * um terminal do Claude Code. Segue o fim enquanto voce nao rolar para cima.
 */
export function ActivityView({
  events = EMPTY,
  working = false,
}: {
  events?: ActivityEvent[]
  working?: boolean
}) {
  const listRef = useRef<HTMLDivElement | null>(null)
  const stickRef = useRef(true)
  const blocks = useMemo(() => buildBlocks(events), [events])

  useEffect(() => {
    const el = listRef.current
    if (el && stickRef.current) el.scrollTop = el.scrollHeight
  }, [events])

  return (
    <div
      className="activity tl-term"
      data-testid="activity"
      ref={listRef}
      onScroll={(e) => {
        const el = e.currentTarget
        stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
      }}
    >
      {blocks.length === 0 && (
        <p className="tl-muted">Nada ainda. O que o membro fizer aparece aqui ao vivo.</p>
      )}
      {blocks.map((b) =>
        b.type === 'tool' ? (
          <ToolView key={b.key} block={b} />
        ) : (
          <EventView key={b.key} ev={b.ev} />
        ),
      )}
      {working && (
        <div className="tl tl-working" role="status">
          <span className="tl-spin" aria-hidden="true">
            ✻
          </span>{' '}
          trabalhando...
        </div>
      )}
    </div>
  )
}
