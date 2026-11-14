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
        {open.length} precisa{open.length === 1 ? '' : 'm'} de você
      </button>
    </header>
  )
}
