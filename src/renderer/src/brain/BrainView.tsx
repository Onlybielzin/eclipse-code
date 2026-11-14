import './brain.css'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ActivityEvent, BrainGraph, BrainStatus, MemoryDetail } from '@shared/brain'
import { useAppState, useStore } from '../store/context'
import { buildScene } from './buildScene'
import { loadEngine, type BrainEngineLike, type EngineFactory } from './engineLoader'
import { readPref, savePref } from './prefs'

/** Limite do feed, igual ao site. */
export const FEED_LIMIT = 20

const KIND_LABEL: Record<ActivityEvent['kind'], string> = {
  search: 'busca',
  entity: 'entidade',
  get: 'leitura',
  save: 'nova memória',
  link: 'vínculo',
}

/** Vínculo: o 1o acerto é a memória, os outros são as entidades que ela ganhou. */
const linkText = (hits: number) =>
  hits > 1 ? `ligada a ${hits - 1} ${hits === 2 ? 'entidade' : 'entidades'}` : 'links alterados'

function hitsText(ev: ActivityEvent): string {
  const proj = ev.project ? ` · ${ev.project}` : ''
  if (ev.kind === 'link') return `${linkText(ev.hits.length)}${proj}`
  if (ev.kind === 'save') {
    const n = ev.hits.length
    return `criada${ev.project ? ` em ${ev.project}` : ''}${n > 1 ? ` · ligada a ${n - 1}` : ''}`
  }
  const n = ev.hits.length
  return `${n} ${n === 1 ? 'memória' : 'memórias'}${proj}`
}

/** Linha do rodapé do A30: tipo, consulta, quantidade, sessão, projeto e hora. */
function lastLine(ev: ActivityEvent, labelOf: Map<string, string>): string {
  const q = ev.kind === 'get' ? (labelOf.get(ev.query) ?? ev.query) : ev.query
  const parts = [KIND_LABEL[ev.kind], q.length > 70 ? `${q.slice(0, 69)}…` : q, hitsText(ev)]
  if (ev.origin) parts.push(ev.origin.label)
  const d = new Date(ev.ts)
  parts.push(`${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`)
  return parts.join('  ·  ')
}

