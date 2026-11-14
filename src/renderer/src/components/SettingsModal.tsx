import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useStore } from '../store/context'

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
  const [maxAgents, setMaxAgents] = useState('')
  const [maxMembers, setMaxMembers] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
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
