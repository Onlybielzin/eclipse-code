import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import type { BrainStatus } from '@shared/brain'
import { MOTIONS, STYLES } from '../brain/looks'
import { SHAPES } from '../brain/shapes'
import { useAppState, useStore } from '../store/context'
import './settings.css'

const LIMIT_ERROR = 'Informe um número inteiro de 1 a 100, ou deixe vazio para sem limite.'

/** Campo vazio = sem limite (null). Devolve undefined se o texto não é inteiro de 1 a 100. */
function parseLimit(text: string): number | null | undefined {
  const t = text.trim()
  if (t === '') return null
  const n = Number(t)
  return Number.isInteger(n) && n >= 1 && n <= 100 ? n : undefined
}

const IDLE_ERROR = 'Informe um número inteiro de horas, de 0 a 720 (0 desliga).'

/** Horas de espera automática: inteiro de 0 a 720; undefined se o texto não serve. */
function parseIdleHours(text: string): number | undefined {
  const n = Number(text.trim() === '' ? '0' : text.trim())
  return Number.isInteger(n) && n >= 0 && n <= 720 ? n : undefined
}

/** Página "Configurações": ocupa o meio e a direita; limites no botão, chave e cérebro na hora. */
export function SettingsPage({ alone = false }: { alone?: boolean }) {
  const store = useStore()
  const look = useAppState((s) => s.brainLook)
  const [maxAgents, setMaxAgents] = useState('')
  const [maxMembers, setMaxMembers] = useState('')
  const [idleHours, setIdleHours] = useState('0')
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [brain, setBrain] = useState<BrainStatus | null>(null)
  const [brainKey, setBrainKey] = useState('')
  const [brainBusy, setBrainBusy] = useState(false)
  const [brainError, setBrainError] = useState<string | null>(null)
  const update = useAppState((s) => s.update)
  const [checking, setChecking] = useState(false)
  const [updateMsg, setUpdateMsg] = useState<{ text: string; bad: boolean } | null>(null)
  /** Texto dos limites como estão salvos no main: base do "Descartar" e do aviso de alteração. */
  const [saved, setSaved] = useState({ agents: '', members: '', idle: '0' })

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') store.setSettingsOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [store])

  useEffect(() => {
    let alive = true
    store
      .loadAgentLimits()
      .then((limits) => {
        if (!alive) return
        const agents = limits.maxLiveAgents === null ? '' : String(limits.maxLiveAgents)
        const members =
          limits.maxLiveMembersPerTask === null ? '' : String(limits.maxLiveMembersPerTask)
        setMaxAgents(agents)
        setMaxMembers(members)
        setIdleHours(String(limits.idleStandbyHours))
        setSaved({ agents, members, idle: String(limits.idleStandbyHours) })
        setLoaded(true)
      })
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      alive = false
    }
  }, [store])

  useEffect(() => {
    let alive = true
    store
      .loadBrainStatus()
      .then((status) => alive && setBrain(status))
      .catch((e: unknown) => alive && setBrainError(e instanceof Error ? e.message : String(e)))
    return () => {
      alive = false
    }
  }, [store])

  /** A chave não passa pelo "Salvar limites": os botões da seção valem na hora. */
  const changeBrainKey = async (key: string | null) => {
    if (key !== null && !key.trim().startsWith('sbk_')) {
      setBrainError('A chave do Second Brain começa com "sbk_".')
      return
    }
    setBrainBusy(true)
    setBrainError(null)
    try {
      setBrain(await store.saveBrainKey(key === null ? null : key.trim()))
      setBrainKey('')
    } catch (err) {
      setBrainError(err instanceof Error ? err.message : String(err))
    } finally {
      setBrainBusy(false)
    }
  }

  const checkUpdate = async () => {
    setChecking(true)
    setUpdateMsg(null)
    try {
      const { current, available } = await store.checkUpdate()
      setUpdateMsg({
        bad: false,
        text:
          available === null
            ? `Você já está na versão mais recente (${current}).`
            : `Versão ${available} encontrada. Baixando; o aviso aparece no topo quando terminar.`,
      })
    } catch (err) {
      setUpdateMsg({ bad: true, text: err instanceof Error ? err.message : String(err) })
    } finally {
      setChecking(false)
    }
  }
  const restart = () => {
    const message = `Fechar o app instala a versão ${update.version} e para os agentes em andamento. Abra o app de novo depois. Continuar?`
    if (window.confirm(message)) void store.installUpdate()
  }

  const dirty =
    maxAgents.trim() !== saved.agents ||
    maxMembers.trim() !== saved.members ||
    idleHours.trim() !== saved.idle
  const discard = () => {
    setMaxAgents(saved.agents)
    setMaxMembers(saved.members)
    setIdleHours(saved.idle)
    setError(null)
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const maxLiveAgents = parseLimit(maxAgents)
    const maxLiveMembersPerTask = parseLimit(maxMembers)
    if (maxLiveAgents === undefined || maxLiveMembersPerTask === undefined) {
      setError(LIMIT_ERROR)
      return
    }
    const idleStandbyHours = parseIdleHours(idleHours)
    if (idleStandbyHours === undefined) {
      setError(IDLE_ERROR)
      return
    }
    setSaving(true)
    setError(null)
    try {
      await store.saveAgentLimits({ maxLiveAgents, maxLiveMembersPerTask, idleStandbyHours })
      setSaved({
        agents: maxAgents.trim(),
        members: maxMembers.trim(),
        idle: String(idleStandbyHours),
      })
      setIdleHours(String(idleStandbyHours))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <main className={`settings-page ${alone ? 'alone' : ''}`} aria-labelledby="settings-title">
      <div className="settings-head">
        <button
          type="button"
          className="settings-back"
          onClick={() => store.setSettingsOpen(false)}
        >
          <span aria-hidden="true">‹</span> Voltar ao Líder
        </button>
        <h1 id="settings-title">Configurações</h1>
        <div className="settings-legend">
          <span>
            <i className="dot now" aria-hidden="true" />
            Vale na hora
          </span>
          <span>
            <i className="dot btn" aria-hidden="true" />
            Salva no botão
          </span>
        </div>
      </div>
      <div className="settings-body">
        <nav className="settings-index" aria-label="Seções">
          <small>Seções</small>
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => document.getElementById(s.id)?.scrollIntoView?.({ block: 'start' })}
            >
              {s.label}
            </button>
          ))}
        </nav>
        <div className="settings-scroll">
          <div className="settings-wrap">
            <section id="agentes" aria-labelledby="h-agentes">
              <header>
                <h2 id="h-agentes">Agentes</h2>
                <p>
                  Limites de agentes vivos. Baixar o limite não derruba ninguém: só impede abrir o
                  próximo.
                </p>
              </header>
              <form className="settings-card" noValidate onSubmit={(e) => void submit(e)}>
                <Row
                  label="Máximo de agentes vivos no app"
                  hint="Conta Líderes e membros. Vazio = sem limite."
                  tag="btn"
                  control={
                    <input
                      className="field num"
                      type="number"
                      min={1}
                      max={100}
                      step={1}
                      aria-label="Máximo de agentes vivos no app"
                      value={maxAgents}
                      disabled={!loaded}
                      onChange={(e) => setMaxAgents(e.target.value)}
                    />
                  }
                />
                <Row
                  label="Máximo de membros vivos por tarefa"
                  hint="Vazio = sem limite."
                  tag="btn"
                  control={
                    <input
                      className="field num"
                      type="number"
                      min={1}
                      max={100}
                      step={1}
                      aria-label="Máximo de membros vivos por tarefa"
                      value={maxMembers}
                      disabled={!loaded}
                      onChange={(e) => setMaxMembers(e.target.value)}
                    />
                  }
                />
                <Row
                  label="Colocar em espera após"
                  hint="0 desliga."
                  tag="btn"
                  control={
                    <span>
                      <input
                        className="field num"
                        type="number"
                        min={0}
                        max={720}
                        step={1}
                        aria-label="Horas sem atividade para colocar em espera"
                        value={idleHours}
                        disabled={!loaded}
                        onChange={(e) => setIdleHours(e.target.value)}
                      />{' '}
                      horas sem atividade
                    </span>
                  }
                />
                {error && (
                  <p className="modal-note bad settings-error" role="alert">
                    {error}
                  </p>
                )}
                <div className="settings-foot">
                  <span className="msg" aria-live="polite">
                    {!loaded
                      ? 'Carregando...'
                      : dirty
                        ? 'Alterações não salvas'
                        : `Limites salvos: ${saved.agents === '' ? 'sem limite de agentes' : `${saved.agents} agentes`}, ${saved.members === '' ? 'sem limite' : saved.members} por tarefa`}
                  </span>
                  <button
                    type="button"
                    className="ghost"
                    disabled={!dirty || saving}
                    onClick={discard}
                  >
                    Descartar
                  </button>
                  <button type="submit" className="primary" disabled={!loaded || !dirty || saving}>
                    {saving ? 'Salvando...' : 'Salvar limites'}
                  </button>
                </div>
              </form>
            </section>

            <section id="second-brain" aria-labelledby="h-brain">
              <header>
                <h2 id="h-brain">Second Brain</h2>
                <p>
                  Chave de acesso do Second Brain. Fica cifrada neste computador e nunca aparece
                  inteira na tela.
                </p>
              </header>
              <div className="settings-card">
                <Row
                  label="Chave de acesso"
                  hint={
                    <>
                      Começa com <code>sbk_</code>. Cole uma chave nova para trocar a atual.
                    </>
                  }
                  tag="now"
                  control={
                    <div className="settings-stack">
                      <input
                        className="field mono"
                        type="password"
                        autoComplete="off"
                        maxLength={200}
                        placeholder="sbk_..."
                        aria-label="Chave de acesso"
                        value={brainKey}
                        disabled={brainBusy}
                        onChange={(e) => setBrainKey(e.target.value)}
                      />
                      <small className="settings-keystate">
                        {brain?.hasKey
                          ? `Chave salva (…${brain.keyLast4 ?? ''})`
                          : 'Nenhuma chave salva. Ela fica cifrada neste computador.'}
                      </small>
                    </div>
                  }
                />
                {brainError && (
                  <p className="modal-note bad settings-error" role="alert">
                    {brainError}
                  </p>
                )}
                <div className="settings-foot">
                  <span className="msg">Os dois botões agem na hora, sem o Salvar limites.</span>
                  <button
                    type="button"
                    className="ghost"
                    disabled={brainBusy || !brain?.hasKey}
                    onClick={() => void changeBrainKey(null)}
                  >
                    Remover chave
                  </button>
                  <button
                    type="button"
                    className="primary"
                    disabled={brainBusy || brainKey.trim() === ''}
                    onClick={() => void changeBrainKey(brainKey)}
                  >
                    Salvar chave
                  </button>
                </div>
              </div>
            </section>

            <section id="atualizacao" aria-labelledby="h-atualizacao">
              <header>
                <h2 id="h-atualizacao">Atualização</h2>
                <p>O app procura versão nova ao abrir e a cada 4 horas. Aqui você procura agora.</p>
              </header>
              <div className="settings-card">
                <div className="settings-foot">
                  {updateMsg && (
                    <span
                      className={updateMsg.bad ? 'msg modal-note bad' : 'msg'}
                      role={updateMsg.bad ? 'alert' : undefined}
                      aria-live="polite"
                    >
                      {updateMsg.text}
                    </span>
                  )}
                  {update.status === 'ready' && (
                    <button type="button" className="ghost" onClick={restart}>
                      Reiniciar e atualizar
                    </button>
                  )}
                  <button
                    type="button"
                    className="primary"
                    disabled={checking}
                    onClick={() => void checkUpdate()}
                  >
                    {checking ? 'Verificando...' : 'Verificar atualização'}
                  </button>
                </div>
              </div>
            </section>

            <section id="cerebro" aria-labelledby="h-cerebro">
              <header>
                <h2 id="h-cerebro">Cérebro</h2>
                <p>
                  Aparência das bolinhas de memória. Cada mudança vale na hora, no cérebro pequeno
                  do app e na tela grande.
                </p>
              </header>
              <div className="settings-card">
                <Row
                  label="Forma"
                  hint="O desenho que as bolinhas formam."
                  tag="now"
                  control={
                    <select
                      className="field"
                      aria-label="Forma"
                      value={look.shape}
                      onChange={(e) =>
                        store.setBrainLook({ shape: e.target.value as typeof look.shape })
                      }
                    >
                      {SHAPES.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  }
                />
                <Row
                  label="Movimento"
                  hint="Como as bolinhas se mexem."
                  tag="now"
                  control={
                    <select
                      className="field"
                      aria-label="Movimento"
                      value={look.motion}
                      onChange={(e) =>
                        store.setBrainLook({ motion: e.target.value as typeof look.motion })
                      }
                    >
                      {MOTIONS.map((o) => (
                        <option key={o.id} value={o.id}>
                          {`${o.label} - ${o.hint}`}
                        </option>
                      ))}
                    </select>
                  }
                />
                <Row
                  label="Cor"
                  hint="O que a cor de cada bolinha mostra."
                  tag="now"
                  control={
                    <select
                      className="field"
                      aria-label="Cor"
                      value={look.style}
                      onChange={(e) =>
                        store.setBrainLook({ style: e.target.value as typeof look.style })
                      }
                    >
                      {STYLES.map((o) => (
                        <option key={o.id} value={o.id}>
                          {`${o.label} - ${o.hint}`}
                        </option>
                      ))}
                    </select>
                  }
                />
                <Row
                  label="Cintilar"
                  hint="Cada bolinha pisca de leve, em tempos diferentes."
                  tag="now"
                  control={
                    <label className="settings-switch">
                      <input
                        type="checkbox"
                        role="switch"
                        aria-label="Cintilar"
                        checked={look.twinkle}
                        onChange={(e) => store.setBrainLook({ twinkle: e.target.checked })}
                      />
                      <span>{look.twinkle ? 'Ligado' : 'Desligado'}</span>
                    </label>
                  }
                />
              </div>
            </section>
          </div>
        </div>
      </div>
    </main>
  )
}

const SECTIONS = [
  { id: 'agentes', label: 'Agentes' },
  { id: 'second-brain', label: 'Second Brain' },
  { id: 'atualizacao', label: 'Atualização' },
  { id: 'cerebro', label: 'Cérebro' },
]

/** Linha da página: nome e explicação à esquerda, controle à direita, etiqueta de quando vale. */
function Row({
  label,
  hint,
  tag,
  control,
}: {
  label: string
  hint: ReactNode
  tag: 'now' | 'btn'
  control: ReactNode
}) {
  return (
    <div className="settings-row">
      <div>
        <div className="lab">
          {label}
          <span className={`tag ${tag}`}>{tag === 'now' ? 'Vale na hora' : 'Salva no botão'}</span>
        </div>
        <div className="exp">{hint}</div>
      </div>
      <div className="ctl">{control}</div>
    </div>
  )
}