function ago(ts: string, now: number): string {
  const s = Math.max(0, Math.round((now - Date.parse(ts)) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}min`
  return `${Math.floor(s / 3600)}h`
}

const isBool = (v: unknown): v is '1' | '0' => v === '1' || v === '0'

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/**
 * Cérebro do second-brain desenhado com three.js. `full` mostra controles, feed e painel da
 * memória (painel do meio); sem `full` é só o desenho pequeno da seção da direita.
 * Monta o motor, assina o SSE (brain.subscribe) e solta tudo ao desmontar.
 */
export function BrainView({
  full = false,
  createEngine = loadEngine,
}: {
  full?: boolean
  createEngine?: EngineFactory
}) {
  const store = useStore()
  const settingsOpen = useAppState((s) => s.settingsOpen)
  const { shape, motion, style, twinkle } = useAppState((s) => s.brainLook)
  const stageRef = useRef<HTMLDivElement>(null)
  const labelsRef = useRef<HTMLDivElement>(null)
  const engineRef = useRef<BrainEngineLike | null>(null)
  const rawRef = useRef<BrainGraph | null>(null)
  /** Pulso à espera da cena refeita (memória nova depois da carga). */
  const afterData = useRef<(() => void) | null>(null)

  const [status, setStatus] = useState<BrainStatus | null>(null)
  const [engine, setEngine] = useState<BrainEngineLike | null>(null)
  const [raw, setRaw] = useState<BrainGraph | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [feed, setFeed] = useState<ActivityEvent[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [detail, setDetail] = useState<MemoryDetail | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [feedOpen, setFeedOpen] = useState(
    () => readPref('eclipse.brain.feed', isBool, '1') === '1',
  )
  /** Itens do feed com as memórias destacadas; somam até clicar de novo ou em Centralizar. */
  const [focusedEvs, setFocusedEvs] = useState<ActivityEvent[]>([])

  const hasKey = status?.hasKey === true
  const scene = useMemo(() => (raw ? buildScene(raw) : null), [raw])
  const labelOf = useMemo(() => new Map(raw?.nodes.map((n) => [n.id, n.label]) ?? []), [raw])

  const refreshStatus = () => {
    store.loadBrainStatus().then(setStatus, (e: unknown) => setError(errText(e)))
  }
  // Estado da chave: relê ao abrir e quando o modal de Configurações fecha (a chave pode ter mudado).
  useEffect(() => {
    if (!settingsOpen) refreshStatus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, settingsOpen])

  const load = () =>
    store.call('brain.graph', {}).then(
      (g) => {
        rawRef.current = g
        setRaw(g)
        setError(null)
      },
      (e: unknown) => {
        setError(errText(e))
        refreshStatus()
      },
    )

  // Assinatura do SSE e carga do grafo: só com chave e só enquanto o cérebro está na tela.
  useEffect(() => {
    if (!hasKey) return
    let alive = true
    const offHistory = store.api.on('brain.history', (events) => {
      setFeed([...events].reverse().slice(0, FEED_LIMIT))
      refreshStatus() // o histórico chega quando o SSE abre: atualiza "ao vivo"
    })
    const offActivity = store.api.on('brain.activity', (ev) => {
      setFeed((f) => [ev, ...f].slice(0, FEED_LIMIT))
      setNow(Date.now())
      const ids = ev.hits.map((h) => h.id)
      const known = new Set(rawRef.current?.nodes.map((n) => n.id))
      // Como no A30: cada sessão vira uma bola de agente; sem origem, uma bola "sessão".
      const agent = ev.origin
        ? { id: ev.origin.id, label: ev.origin.label }
        : { id: '?', label: 'sessão' }
      const fireIt = () =>
        engineRef.current?.fire(ids, ev.kind, { birth: ev.kind === 'save', agent })
      // Vínculo muda os fios e memória nova muda os pontos: nos dois casos refaz a cena.
      if (ev.kind === 'link' || ids.some((id) => !known.has(id))) {
        store.call('brain.graph', {}).then((g) => {
          if (!alive) return
          afterData.current = fireIt
          rawRef.current = g
          setRaw(g)
        }, fireIt)
      } else fireIt()
    })
    const release = () => void store.api.invoke('brain.unsubscribe', {})
    void store.api.invoke('brain.subscribe', {})
    void load()
    // Recarga da tela: o React não desmonta, então solta a assinatura aqui.
    window.addEventListener('pagehide', release)
    return () => {
      alive = false
      window.removeEventListener('pagehide', release)
      offHistory()
      offActivity()
      release()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, hasKey])

  // Motor: criado quando o palco existe; dispose completo ao sair.
  useEffect(() => {
    if (!hasKey || !stageRef.current || !labelsRef.current) return
    let alive = true
    let made: BrainEngineLike | null = null
    createEngine(stageRef.current, labelsRef.current, setSelected).then(
      (e) => {
        if (!alive) return e.dispose()
        made = e
        engineRef.current = e
        setEngine(e)
      },
      (e: unknown) => alive && setError(`Não foi possível iniciar o desenho 3D: ${errText(e)}`),
    )
    return () => {
      alive = false
      engineRef.current = null
      setEngine(null)
      made?.dispose()
    }
  }, [createEngine, hasKey])

  useEffect(() => {
    engine?.setShape(shape)
  }, [engine, shape])
  useEffect(() => {
    engine?.setMotion(motion)
  }, [engine, motion])
  useEffect(() => {
    engine?.setStyle(style)
  }, [engine, style])
  useEffect(() => {
    engine?.setTwinkle(twinkle)
  }, [engine, twinkle])
  useEffect(() => savePref('eclipse.brain.feed', feedOpen ? '1' : '0'), [feedOpen])
  useEffect(() => {
    if (!engine || !scene) return
    engine.setData(scene)
    afterData.current?.()
    afterData.current = null
  }, [engine, scene])
  useEffect(() => {
    engine?.setHighlights(
      focusedEvs.map((ev) => ({ ids: ev.hits.map((x) => x.id), kind: ev.kind })),
    )
  }, [engine, focusedEvs])

  // Relógio do feed ("há 5s"): só no modo grande, onde o feed aparece.
  useEffect(() => {
    if (!full) return
    const t = setInterval(() => setNow(Date.now()), 5000)
    return () => clearInterval(t)
  }, [full])

  useEffect(() => {
    if (!selected) {
      setDetail(null)
      return
    }
    let alive = true
    store.call('brain.memory', { id: selected }).then(
      (d) => alive && setDetail(d),
      () => alive && setDetail(null),
    )
    return () => {
      alive = false
    }
  }, [store, selected])

  const isFocused = (ev: ActivityEvent) => focusedEvs.some((x) => x.seq === ev.seq)
  const toggleFocus = (ev: ActivityEvent) => {
    if (isFocused(ev)) {
      setFocusedEvs((list) => list.filter((x) => x.seq !== ev.seq))
      return
    }
    engine?.focus(ev.hits.map((x) => x.id))
    setFocusedEvs((list) => [...list, ev])
  }
  const recenter = () => {
    engine?.resetView()
    setFocusedEvs([])
  }

  const stats = scene
    ? `${scene.nodes.length} neurônios · ${scene.regions.length} regiões · ${scene.edges.length} conexões`
    : ''
  const live = status?.connected === true
  const problem = error ?? status?.lastError ?? null

  if (status && !hasKey) {
    return (
      <div className="brain-view brain-note" data-testid="brain-nokey">
        <p>Configure a chave do Second Brain em Configurações.</p>
        <button type="button" className="ghost" onClick={() => store.setSettingsOpen(true)}>
          Abrir Configurações
        </button>
      </div>
    )
  }

  const lastEv = feed[0]
  return (
    <div className={`brain-view ${full ? 'full' : 'mini'}`}>
      <div ref={stageRef} className="stage" />
      <div ref={labelsRef} className="labels" />

      {problem && (
        <div className="state overlay" role="alert" data-testid="brain-error">
          {error ? `Erro ao carregar o cérebro: ${error}` : problem}
        </div>
      )}
      {!problem && !raw && <div className="state overlay">Acordando o cérebro…</div>}

      {!full && (
        <div className="mini-bar">
          <span className={`live ${live ? 'on' : ''}`}>
            <i /> {live ? 'ao vivo' : 'desconectado'}
          </span>
          <span className="stats">{raw ? `${raw.nodes.length} neurônios` : ''}</span>
        </div>
      )}

      {full && (
        <>
          <div className="toolbar">
            <span className={`live ${live ? 'on' : ''}`}>
              <i /> {live ? 'ao vivo' : 'desconectado'}
            </span>
            <button type="button" onClick={recenter}>
              Centralizar
            </button>
            <button type="button" onClick={() => void load()}>
              Recarregar
            </button>
            <span className="stats">{stats}</span>
          </div>

          <aside className={`feed ${selected ? 'shifted' : ''} ${feedOpen ? '' : 'min'}`}>
            <button
              type="button"
              className="feed-top"
              onClick={() => setFeedOpen((o) => !o)}
              aria-expanded={feedOpen}
              aria-controls="feed-list"
              title={feedOpen ? 'Minimizar' : 'Expandir'}
            >
              <span className="feed-title">Atividade</span>
              {!feedOpen && feed.length > 0 && <span className="count">{feed.length}</span>}
              <span className="feed-toggle" aria-hidden="true">
                {feedOpen ? '–' : '+'}
              </span>
            </button>
            {!feedOpen ? null : feed.length === 0 ? (
              <p className="muted">
                Parado até alguma sessão do Claude consultar ou criar uma memória. Arraste para
                girar, role para aproximar.
              </p>
            ) : (
              <ul id="feed-list" data-testid="brain-feed">
                {feed.map((ev) => (
                  <li key={ev.seq}>
                    <button
                      type="button"
                      className={`feed-item ${isFocused(ev) ? 'on' : ''}`}
                      title={isFocused(ev) ? 'Tirar o destaque' : 'Focar e destacar estas memórias'}
                      aria-pressed={isFocused(ev)}
                      onClick={() => toggleFocus(ev)}
                    >
                      <span className="feed-head">
                        <span className={`kind ${ev.kind}`}>{KIND_LABEL[ev.kind]}</span>
                        <span className="when">
                          {ev.origin ? `${ev.origin.label} · ` : ''}
                          {ago(ev.ts, now)}
                        </span>
                      </span>
                      <span className="q">
                        {ev.kind === 'get' ? (labelOf.get(ev.query) ?? ev.query) : ev.query}
                      </span>
                      <span className="hits">{hitsText(ev)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </aside>

          {lastEv && (
            <div className="last-event">
              <i className={lastEv.kind} />
              <span>{lastLine(lastEv, labelOf)}</span>
            </div>
          )}

          <div className="legend">
            <span>
              <i style={{ background: '#8460f0' }} /> entidade
            </span>
            <span>
              <i style={{ background: '#4656a8' }} /> memória
            </span>
            <span>
              <i style={{ background: '#73f2ff', boxShadow: '0 0 8px #73f2ff' }} /> consultada
            </span>
            <span>
              <i style={{ background: '#73ff99', boxShadow: '0 0 8px #73ff99' }} /> criada
            </span>
          </div>

          {selected && (
            <aside className="memory-panel" aria-label="Memória">
              <button
                type="button"
                className="close"
                onClick={() => setSelected(null)}
                aria-label="Fechar"
              >
                ×
              </button>
              {!detail ? (
                <p className="muted">Carregando…</p>
              ) : (
                <>
                  <div className="meta">
                    <span className={`badge ${detail.type}`}>{detail.type}</span>
                    <span>{detail.scope}</span>
                    <span>imp {detail.importance}</span>
                    <span>{detail.created.slice(0, 10)}</span>
                  </div>
                  {detail.name && <h2>{detail.name}</h2>}
                  <code className="id">{detail.id}</code>
                  {detail.links.length > 0 && (
                    <section>
                      <h3>Ligada a</h3>
                      <div className="chips">
                        {detail.links.map((l) => (
                          <button
                            type="button"
                            key={l.id}
                            className="chip"
                            onClick={() => setSelected(l.id)}
                          >
                            {l.name}
                          </button>
                        ))}
                      </div>
                    </section>
                  )}
                  <pre className="body">{detail.body.trim()}</pre>
                </>
              )}
            </aside>
          )}
        </>
      )}
    </div>
  )
}
