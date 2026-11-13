import { useEffect, useRef, useState } from 'react'
import type { Task } from '@shared/domain'
import { useStore } from '../store/context'
import { createXterm } from '../terminal/createXterm'

type Phase =
  | { kind: 'connecting' }
  | { kind: 'live'; sessionId: string }
  | { kind: 'exited'; exitCode: number | null }
  | { kind: 'error'; message: string }

/**
 * Terminal do Lider (ou do avulso). Garante a sessao com leader.ensure, repinta o
 * scrollback do main e depois segue os eventos terminal.data dessa sessao.
 *
 * Ordem: assina terminal.data antes do attach e guarda o que chegar ate o attach
 * responder; escreve scrollback e depois o guardado. Assim nada se perde no meio.
 */
export function LeaderTerminal({ task }: { task: Task }) {
  const store = useStore()
  const hostRef = useRef<HTMLDivElement | null>(null)
  const [phase, setPhase] = useState<Phase>({ kind: 'connecting' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const api = store.api
    let disposed = false
    let sessionId: string | null = null
    let attached = false
    const pending: string[] = []
    let lastSize = { cols: 0, rows: 0 }
    setPhase({ kind: 'connecting' })

    const term = createXterm(host)

    const offData = api.on('terminal.data', (p) => {
      if (p.sessionId !== sessionId) return
      if (attached) term.write(p.data)
      else pending.push(p.data)
    })
    const offExit = api.on('terminal.exit', (p) => {
      if (p.sessionId !== sessionId) return
      setPhase({ kind: 'exited', exitCode: p.exitCode })
    })
    const offInput = term.onData((data) => {
      if (sessionId === null) return
      void api.invoke('terminal.write', { sessionId, data })
    })

    const syncSize = () => {
      const size = term.fit()
      if (!size || sessionId === null) return
      if (size.cols === lastSize.cols && size.rows === lastSize.rows) return
      if (size.cols < 2 || size.rows < 1) return
      lastSize = size
      void api.invoke('terminal.resize', { sessionId, cols: size.cols, rows: size.rows })
    }
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => syncSize())
    observer?.observe(host)

    void (async () => {
      try {
        const session = await store.call('leader.ensure', { taskId: task.id })
        if (disposed) return
        sessionId = session.id
        const snap = await store.call('terminal.attach', { sessionId: session.id })
        if (disposed) return
        if (snap.scrollback) term.write(snap.scrollback)
        for (const chunk of pending.splice(0)) term.write(chunk)
        attached = true
        lastSize = { cols: snap.cols, rows: snap.rows }
        setPhase(
          snap.alive ? { kind: 'live', sessionId: session.id } : { kind: 'exited', exitCode: null },
        )
        syncSize()
        term.focus()
      } catch (error) {
        if (!disposed) {
          setPhase({
            kind: 'error',
            message: error instanceof Error ? error.message : String(error),
          })
        }
      }
    })()

    return () => {
      disposed = true
      observer?.disconnect()
      offData()
      offExit()
      offInput()
      term.dispose()
    }
  }, [store, task.id, attempt])

  return (
    <div className="term-wrap" data-testid="leader-terminal">
      {phase.kind !== 'live' && (
        <div className="term-status" role="status">
          {phase.kind === 'connecting' && 'Abrindo o terminal...'}
          {phase.kind === 'exited' && (
            <>
              {task.kind === 'team' ? 'O Líder saiu' : 'O agente saiu'}
              {phase.exitCode !== null ? ` (código ${phase.exitCode})` : ''}.{' '}
              <button type="button" onClick={() => setAttempt((n) => n + 1)}>
                Reabrir
              </button>
            </>
          )}
          {phase.kind === 'error' && (
            <>
              Não deu para abrir o terminal: {phase.message}{' '}
              <button type="button" onClick={() => setAttempt((n) => n + 1)}>
                Tentar de novo
              </button>
            </>
          )}
        </div>
      )}
      <div className="term-host" ref={hostRef} />
    </div>
  )
}
