import { useEffect, useState, type FormEvent } from 'react'
import { DEFAULT_BRANCH_PREFIX, slugify } from '@shared/branch'
import { PROVIDER_LABELS, PROVIDERS, type Provider } from '@shared/domain'
import { MAX_DESCRIPTION_CHARS } from '@shared/schemas'
import { useAppState, useStore } from '../store/context'

type Kind = 'team' | 'solo' | 'term'

const KINDS: { id: Kind; icon: string; label: string; hint: string }[] = [
  {
    id: 'team',
    icon: 'L',
    label: 'Com Líder e time',
    hint: 'O Líder divide o trabalho em subtarefas.',
  },
  { id: 'solo', icon: 'A', label: 'Agente avulso', hint: 'Um Claude ou Codex, só você e ele.' },
  { id: 'term', icon: '$', label: 'Terminal', hint: 'Shell comum, sem agente.' },
]

/** Modal "Nova tarefa": 3 cartões de tipo, nome, onde roda, agente e prévia do que será criado. */
export function NewTaskModal({ onClose }: { onClose: () => void }) {
  const store = useStore()
  const project = useAppState((s) => s.projects.find((p) => p.id === s.projectId) ?? null)
  const [kind, setKind] = useState<Kind>('team')
  // null = padrão do tipo; depois que o usuário escolhe, a escolha vale para os 3 tipos.
  const [picked, setPicked] = useState<boolean | null>(null)
  const worktree = picked ?? kind !== 'term'
  const [provider, setProvider] = useState<Provider>('claude')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [base, setBase] = useState('')
  const [busy, setBusy] = useState(false)
  const name = title.trim()
  const baseBranch = base.trim()
  const canCreate = name !== '' && !busy

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const submit = async (e?: FormEvent) => {
    e?.preventDefault()
    if (!canCreate) return
    setBusy(true)
    try {
      const task = await store.createTask({
        title: name,
        ...(description.trim() ? { description: description.trim() } : {}),
        kind: kind === 'team' ? 'team' : 'solo',
        useWorktree: worktree,
        ...(kind === 'solo' ? { soloProvider: provider } : {}),
        ...(worktree && baseBranch ? { baseBranch } : {}),
      })
      if (task) onClose()
    } finally {
      setBusy(false)
    }
  }

  const agent = PROVIDER_LABELS[provider]
  const second =
    kind === 'team'
      ? 'Abre o Líder com o prompt da tarefa'
      : kind === 'solo'
        ? `Abre o ${agent}, à espera do que você digitar`
        : 'Abre só o shell. Não ocupa vaga de agente'

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <form
        className="modal newtask-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-task-title"
        onSubmit={(e) => void submit(e)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && e.ctrlKey) void submit()
        }}
      >
        <header className="modal-head">
          <h2 id="new-task-title">Nova tarefa</h2>
          <p>Projeto: {project?.name ?? ''}</p>
        </header>

        <div className="nt-types" role="radiogroup" aria-label="Tipo">
          {KINDS.map((k) => (
            <button
              key={k.id}
              type="button"
              className="nt-type"
              role="radio"
              aria-checked={kind === k.id}
              onClick={() => setKind(k.id)}
            >
              <span className={`nt-ic ${k.id}`} aria-hidden="true">
                {k.icon}
              </span>
              <b>{k.label}</b>
              <small>{k.hint}</small>
            </button>
          ))}
        </div>

        <label className="modal-field">
          <span>Título</span>
          <input
            className="field"
            autoFocus
            value={title}
            maxLength={200}
            placeholder="ex: relatório por oferta"
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>

        <label className="modal-field">
          <span>Descrição</span>
          <textarea
            className="field"
            rows={4}
            value={description}
            maxLength={MAX_DESCRIPTION_CHARS}
            placeholder="Detalhes do pedido (opcional). O agente lê o título e a descrição para nomear a tarefa."
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>

        <div className="nt-row">
          <div className="modal-field">
            <span id="nt-where">Onde roda</span>
            <div className="nt-seg" role="radiogroup" aria-labelledby="nt-where">
              <button
                type="button"
                role="radio"
                aria-checked={worktree}
                onClick={() => setPicked(true)}
              >
                Worktree nova
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={!worktree}
                onClick={() => setPicked(false)}
              >
                Pasta do projeto
              </button>
            </div>
          </div>
          {kind === 'solo' && (
            <div className="modal-field">
              <span id="nt-agent">Agente</span>
              <div className="nt-seg" role="radiogroup" aria-labelledby="nt-agent">
                {PROVIDERS.map((p) => (
                  <button
                    key={p}
                    type="button"
                    role="radio"
                    aria-checked={provider === p}
                    onClick={() => setProvider(p)}
                  >
                    {PROVIDER_LABELS[p]}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {worktree && (
          <details className="nt-more">
            <summary>Mais opções</summary>
            <label className="modal-field">
              <span>Branch de origem</span>
              <input
                className="field"
                value={base}
                placeholder="branch padrão do projeto"
                onChange={(e) => setBase(e.target.value)}
              />
            </label>
          </details>
        )}

        <div className="nt-preview" data-testid="new-task-preview">
          <span>
            {worktree
              ? `Cria a branch ${DEFAULT_BRANCH_PREFIX}${slugify(name)} a partir de ${baseBranch || 'branch padrão'}`
              : `Roda em ${project?.rootPath ?? ''}, sem worktree`}
          </span>
          <span>{second}</span>
          {!worktree && kind !== 'term' && (
            <span className="nt-warn">
              {kind === 'team'
                ? 'O Líder e os membros mexem direto na branch atual do projeto'
                : 'O agente mexe direto na branch atual do projeto'}
            </span>
          )}
        </div>

        <footer className="modal-actions">
          <span className="nt-keys">Ctrl Enter cria · Esc fecha</span>
          <button type="button" className="ghost" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="primary" disabled={!canCreate}>
            {busy ? 'Criando...' : 'Criar tarefa'}
          </button>
        </footer>
      </form>
    </div>
  )
}
