import { useEffect, useState } from 'react'
import { useStore } from '../store/context'
import { Odometer } from './Odometer'
import { Sparkline } from './Sparkline'
import { WallCard } from './WallCard'
import { advanceSession, heatOf, hiddenCards, newSession, sortCards, totalLines, type Session } from './wallLogic'
import './wall.css'

const POLL_MS = 3000
const fmt = (n: number) => n.toLocaleString('pt-BR')
const clock = (at: number) => new Date(at).toTimeString().slice(0, 8)

/** Parede: placar de linhas, numeros, cartoes das tarefas de todos os projetos e log da sessao. */
export function WallView() {
  const store = useStore()
  const [session, setSession] = useState<Session>(newSession)

  // Laco serial: o proximo retrato so e agendado quando o anterior termina (3 s depois).
  // Janela oculta nao consulta. Ao fechar, `alive` descarta resposta tardia e para o laco.
  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      if (!document.hidden) {
        const snap = await store.loadWallSnapshot()
        if (alive && snap) setSession((s) => advanceSession(s, snap, Date.now()))
      }
      if (alive) timer = setTimeout(() => void tick(), POLL_MS)
    }
    void tick()
    // Esc fecha, a menos que um menu, modal ou campo (inclui o terminal) ja use a tecla.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      if (document.querySelector('[aria-modal="true"], .proj-pop')) return
      if ((e.target as HTMLElement | null)?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"]), .xterm')) return
      store.setWallOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => {
      alive = false
      clearTimeout(timer)
      window.removeEventListener('keydown', onKey)
    }
  }, [store])

  const snap = session.last
  const total = snap ? totalLines(snap) : 0
  const cards = snap ? sortCards(snap.tasks) : []
  const projects = snap ? new Set(snap.tasks.map((t) => t.projectId)).size : 0
  const heat = heatOf(session.rate.lpm)

  return (
    <div className="mid-layer wall" data-testid="wall-view" style={{ '--heat': heat } as React.CSSProperties}>
      <div className="wall-scroll">
        <section className="wall-panel wall-hero" aria-label="Linhas nas tarefas abertas">
          <div>
            <div className="wall-k">linhas nas tarefas abertas</div>
            <div className="wall-odo-row">
              <Odometer value={total} label={`${fmt(total)} linhas`} />
              {session.gain && (
                <span key={session.gain.seq} className="wall-inc" aria-hidden="true">
                  +{session.gain.n}
                </span>
              )}
            </div>
            <div className="wall-s">soma do git diff de todas as worktrees abertas</div>
          </div>
          <div>
            <div className="wall-rate-head">
              <span className="wall-k">linhas por minuto, últimos 60 s</span>
              <b data-testid="wall-lpm">
                {session.rate.lpm}
                <small>lpm</small>
              </b>
            </div>
            <Sparkline buckets={session.rate.buckets} />
            <div className="wall-heat" aria-hidden="true">
              <i />
            </div>
          </div>
        </section>

        <section className="wall-stats" aria-label="Resumo">
          <Stat label="agentes trabalhando" value={snap?.workingAgents ?? 0}
            small={snap?.maxLiveAgents != null ? `/${snap.maxLiveAgents}` : ''}
            sub={snap?.maxLiveAgents != null ? `limite do app: ${snap.maxLiveAgents}` : 'sem limite'} />
          <Stat label="subtarefas prontas hoje" value={snap?.doneToday ?? 0} sub="desde a meia-noite" />
          <Stat label="tarefas em revisão" value={snap?.inReview ?? 0} sub="esperando o Revisor" />
          <Stat label="perguntas abertas" value={snap?.openQuestions ?? 0} ask
            sub={snap?.openQuestions ? 'esperam resposta sua' : 'nenhuma esperando'} />
        </section>

        <div className="wall-sec">
          <b>Tarefas abertas</b>
          <span>
            {snap ? `${snap.tasks.length} em ${projects} projeto${projects === 1 ? '' : 's'}` : 'carregando...'}
          </span>
        </div>
        <section className="wall-grid">
          {cards.map((t) => (
            <WallCard key={t.id} task={t} flash={session.flash[t.id] ?? 0} />
          ))}
          {snap && cards.length === 0 && <p className="wall-empty">Nenhuma tarefa aberta com worktree.</p>}
        </section>
        {snap && hiddenCards(snap.tasks.length) > 0 && (
          <p className="wall-empty" data-testid="wall-hidden">
            +{hiddenCards(snap.tasks.length)} tarefas fora da grade
          </p>
        )}
      </div>

      <section className="wall-log" aria-label="Log da sessão">
        <h3>Log da sessão</h3>
        {session.log.slice(0, 5).map((l) => (
          <div key={l.id} className="wall-row">
            <span className="tm">{clock(l.at)}</span>
            <span className="pj">{l.project}</span>
            <span className="tk">{l.task}</span>
            <span className={`ev ${l.kind}`}>{l.text}</span>
          </div>
        ))}
      </section>

      {session.milestone && (
        <>
          <div key={`s${session.milestone.seq}`} className="wall-sweep" aria-hidden="true" />
          <div key={`b${session.milestone.seq}`} className="wall-banner" data-testid="wall-banner">
            <div className="big">{fmt(session.milestone.value)}</div>
            <div className="sm">linhas nas tarefas abertas</div>
          </div>
        </>
      )}
      <div className="wall-sr" role="status">
        {session.milestone ? `Marco: ${fmt(session.milestone.value)} linhas nas tarefas abertas` : ''}
      </div>
    </div>
  )
}

function Stat(p: { label: string; value: number; sub: string; small?: string; ask?: boolean }) {
  return (
    <div className={`wall-panel wall-stat ${p.ask ? 'q' : ''}`}>
      <span className="wall-k">{p.label}</span>
      {/* key = valor: troca de numero reinicia o "bump". */}
      <span key={p.value} className="v">
        {fmt(p.value)}
        {p.small && <small>{p.small}</small>}
      </span>
      <span className="wall-s">{p.sub}</span>
    </div>
  )
}
