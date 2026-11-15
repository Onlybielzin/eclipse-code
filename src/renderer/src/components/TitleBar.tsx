import { useMemo, useState } from 'react'
import { AddProjectModal } from './AddProjectModal'
import { WhatsNewModal } from './WhatsNewModal'
import { ProjectPicker } from './ProjectPicker'
import { openQuestions } from '../store/format'
import { useAppState, useStore } from '../store/context'

/** Topo: seletor de projeto (Ctrl+O) e o contador "precisa de você". */
export function TitleBar() {
  const store = useStore()
  const questions = useAppState((s) => s.questions)
  const tasks = useAppState((s) => s.tasks)
  const open = useMemo(() => openQuestions(questions), [questions])
  const [adding, setAdding] = useState(false)
  const update = useAppState((s) => s.update)
  const whatsNew = useAppState((s) => s.whatsNew)
  const wallOpen = useAppState((s) => s.wallOpen)

  const goToQuestion = () => {
    const q = open[0]
    if (!q) return
    if (q.subtaskId) void store.selectSubtask(q.subtaskId)
    else if (tasks.some((t) => t.id === q.taskId)) store.selectTask(q.taskId, false)
  }

  const restart = () => {
    const message = `Fechar o app instala a versão ${update.version} e para os agentes em andamento. Abra o app de novo depois. Continuar?`
    if (window.confirm(message)) {
      void store.installUpdate()
    }
  }

  return (
    <header className="titlebar">
      <b className="brand">
        <span className="logo" aria-hidden="true" />
        Eclipse Code
      </b>
      <ProjectPicker onAddProject={() => setAdding(true)} />
      {adding && <AddProjectModal onClose={() => setAdding(false)} />}
      {update.status === 'downloading' && <small className="muted">Baixando atualização</small>}
      {update.status === 'ready' && (
        <button type="button" className="ghost" data-testid="update-ready" onClick={restart}>
          Versão {update.version} pronta · Fechar e instalar
        </button>
      )}
      <button
        type="button"
        className={`need ${open.length === 0 ? 'none' : ''}`}
        data-testid="need-you"
        disabled={open.length === 0}
        onClick={goToQuestion}
      >
        <span className="need-n">{open.length}</span> precisa{open.length === 1 ? '' : 'm'} de você{' '}
        <span className="need-go" aria-hidden="true">
          ›
        </span>
      </button>
      <button
        type="button"
        className="icon-btn wall-btn"
        aria-label="Parede"
        title="Parede"
        aria-pressed={wallOpen}
        onClick={() => store.setWallOpen(!wallOpen)}
      >
        <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
          <rect x="2" y="2" width="5" height="5" rx="1" />
          <rect x="9" y="2" width="5" height="5" rx="1" />
          <rect x="2" y="9" width="5" height="5" rx="1" />
          <rect x="9" y="9" width="5" height="5" rx="1" />
        </svg>
      </button>
      <button
        type="button"
        className="icon-btn"
        aria-label="Configurações"
        title="Configurações"
        onClick={() => store.setSettingsOpen(true)}
      >
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
          <circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <path
            d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        </svg>
      </button>
      {whatsNew && <WhatsNewModal whatsNew={whatsNew} />}
    </header>
  )
}
