import { useState } from 'react'
import type { Task } from '@shared/domain'
import { useStore } from '../store/context'
import { PtyTerminal } from './PtyTerminal'

type Phase =
  | { kind: 'connecting' }
  | { kind: 'live' }
  | { kind: 'exited'; exitCode: number | null }
  | { kind: 'error'; message: string }

/**
 * Terminal do Lider (ou do avulso). Garante a sessao com leader.ensure, repinta o
 * scrollback do main (terminal.attach) e depois segue os eventos terminal.data.
 */
export function LeaderTerminal({ task }: { task: Task }) {
  const store = useStore()
  const [phase, setPhase] = useState<Phase>({ kind: 'connecting' })
  const [attempt, setAttempt] = useState(0)
  const retry = () => {
    setPhase({ kind: 'connecting' })
    setAttempt((n) => n + 1)
  }

  return (
    <div className="term-wrap" data-testid="leader-terminal">
      {phase.kind !== 'live' && (
        <div className="term-status" role="status">
          {phase.kind === 'connecting' && 'Abrindo o terminal...'}
          {phase.kind === 'exited' && (
            <>
              {task.kind === 'team' ? 'O Líder saiu' : 'O agente saiu'}
              {phase.exitCode !== null ? ` (código ${phase.exitCode})` : ''}.{' '}
              <button type="button" onClick={retry}>
                Reabrir
              </button>
            </>
          )}
          {phase.kind === 'error' && (
            <>
              Não deu para abrir o terminal: {phase.message}{' '}
              <button type="button" onClick={retry}>
                Tentar de novo
              </button>
            </>
          )}
        </div>
      )}
      <PtyTerminal
        key={`${task.id}:${attempt}`}
        open={async () => {
          const session = await store.call('leader.ensure', { taskId: task.id })
          return store.call('terminal.attach', { sessionId: session.id })
        }}
        onOpened={(o) => setPhase(o.alive ? { kind: 'live' } : { kind: 'exited', exitCode: null })}
        onExit={(exitCode) => setPhase({ kind: 'exited', exitCode })}
        onError={(message) => setPhase({ kind: 'error', message })}
      />
    </div>
  )
}
