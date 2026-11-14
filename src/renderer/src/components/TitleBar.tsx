import { useMemo, useState } from 'react'
import { AddProjectModal } from './AddProjectModal'
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

  const goToQuestion = () => {
    const q = open[0]
    if (!q) return
    if (q.subtaskId) void store.selectSubtask(q.subtaskId)
    else if (tasks.some((t) => t.id === q.taskId)) store.selectTask(q.taskId)
  }

  return (
    <header className="titlebar">
      <b className="brand">
        <span className="logo" aria-hidden="true" />
        Eclipse Code
      </b>
      <ProjectPicker onAddProject={() => setAdding(true)} />
      {adding && <AddProjectModal onClose={() => setAdding(false)} />}
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
    </header>
  )
}
