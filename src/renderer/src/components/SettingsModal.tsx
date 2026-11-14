import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { BrainStatus } from '@shared/brain'
import { MOTIONS, STYLES } from '../brain/looks'
import { SHAPES } from '../brain/shapes'
import { useAppState, useStore } from '../store/context'

const LIMIT_ERROR = 'Informe um número inteiro de 1 a 100, ou deixe vazio para sem limite.'

/** Campo vazio = sem limite (null). Devolve undefined se o texto não é inteiro de 1 a 100. */
function parseLimit(text: string): number | null | undefined {
  const t = text.trim()
  if (t === '') return null
  const n = Number(t)
  return Number.isInteger(n) && n >= 1 && n <= 100 ? n : undefined
}

/** Modal "Configurações": os dois limites de agentes vivos. Salvar vale na hora, sem reiniciar. */
export function SettingsModal({ onClose }: { onClose: () => void }) {
  const store = useStore()
  const look = useAppState((s) => s.brainLook)
  const [maxAgents, setMaxAgents] = useState('')
  const [maxMembers, setMaxMembers] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [brain, setBrain] = useState<BrainStatus | null>(null)
  const [brainKey, setBrainKey] = useState('')
  const [brainBusy, setBrainBusy] = useState(false)
  const [brainError, setBrainError] = useState<string | null>(null)
  const firstField = useRef<HTMLInputElement>(null)

  // O input só aceita foco depois de habilitado, ou seja, depois de carregar.
  useEffect(() => {
    if (loaded) firstField.current?.focus()
  }, [loaded])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    let alive = true
    store
      .loadAgentLimits()
      .then((limits) => {
        if (!alive) return
        setMaxAgents(limits.maxLiveAgents === null ? '' : String(limits.maxLiveAgents))
        setMaxMembers(
          limits.maxLiveMembersPerTask === null ? '' : String(limits.maxLiveMembersPerTask),
        )
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

  /** A chave não é gravada pelo "Salvar" do modal: os botões da seção valem na hora. */
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

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const maxLiveAgents = parseLimit(maxAgents)
    const maxLiveMembersPerTask = parseLimit(maxMembers)
    if (maxLiveAgents === undefined || maxLiveMembersPerTask === undefined) {
      setError(LIMIT_ERROR)
      return
    }
    setSaving(true)
    setError(null)
    try {
      await store.saveAgentLimits({ maxLiveAgents, maxLiveMembersPerTask })
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <form
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        noValidate
        onSubmit={(e) => void submit(e)}
      >
        <header className="modal-head">
          <h2 id="settings-title">Configurações</h2>
          <p>
            Limites de agentes. Baixar o limite não derruba ninguém: só impede abrir o próximo.
          </p>
        </header>

        <label className="modal-field">
          <span>Máximo de agentes vivos no app</span>
          <input
            ref={firstField}
            className="field"
            type="number"
            min={1}
            max={100}
            step={1}
            value={maxAgents}
            disabled={!loaded}
            onChange={(e) => setMaxAgents(e.target.value)}
          />
          <small>Conta Líderes e membros. Vazio = sem limite.</small>
        </label>

        <label className="modal-field">
          <span>Máximo de membros vivos por tarefa</span>
          <input
            className="field"
            type="number"
            min={1}
            max={100}
            step={1}
            value={maxMembers}
            disabled={!loaded}
            onChange={(e) => setMaxMembers(e.target.value)}
          />
          <small>Vazio = sem limite.</small>
        </label>

        <fieldset className="modal-field">
          <legend>Second Brain</legend>
          <label className="modal-field">
            <span>Chave de acesso (sbk_...)</span>
            <input
              className="field"
              type="password"
              autoComplete="off"
              maxLength={200}
              value={brainKey}
              disabled={brainBusy}
              onChange={(e) => setBrainKey(e.target.value)}
            />
            <small>
              {brain?.hasKey
                ? `Chave salva (…${brain.keyLast4 ?? ''})`
                : 'Nenhuma chave salva. Ela fica cifrada neste computador.'}
            </small>
          </label>
          <div className="modal-actions">
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
          <p className="modal-note">Efeito do cérebro: vale na hora, no pequeno e no grande.</p>
          <label className="modal-field">
            <span>Forma</span>
            <select
              className="field"
              value={look.shape}
              onChange={(e) => store.setBrainLook({ shape: e.target.value as typeof look.shape })}
            >
              {SHAPES.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label className="modal-field">
            <span>Movimento</span>
            <select
              className="field"
              value={look.motion}
              onChange={(e) => store.setBrainLook({ motion: e.target.value as typeof look.motion })}
            >
              {MOTIONS.map((o) => (
                <option key={o.id} value={o.id}>
                  {`${o.label} - ${o.hint}`}
                </option>
              ))}
            </select>
          </label>
          <label className="modal-field">
            <span>Cor</span>
            <select
              className="field"
              value={look.style}
              onChange={(e) => store.setBrainLook({ style: e.target.value as typeof look.style })}
            >
              {STYLES.map((o) => (
                <option key={o.id} value={o.id}>
                  {`${o.label} - ${o.hint}`}
                </option>
              ))}
            </select>
          </label>
          <label className="modal-field">
            <span>Cintilar</span>
            <input
              type="checkbox"
              role="switch"
              checked={look.twinkle}
              onChange={(e) => store.setBrainLook({ twinkle: e.target.checked })}
            />
          </label>
          {brainError && (
            <p className="modal-note bad" role="alert">
              {brainError}
            </p>
          )}
        </fieldset>

        {error && (
          <p className="modal-note bad" role="alert">
            {error}
          </p>
        )}

        <footer className="modal-actions">
          <button type="button" className="ghost" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="primary" disabled={!loaded || saving}>
            {saving ? 'Salvando...' : 'Salvar'}
          </button>
        </footer>
      </form>
    </div>
  )
}
