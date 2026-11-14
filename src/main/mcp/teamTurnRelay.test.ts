import { describe, expect, it, vi } from 'vitest'
import type { LeaderRelay } from '@shared/ports'
import {
  composeTurnNotice,
  createMemoryLeaderNoticeStore,
  startTeamTurnRelay,
} from './teamTurnRelay'
import type { McpCaller } from '@shared/mcp'
import { createMcpToolHandler } from './toolHandler'
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

describe('aviso de subtarefa que o Lider ja viu', () => {
  const leader: McpCaller = { role: 'leader', sessionId: 'L1', taskId: 'task1', subtaskId: null }
  function setup() {
    const tasks = createFakeTaskService()
    const { relay, sent } = relaySpy()
    const team = startTeamTurnRelay({ tasks, relay, now: () => 1_000 })
    const actions = { createSubtask: vi.fn(), answerSubtask: vi.fn(), cancelSubtask: vi.fn() }
    const handler = createMcpToolHandler({ tasks, actions, notices: team })
    return { tasks, team, handler, sent }
  }

  it('membro termina com o Lider em subtarefas_esperar: nenhum aviso fica', async () => {
    const { tasks, team, handler, sent } = setup() // sem Lider vivo: aviso so ficaria pendente
    tasks.seedSubtask({ id: 'a', state: 'working' })
    const waiting = handler.callTool(leader, 'subtarefas_esperar', {})
    tasks.setState('a', 'completed')
    tasks.endTurn({ id: 'ta', subtaskId: 'a' })
    await waiting
    await team.idle()
    expect(team.pending('task1')).toEqual([])
    expect(sent).toHaveLength(0)
    team.stop()
  })

  it('membro termina sem o Lider esperar: aviso continua sendo entregue', async () => {
    const { tasks, team, sent } = setup()
    tasks.sessions.set('L1', leaderSession('L1'))
    tasks.seedSubtask({ id: 'a', state: 'completed' })
    tasks.endTurn({ id: 'ta', subtaskId: 'a' })
    await team.idle()
    expect(sent).toHaveLength(1)
    team.stop()
  })

  it('subtarefas_ver descarta o aviso que ja estava na fila; subtarefa em andamento nao', async () => {
    const { tasks, team, handler } = setup()
    tasks.seedSubtask({ id: 'a', state: 'completed' })
    tasks.seedSubtask({ id: 'b', state: 'completed' })
    tasks.endTurn({ id: 'ta', subtaskId: 'a' })
    tasks.endTurn({ id: 'tb', subtaskId: 'b' })
    await team.idle()
    expect(team.pending('task1')).toHaveLength(2)
    tasks.setState('b', 'working')
    await handler.callTool(leader, 'subtarefas_ver', { subtarefa_id: 'a' })
    await handler.callTool(leader, 'subtarefas_ver', { subtarefa_id: 'b' })
    expect(team.pending('task1')).toHaveLength(1)
    expect(team.pending('task1')[0]).toContain('Subtarefa b')
    team.stop()
  })

  it('turno que termina depois de o Lider ver a subtarefa ainda avisa', async () => {
    const { tasks, team, sent } = setup()
    tasks.sessions.set('L1', leaderSession('L1'))
    tasks.seedSubtask({ id: 'a', state: 'completed' })
    team.markSubtasksSeen('task1', ['a'])
    tasks.endTurn({ id: 'tb', subtaskId: 'a', endedAt: 2_000 })
    await team.idle()
    expect(sent).toHaveLength(1)
    team.stop()
  })
})

describe('notify de subtarefa que o Lider ja viu', () => {
  it('nao enfileira depois da visao, mas enfileira transicao nova depois de visao antiga', async () => {
    const tasks = createFakeTaskService()
    let clock = 1_000
    const { relay } = relaySpy()
    const team = startTeamTurnRelay({ tasks, relay, now: () => clock, retryIntervalMs: 0 })
    tasks.seedSubtask({ id: 'a', state: 'failed', updatedAt: 50_000 }) // transicao
    clock = 100_000
    team.markSubtasksSeen('task1', ['a'])
    team.notify('task1', 'membro parou', 'a')
    expect(team.pending('task1')).toEqual([])
    clock = 200_000
    tasks.seedSubtask({ id: 'a', state: 'failed', updatedAt: 150_000 }) // transicao nova
    team.notify('task1', 'membro parou de novo', 'a')
    expect(team.pending('task1')).toEqual(['membro parou de novo'])
    team.stop()
  })
})

