import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { Project } from '@shared/domain'
import { useStore } from '../store/context'

/**
 * Modal "Editar projeto": renomeia e, numa area separada, exclui (com confirmacao).
 * So fecha quando o main aceita; se recusar, o erro do store aparece e a modal fica.
 */
export function ProjectEditModal({ project, onClose }: { project: Project; onClose: () => void }) {
  const store = useStore()
  const [name, setName] = useState(project.name)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    input.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const trimmed = name.trim()
  const run = async (work: () => Promise<boolean>) => {
    setBusy(true)
    try {
      if (await work()) onClose()
    } finally {
      setBusy(false)
    }
  }

  const save = (e: FormEvent) => {
    e.preventDefault()
    if (!trimmed || trimmed === project.name) return
    void run(() => store.renameProject(project.id, trimmed))
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
        aria-labelledby="edit-project-title"
        onSubmit={save}
      >
        <header className="modal-head">
          <h2 id="edit-project-title">Editar projeto</h2>
          <p>{project.rootPath}</p>
        </header>

        <label className="modal-field">
          <span>Nome do projeto</span>
          <input
            ref={input}
            className="field"
            value={name}
            maxLength={200}
            onChange={(e) => setName(e.target.value)}
          />
        </label>

        <section className="modal-danger" aria-label="Excluir projeto">
          <b>Excluir projeto</b>
          {confirming ? (
            <>
              <p className="modal-note bad" role="alert">
                O projeto, as tarefas e o histórico saem do app. A pasta e as worktrees no disco
                ficam como estão.
              </p>
              <div className="modal-actions">
                <button
                  type="button"
                  className="ghost"
                  disabled={busy}
                  onClick={() => setConfirming(false)}
                >
                  Voltar
                </button>
                <button
                  type="button"
                  className="danger"
                  disabled={busy}
                  onClick={() => void run(() => store.removeProject(project.id))}
                >
                  Excluir de vez
                </button>
              </div>
            </>
          ) : (
            <button
              type="button"
              className="danger"
              disabled={busy}
              onClick={() => setConfirming(true)}
            >
              Excluir projeto
            </button>
          )}
        </section>

        <footer className="modal-actions">
          <button type="button" className="ghost" onClick={onClose}>
            Cancelar
          </button>
          <button
            type="submit"
            className="primary"
            disabled={busy || !trimmed || trimmed === project.name}
          >
            Salvar
          </button>
        </footer>
      </form>
    </div>
  )
}
