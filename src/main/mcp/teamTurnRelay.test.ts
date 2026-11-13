import { describe, expect, it, vi } from 'vitest'
import type { LeaderRelay } from '@shared/ports'
import {
  composeTurnNotice,
  createMemoryLeaderNoticeStore,
  startTeamTurnRelay,
} from './teamTurnRelay'
import { createFakeTaskService, leaderSession } from './testing/fakeTaskService'

function relaySpy(delivered = true) {
  const sent: { sessionId: string; text: string }[] = []
  const relay: LeaderRelay = {
    deliver: vi.fn(async (sessionId: string, text: string) => {
      sent.push({ sessionId, text })
      return { delivered, attempts: 1 }
    }),
  }
  return { relay, sent }
}

describe('composeTurnNotice', () => {
  it('uma linha com id, papel, estado e resumo cortado', () => {
    const tasks = createFakeTaskService()
    const subtask = tasks.seedSubtask({ id: 'sub1', state: 'completed', title: 'Login' })
    const text = composeTurnNotice({
      subtask,
      roleName: 'Dev',
      turn: tasks.endTurn({ id: 't1', subtaskId: 'sub1' }),
      delivery: tasks.addArtifact('sub1', 't1', { summary: `feito\n\n${'x'.repeat(1000)}` }),
    })
    expect(text).not.toContain('\n')
    expect(text).toContain('Subtarefa sub1 (Dev: Login) terminou o turno: pronto.')
    expect(text.length).toBeLessThan(450)
  })

  it('erro do turno aparece no aviso e entrega sem formato e marcada', () => {
    const tasks = createFakeTaskService()
    const subtask = tasks.seedSubtask({
      id: 'sub1',
      state: 'failed',
      statusMessage: 'bloqueado: sem resposta',
    })
    const text = composeTurnNotice({
      subtask,
      roleName: 'Dev',
      turn: tasks.endTurn({
        id: 't1',
        subtaskId: 'sub1',
        stopReason: null,
        error: { code: 'silent_timeout', message: 'sem eventos' },
      }),
      delivery: null,
    })
    expect(text).toContain('bloqueado (sem resposta)')
    expect(text).toContain('bloqueado: sem resposta')
    const sem = composeTurnNotice({
      subtask: tasks.setState('sub1', 'failed'),
      roleName: 'Dev',
      turn: tasks.endTurn({ id: 't2', subtaskId: 'sub1' }),
      delivery: tasks.addArtifact('sub1', 't2', { summary: 's' }, 'unformatted'),
    })
    expect(sem).toContain('[entrega sem formato]')
  })
})