describe('aviso pelo gancho (relay.offer)', () => {
  function boxRelay() {
    const pasted: string[] = []
    const boxed: { id: number; text: string }[] = []
    const offered: { id: number; text: string }[][] = []
    let working = true
    const relay: LeaderRelay = {
      async offer(_s, notices) {
        offered.push([...notices])
        if (working) {
          for (const n of notices) if (!boxed.some((b) => b.id === n.id)) boxed.push(n)
          return []
        }
        boxed.length = 0
        return [...notices]
      },
      async deliver(_s, text) {
        pasted.push(text)
        return { delivered: true, attempts: 1 }
      },
    }
    return { relay, pasted, boxed, offered, setWorking: (value: boolean) => void (working = value) }
  }

  function listeners() {
    const set = new Set<(e: { type: string; sessionId: string; activity?: string; ids?: number[] }) => void>()
    return {
      leaderEvents: {
        onEvent(l: (e: never) => void) {
          set.add(l as never)
          return () => set.delete(l as never)
        },
      },
      emit: (e: { type: string; sessionId: string; activity?: string; ids?: number[] }) =>
        set.forEach((l) => l(e)),
    }
  }

  it('Lider trabalhando: vai para a caixa, nao cola e so sai da fila com notices-delivered', async () => {
    const tasks = createFakeTaskService()
    tasks.sessions.set('L1', leaderSession('L1'))
    const box = boxRelay()
    const events = listeners()
    const notices = createMemoryLeaderNoticeStore()
    const team = startTeamTurnRelay({
      tasks,
      relay: box.relay,
      notices,
      retryIntervalMs: 0,
      leaderEvents: events.leaderEvents,
    })
    team.notify('task1', 'aviso 1')
    await team.idle()
    expect(box.pasted).toEqual([])
    expect(box.boxed.map((n) => n.text)).toEqual(['aviso 1'])
    expect(team.pending('task1')).toEqual(['aviso 1'])

    events.emit({ type: 'notices-delivered', sessionId: 'L1', ids: [box.boxed[0]!.id] })
    await team.idle()
    expect(team.pending('task1')).toEqual([])
    expect(box.pasted).toEqual([])
    team.stop()
  })

  it('Lider ocioso: cola como antes e confirma pela colagem', async () => {
    const tasks = createFakeTaskService()
    tasks.sessions.set('L1', leaderSession('L1'))
    const box = boxRelay()
    box.setWorking(false)
    const team = startTeamTurnRelay({ tasks, relay: box.relay, retryIntervalMs: 0 })
    team.notify('task1', 'aviso 1')
    team.notify('task1', 'aviso 2')
    await team.idle()
    expect(box.pasted).toEqual(['aviso 1', 'aviso 2'])
    expect(team.pending('task1')).toEqual([])
    team.stop()
  })

  it('Lider passa de trabalhando a ocioso com aviso na caixa: o evento idle cola o pendente', async () => {
    const tasks = createFakeTaskService()
    tasks.sessions.set('L1', leaderSession('L1'))
    const box = boxRelay()
    const events = listeners()
    const team = startTeamTurnRelay({
      tasks,
      relay: box.relay,
      retryIntervalMs: 0,
      leaderEvents: events.leaderEvents,
    })
    team.notify('task1', 'aviso 1')
    await team.idle()
    box.setWorking(false)
    events.emit({ type: 'activity', sessionId: 'L1', activity: 'idle' })
    await team.idle()
    expect(box.pasted).toEqual(['aviso 1'])
    expect(team.pending('task1')).toEqual([])
    team.stop()
  })

  it('subtarefa vista descarta o aviso e reoferece o que sobrou (limpa a caixa)', async () => {
    const tasks = createFakeTaskService()
    tasks.sessions.set('L1', leaderSession('L1'))
    const box = boxRelay()
    const team = startTeamTurnRelay({ tasks, relay: box.relay, retryIntervalMs: 0 })
    team.notify('task1', 'aviso a', 'a')
    team.notify('task1', 'aviso b', 'b')
    await team.idle()
    expect(box.boxed).toHaveLength(2)
    team.markSubtasksSeen('task1', ['a'])
    await team.idle()
    expect(team.pending('task1')).toEqual(['aviso b'])
    expect(box.offered.at(-1)?.map((n) => n.text)).toEqual(['aviso b'])
    team.stop()
  })
})
