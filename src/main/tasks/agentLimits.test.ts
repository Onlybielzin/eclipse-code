import { describe, expect, it } from 'vitest'
import { DomainError, type Session } from '@shared/domain'
import { assertAgentCapacity, liveSessions } from './agentLimits'

function session(id: string, partial: Partial<Session> = {}): Session {
  return {
    id,
    taskId: 't1',
    subtaskId: 's',
    roleId: 'r',
    kind: 'member-acp',
    provider: 'claude',
    model: null,
    cwd: '/wt',
    providerSessionId: null,
    pid: null,
    status: 'running',
    activeTurnId: null,
    startedAt: 1,
    endedAt: null,
    endReason: null,
    exitCode: null,
    ...partial,
  }
}

const limits = { maxLiveMembersPerTask: 2, maxLiveAgents: 3 }

describe('limite de agentes', () => {
  it('conta só sessões abertas cujo processo está vivo', () => {
    const open = [
      session('vivo'),
      session('morto-no-runtime'),
      session('encerrada', { status: 'exited' }),
    ]
    const alive = new Set(['vivo', 'encerrada'])
    expect(liveSessions(open, { isAlive: (s) => alive.has(s.id) }).map((s) => s.id)).toEqual([
      'vivo',
    ])
  })

  it('recusa membro além do limite por tarefa, mas aceita em outra tarefa', () => {
    const open = [session('a'), session('b')]
    const liveness = { isAlive: () => true }
    expect(() =>
      assertAgentCapacity({ limits, kind: 'member', taskId: 't1', openSessions: open, liveness }),
    ).toThrow(DomainError)
    expect(
      assertAgentCapacity({ limits, kind: 'member', taskId: 't2', openSessions: open, liveness }),
    ).toEqual({ liveAgents: 2, liveMembersInTask: 0 })
    // Membro morto no runtime libera a vaga.
    expect(
      assertAgentCapacity({
        limits,
        kind: 'member',
        taskId: 't1',
        openSessions: open,
        liveness: { isAlive: (s) => s.id === 'a' },
      }).liveMembersInTask,
    ).toBe(1)
  })

  it('recusa qualquer agente além do limite do app, exceto a sessão sendo retomada', () => {
    const open = [
      session('l1', { kind: 'leader-pty', subtaskId: null, taskId: 't9' }),
      session('a'),
      session('b', { taskId: 't2' }),
    ]
    const liveness = { isAlive: () => true }
    try {
      assertAgentCapacity({ limits, kind: 'leader', taskId: 't3', openSessions: open, liveness })
      throw new Error('deveria recusar')
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError)
      expect((error as DomainError).code).toBe('unavailable')
      expect((error as DomainError).message).toContain('limite de agentes vivos')
    }
    expect(
      assertAgentCapacity({
        limits,
        kind: 'leader',
        taskId: 't9',
        openSessions: open,
        liveness,
        reuseSessionId: 'l1',
      }).liveAgents,
    ).toBe(2)
  })
})
