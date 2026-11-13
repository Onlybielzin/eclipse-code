import { useMemo, useState, type FormEvent } from 'react'
import { openQuestions } from '../store/format'
import { useAppState, useStore } from '../store/context'

/** Topo: projeto aberto e o contador "precisa de você". */
export function TitleBar() {
  const store = useStore()
  const projects = useAppState((s) => s.projects)
  const projectId = useAppState((s) => s.projectId)
  const questions = useAppState((s) => s.questions)
  const tasks = useAppState((s) => s.tasks)
  const open = useMemo(() => openQuestions(questions), [questions])
  const [adding, setAdding] = useState(false)
  const [path, setPath] = useState('')

  const goToQuestion = () => {
    const q = open[0]
    if (!q) return
    if (q.subtaskId) void store.selectSubtask(q.subtaskId)
    else if (tasks.some((t) => t.id === q.taskId)) store.selectTask(q.taskId)
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const value = path.trim()
    if (!value) return
    await store.addProject(value)
    setPath('')
    setAdding(false)
  }

  return (
    <header className="titlebar">
      <b>Eclipse Code</b>
      {projects.length > 0 && (
        <select
          className="proj"
          aria-label="Projeto"
          value={projectId ?? ''}
          onChange={(e) => void store.openProject(e.target.value || null)}
        >
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      )}
      {adding ? (
        <form className="addproj" onSubmit={(e) => void submit(e)}>
          <input
            className="field"
            autoFocus
            aria-label="Pasta do projeto"
            placeholder="/caminho/do/repositorio"
            value={path}
            onChange={(e) => setPath(e.target.value)}
          />
          <button type="submit" className="primary">
            Adicionar
          </button>
          <button type="button" className="ghost" onClick={() => setAdding(false)}>
            Cancelar
          </button>
        </form>
      ) : (
        <button type="button" className="linkish" onClick={() => setAdding(true)}>
          + projeto
        </button>
      )}
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