describe('startTeamTurnRelay', () => {
  it('fim de turno vai ao Lider vivo da tarefa, uma vez por turno', async () => {
    const tasks = createFakeTaskService()
    tasks.sessions.set('L1', leaderSession('L1'))
    const { relay, sent } = relaySpy()
    const team = startTeamTurnRelay({ tasks, relay })
    tasks.seedSubtask({ id: 'sub1', roleId: 'rev', state: 'working' })
    tasks.addArtifact('sub1', 't1', { summary: 'revisado, 2 achados' })
    tasks.setState('sub1', 'completed')
    const turn = tasks.endTurn({ id: 't1', subtaskId: 'sub1' })
    tasks.emit({ type: 'turn.upserted', turn }) // repetido
    tasks.endTurn({ id: 't0', subtaskId: 'sub1', endedAt: null }) // turno aberto: ignora
    await team.idle()
    expect(sent).toHaveLength(1)
    expect(sent[0]?.sessionId).toBe('L1')
    expect(sent[0]?.text).toContain('sub1 (Revisor')
    expect(sent[0]?.text).toContain('pronto')
    expect(sent[0]?.text).toContain('revisado, 2 achados')
    team.stop()
  })

  it('sem Lider vivo guarda em ordem e entrega quando ele volta', async () => {
    const tasks = createFakeTaskService()
    const { relay, sent } = relaySpy()
    const team = startTeamTurnRelay({ tasks, relay })
    tasks.seedSubtask({ id: 'a', state: 'completed' })
    tasks.seedSubtask({ id: 'b', state: 'input_required' })
    tasks.endTurn({ id: 'ta', subtaskId: 'a' })
    tasks.endTurn({ id: 'tb', subtaskId: 'b' })
    await team.idle()
    expect(sent).toHaveLength(0)
    expect(team.pending('task1')).toHaveLength(2)

    const session = leaderSession('L2')
    tasks.sessions.set('L2', session)
    tasks.emit({ type: 'session.upserted', session })
    await team.idle()
    expect(sent.map((s) => s.text.match(/Subtarefa (\w+)/)?.[1])).toEqual(['a', 'b'])
    expect(team.pending('task1')).toHaveLength(0)
    team.stop()
  })

  it('Lider ocupado demais: aviso fica na fila e sai antes do proximo', async () => {
    const tasks = createFakeTaskService()
    tasks.sessions.set('L1', leaderSession('L1'))
    let accept = false
    const sent: string[] = []
    const relay: LeaderRelay = {
      async deliver(_s, text) {
        if (!accept) return { delivered: false, attempts: 3 }
        sent.push(text)
        return { delivered: true, attempts: 1 }
      },
    }
    const team = startTeamTurnRelay({ tasks, relay })
    tasks.seedSubtask({ id: 'a', state: 'completed' })
    tasks.seedSubtask({ id: 'b', state: 'completed' })
    tasks.endTurn({ id: 'ta', subtaskId: 'a' })
    await team.idle()
    expect(team.pending('task1')).toHaveLength(1)
    accept = true
    tasks.endTurn({ id: 'tb', subtaskId: 'b' })
    await team.idle()
    expect(sent.map((t) => t.match(/Subtarefa (\w+)/)?.[1])).toEqual(['a', 'b'])
    team.stop()
  })

  it('stop para de ouvir', async () => {
    const tasks = createFakeTaskService()
    tasks.sessions.set('L1', leaderSession('L1'))
    const { relay, sent } = relaySpy()
    const team = startTeamTurnRelay({ tasks, relay })
    team.stop()
    tasks.seedSubtask({ id: 'a', state: 'completed' })
    tasks.endTurn({ id: 'ta', subtaskId: 'a' })
    await team.idle()
    expect(sent).toHaveLength(0)
  })

  it('aviso parado volta a andar quando o Líder fica ocioso (evento activity)', async () => {
    const tasks = createFakeTaskService()
    tasks.sessions.set('L1', leaderSession('L1'))
    let accept = false
    const sent: string[] = []
    const relay: LeaderRelay = {
      async deliver(_s, text) {
        if (!accept) return { delivered: false, attempts: 600 }
        sent.push(text)
        return { delivered: true, attempts: 1 }
      },
    }
    const listeners = new Set<
      (e: { type: 'activity'; sessionId: string; activity: string }) => void
    >()
    const team = startTeamTurnRelay({
      tasks,
      relay,
      retryIntervalMs: 0,
      leaderEvents: {
        onEvent(listener) {
          listeners.add(listener as never)
          return () => listeners.delete(listener as never)
        },
      },
    })
    tasks.seedSubtask({ id: 'a', state: 'completed' })
    tasks.endTurn({ id: 'ta', subtaskId: 'a' })
    await team.idle()
    expect(team.pending('task1')).toHaveLength(1)

    // Nenhum membro termina mais turno e o Líder continua 'running': só o ocioso destrava.
    accept = true
    for (const l of listeners) l({ type: 'activity', sessionId: 'L1', activity: 'idle' })
    await team.idle()
    expect(sent.map((t) => t.match(/Subtarefa (\w+)/)?.[1])).toEqual(['a'])
    expect(team.pending('task1')).toHaveLength(0)
    team.stop()
  })

  it('tentativa periódica entrega o aviso parado mesmo sem nenhum evento', async () => {
    const tasks = createFakeTaskService()
    tasks.sessions.set('L1', leaderSession('L1'))
    let accept = false
    const sent: string[] = []
    const relay: LeaderRelay = {
      async deliver(_s, text) {
        if (!accept) return { delivered: false, attempts: 600 }
        sent.push(text)
        return { delivered: true, attempts: 1 }
      },
    }
    const team = startTeamTurnRelay({ tasks, relay, retryIntervalMs: 20 })
    tasks.seedSubtask({ id: 'a', state: 'completed' })
    tasks.endTurn({ id: 'ta', subtaskId: 'a' })
    await team.idle()
    expect(team.pending('task1')).toHaveLength(1)
    accept = true
    const until = Date.now() + 2_000
    while (sent.length === 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 10))
    await team.idle()
    expect(sent).toHaveLength(1)
    team.stop()
  })

  it('notify entra na mesma fila durável e sobrevive a um relay novo (reinício)', async () => {
    const tasks = createFakeTaskService()
    const notices = createMemoryLeaderNoticeStore()
    const { relay, sent } = relaySpy()
    const first = startTeamTurnRelay({ tasks, relay, notices, retryIntervalMs: 0 })
    first.notify('task1', '[eclipse] resposta do usuário')
    await first.idle()
    expect(sent).toHaveLength(0) // sem Líder vivo
    first.stop()

    const second = startTeamTurnRelay({ tasks, relay, notices, retryIntervalMs: 0 })
    const session = leaderSession('L9')
    tasks.sessions.set('L9', session)
    tasks.emit({ type: 'session.upserted', session })
    await second.idle()
    expect(sent).toEqual([{ sessionId: 'L9', text: '[eclipse] resposta do usuário' }])
    expect(notices.listPendingLeaderNotices('task1')).toEqual([])
    second.stop()
  })
})
