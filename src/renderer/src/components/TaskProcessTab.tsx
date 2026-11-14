import { useEffect, useState } from 'react'
import type { Task } from '@shared/domain'
import type { TaskProcessState } from '@shared/ipc'
import { useStore } from '../store/context'
import { PtyTerminal, type PtyOpened } from './PtyTerminal'

const asOpened = (s: TaskProcessState): PtyOpened => ({
  sessionId: s.ptyId ?? '',
  alive: s.alive,
  cols: s.cols,
  rows: s.rows,
  scrollback: s.scrollback,
})

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** Aba Terminal: shell livre na pasta da tarefa; abre no primeiro clique. */
export function ShellTab({ task }: { task: Task }) {
  const store = useStore()
  const [run, setRun] = useState(0)
  const [exited, setExited] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [cwd, setCwd] = useState('')

  const open = async () => {
    let state = await store.call('taskProcess.attach', { taskId: task.id, kind: 'shell' })
    // Primeiro clique, ou "Novo shell" depois que o anterior saiu.
    if (!state.alive) {
      state = await store.call('taskProcess.start', {
        taskId: task.id,
        kind: 'shell',
        restart: false,
      })
    }
    setCwd(state.cwd)
    return asOpened(state)
  }

  return (
    <div className="term-wrap" data-testid="shell-terminal">
      <div className="term-status" role="status">
        {cwd && <span>Pasta: {cwd}</span>}
        {error && (
          <>
            <span role="alert">{error}</span>
            <button
              type="button"
              onClick={() => {
                setError(null)
                setRun((n) => n + 1)
              }}
            >
              Tentar de novo
            </button>
          </>
        )}
        {exited && (
          <>
            <span>O shell saiu.</span>
            <button
              type="button"
              onClick={() => {
                setExited(false)
                setError(null)
                setRun((n) => n + 1)
              }}
            >
              Novo shell
            </button>
          </>
        )}
      </div>
      <PtyTerminal
        key={`${task.id}:${run}`}
        open={open}
        onExit={() => setExited(true)}
        onError={(m) => setError(m)}
      />
    </div>
  )
}

/** Aba Iniciar: comando salvo por tarefa, com formulario, Iniciar, Reiniciar e Parar. */
export function StartTab({ task }: { task: Task }) {
  const store = useStore()
  const [proc, setProc] = useState<TaskProcessState | null>(null)
  const [editing, setEditing] = useState(false)
  const [command, setCommand] = useState(task.startCommand ?? '')
  const [dir, setDir] = useState(task.startDir ?? '')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let off = false
    setProc(null)
    store
      .call('taskProcess.attach', { taskId: task.id, kind: 'start' })
      .then((s) => !off && setProc(s))
      .catch((e) => !off && setError(message(e)))
    return () => {
      off = true
    }
  }, [store, task.id])

  // Trava os botoes enquanto o main nao responde (evita duplo clique).
  const run = async (restart: boolean) => {
    setError(null)
    setBusy(true)
    try {
      setProc(await store.call('taskProcess.start', { taskId: task.id, kind: 'start', restart }))
    } catch (e) {
      setError(message(e))
    } finally {
      setBusy(false)
    }
  }
  const stop = async () => {
    setBusy(true)
    try {
      await store.call('taskProcess.stop', { taskId: task.id, kind: 'start' })
    } catch (e) {
      setError(message(e))
    } finally {
      setBusy(false)
    }
  }
  const saveAndRun = async (event: React.FormEvent) => {
    event.preventDefault()
    setError(null)
    try {
      await store.call('tasks.setStartCommand', {
        taskId: task.id,
        command: command.trim() || null,
        dir: dir.trim() || null,
      })
      setEditing(false)
      if (command.trim()) await run(false)
    } catch (e) {
      setError(message(e))
    }
  }

  const alert = error && (
    <div className="term-status" role="alert">
      {error}
    </div>
  )

  if (editing || !task.startCommand) {
    return (
      <form className="proc-form" onSubmit={(e) => void saveAndRun(e)} data-testid="start-form">
        <h3>Como iniciar esta tarefa?</h3>
        <label className="lbl">
          Comando
          <input
            className="field"
            value={command}
            placeholder="pnpm dev"
            onChange={(e) => setCommand(e.target.value)}
            autoFocus
          />
        </label>
        <label className="lbl">
          Pasta (opcional, dentro da worktree)
          <input
            className="field"
            value={dir}
            placeholder="raiz da worktree"
            onChange={(e) => setDir(e.target.value)}
          />
        </label>
        {alert}
        <div className="proc-row">
          <button type="submit" className="primary" disabled={!command.trim()}>
            Salvar e iniciar
          </button>
          {task.startCommand && (
            <button type="button" className="ghost" onClick={() => setEditing(false)}>
              Cancelar
            </button>
          )}
        </div>
      </form>
    )
  }

  const log = proc?.ptyId && (
    <div className="term-wrap">
      <PtyTerminal
        key={proc.ptyId}
        interactive={proc.alive}
        open={async () =>
          asOpened(await store.call('taskProcess.attach', { taskId: task.id, kind: 'start' }))
        }
        onExit={(exitCode) =>
          setProc((p) => (p ? { ...p, alive: false, exited: true, exitCode } : p))
        }
      />
    </div>
  )

  if (proc?.alive) {
    return (
      <div className="term-wrap" data-testid="start-running">
        <div className="term-status" role="status">
          <span>rodando · {task.startCommand}</span>
          <button type="button" disabled={busy} onClick={() => void run(true)}>
            Reiniciar
          </button>
          <button type="button" disabled={busy} onClick={() => void stop()}>
            Parar
          </button>
        </div>
        {alert}
        {log}
      </div>
    )
  }

  return (
    <div className="term-wrap" data-testid="start-idle">
      <div className="proc-idle">
        <button
          type="button"
          className="primary proc-big"
          disabled={busy}
          onClick={() => void run(false)}
        >
          Iniciar
        </button>
        <div className="proc-cmd">
          <code>{task.startCommand}</code>
          {task.startDir ? ` · pasta ${task.startDir}` : ''} ·{' '}
          <button
            type="button"
            className="ghost"
            onClick={() => {
              setCommand(task.startCommand ?? '')
              setDir(task.startDir ?? '')
              setEditing(true)
            }}
          >
            Editar comando
          </button>
        </div>
        {proc?.exited && (
          <div className="proc-last">
            Último: parou{proc.exitCode !== null ? ` (código ${proc.exitCode})` : ''}
          </div>
        )}
        {alert}
      </div>
      {log}
    </div>
  )
}
