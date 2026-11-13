import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { PickedFolder } from '@shared/ipc'
import { useStore } from '../store/context'

/**
 * Modal "Adicionar projeto": o botão abre o explorador de pastas do sistema,
 * a pasta escolhida aparece com o nome sugerido e o aviso de git, e Adicionar grava.
 */
export function AddProjectModal({ onClose }: { onClose: () => void }) {
  const store = useStore()
  const [folder, setFolder] = useState<PickedFolder | null>(null)
  const [name, setName] = useState('')
  const [picking, setPicking] = useState(false)
  const [saving, setSaving] = useState(false)
  const pickButton = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    pickButton.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const pick = async () => {
    setPicking(true)
    try {
      const picked = await store.pickProjectFolder()
      if (picked) {
        setFolder(picked)
        setName(picked.name)
      }
    } finally {
      setPicking(false)
    }
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!folder || folder.alreadyAdded) return
    setSaving(true)
    try {
      await store.addProject(folder.path, name)
      onClose()
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
        aria-labelledby="add-project-title"
        onSubmit={(e) => void submit(e)}
      >
        <header className="modal-head">
          <h2 id="add-project-title">Adicionar projeto</h2>
          <p>Escolha a pasta do repositório. Cada tarefa ganha uma worktree dele.</p>
        </header>

        <button
          ref={pickButton}
          type="button"
          className={`folder-pick ${folder ? 'chosen' : ''}`}
          onClick={() => void pick()}
          disabled={picking || saving}
        >
          <span className="folder-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="28" height="28">
              <path
                d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.6l2 2.2h8.4A1.5 1.5 0 0 1 21 8.7v9.8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          {folder ? (
            <span className="folder-text">
              <b>{folder.name}</b>
              <code title={folder.path}>{folder.path}</code>
              <small>Clique para trocar a pasta</small>
            </span>
          ) : (
            <span className="folder-text">
              <b>{picking ? 'Abrindo o explorador...' : 'Escolher pasta'}</b>
              <small>Abre o explorador de arquivos</small>
            </span>
          )}
        </button>

        {folder?.alreadyAdded && (
          <p className="modal-note bad" role="alert">
            Essa pasta já é um projeto.
          </p>
        )}
        {folder && !folder.alreadyAdded && !folder.isGitRepo && (
          <p className="modal-note warn">
            Essa pasta não tem git. Dá para adicionar, mas as tarefas precisam de um repositório
            para criar a worktree.
          </p>
        )}
        {folder && !folder.alreadyAdded && folder.isGitRepo && (
          <p className="modal-note ok">Repositório git encontrado.</p>
        )}

        {folder && !folder.alreadyAdded && (
          <label className="modal-field">
            <span>Nome do projeto</span>
            <input
              className="field"
              value={name}
              maxLength={200}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
        )}

        <footer className="modal-actions">
          <button type="button" className="ghost" onClick={onClose}>
            Cancelar
          </button>
          <button
            type="submit"
            className="primary"
            disabled={!folder || folder.alreadyAdded || saving || !name.trim()}
          >
            {saving ? 'Adicionando...' : 'Adicionar projeto'}
          </button>
        </footer>
      </form>
    </div>
  )
}
