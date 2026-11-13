// TeamCoordinator com SQLite em memoria e portas falsas (pty, Lider, membros, ponte).
// Nenhum processo real, nenhum modelo, nenhuma janela.
import { describe, expect, it } from 'vitest'
import type { Provider, SessionId, TaskId } from '@shared/domain'
import type {
  LeaderLaunchRequest,
  LeaderLaunchResult,
  McpBridgeServer,
  MemberRuntime,
  PtyHost,
  WorktreeService,
} from '@shared/ports'
import type { LeaderModule, LeaderSessionEvent } from '../leader'
import { startTeamTurnRelay } from '../mcp'
import { createHarness, seedTeam } from '../tasks/testing'
import { createIpcHandlers } from './ipcHandlers'
import { createIpcRouter } from './ipcRouter'
import { AppTeamCoordinator } from './teamCoordinator'

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function setup(options: { transcripts?: Set<string> } = {}) {
  const { service: tasks } = createHarness()
  const fx = seedTeam(tasks)
  const alive = new Set<string>()
  const killed: string[] = []
  let ptySeq = 0
  const ptyWrites: { ptyId: string; data: string }[] = []
  const ptyHost = {
    isAlive: (id: string) => alive.has(id),
    kill: (id: string) => {
      killed.push(id)
      alive.delete(id)
    },
    write: (ptyId: string, data: string) => {
      ptyWrites.push({ ptyId, data })
    },
    resize: () => undefined,
    size: () => null,
    scrollback: () => '',
  } as unknown as PtyHost

  const launches: LeaderLaunchRequest[] = []
  let gate: Deferred<void> | null = null
  const sessionListeners = new Set<(event: LeaderSessionEvent) => void>()
  const delivered: { sessionId: string; text: string }[] = []
  const transcripts = options.transcripts ?? new Set<string>()
  const leader = {
    launcher: {
      async launch(request: LeaderLaunchRequest): Promise<LeaderLaunchResult> {
        launches.push(request)
        if (gate) await gate.promise
        const ptyId = `pty-${++ptySeq}`
        alive.add(ptyId)
        return {
          ptyId,
          pid: 1000 + ptySeq,
          resumed: request.resumeProviderSessionId !== null,
          command: { command: request.provider, args: [], env: {} },
        }
      },
      buildCommand: () => ({ command: 'claude', args: [], env: {} }),
      locateProviderSessionId: async () => null,
    },
    relay: {
      // Como o relay real (ptyLeaderRelay): cola o aviso e manda Enter direto no PtyHost.
      async deliver(sessionId: SessionId, text: string) {
        delivered.push({ sessionId, text })
        const ptyId = `pty-${ptySeq}`
        if (alive.has(ptyId)) {
          ptyHost.write(ptyId, text)
          ptyHost.write(ptyId, '\r')
        }
        return { delivered: true, attempts: 1 }
      },
    },
    sessions: {
      onEvent(listener: (event: LeaderSessionEvent) => void) {
        sessionListeners.add(listener)
        return () => sessionListeners.delete(listener)
      },
      get: () => null,
    },
    async canResume(input: { provider: Provider; providerSessionId: string; cwd: string }) {
      return transcripts.has(input.providerSessionId)
    },
    dispose: async () => undefined,
  } as unknown as LeaderModule

  const members = {
    onActivity: () => () => undefined,
    onSessionExit: () => () => undefined,
    isAlive: () => false,
    close: async () => undefined,
    dispose: async () => undefined,
  } as unknown as MemberRuntime
  const bridge = {
    issueToken: () => 'tok',
    revokeSession: () => undefined,
    launchSpec: () => ({ name: 'eclipse', command: 'node', args: [], env: {} }),
  } as unknown as McpBridgeServer
  const removedWorktrees: string[] = []
  const worktrees = {
    remove: async (request: { worktreePath: string }) => {
      removedWorktrees.push(request.worktreePath)
    },
  } as unknown as WorktreeService

  const turnRelay = startTeamTurnRelay({
    tasks,
    relay: leader.relay,
    notices: tasks,
    retryIntervalMs: 0,
  })
  const coordinator = new AppTeamCoordinator({
    tasks,
    ptyHost,
    leader,
    members,
    worktrees,
    bridge,
    worktreesRoot: '/wt',
    leaderNotices: turnRelay,
  })

  const exitLeader = (sessionId: SessionId, exitCode: number) => {
    const ptyId = launches.length > 0 ? `pty-${ptySeq}` : ''
    alive.delete(ptyId)
    for (const listener of sessionListeners) {
      listener({ type: 'exit', sessionId, ptyId, exit: { exitCode, signal: null } })
    }
  }
  const settle = async () => {
    for (let i = 0; i < 3; i++) {
      await coordinator.idle()
      await turnRelay.idle()
    }
  }
  const emitLeader = (event: LeaderSessionEvent) => {
    for (const listener of sessionListeners) listener(event)
  }
  return {
    tasks,
    fx,
    coordinator,
    emitLeader,
    removedWorktrees,
    launches,
    killed,
    alive,
    delivered,
    ptyWrites,
    turnRelay,
    transcripts,
    exitLeader,
    settle,
    hold: () => {
      gate = deferred<void>()
      return gate
    },
  }
}

/** Lider anterior encerrado com um id do provedor, como depois de fechar o app. */
function seedPreviousLeader(
  h: ReturnType<typeof setup>,
  taskId: TaskId,
  providerSessionId: string,
) {
  const previous = h.tasks.openSession({
    taskId,
    subtaskId: null,
    roleId: null,
    kind: 'leader-pty',
    provider: 'claude',
    model: null,
    cwd: '/wt/corrigir-login',
    providerSessionId,
  })
  h.tasks.endSession(previous.id, { reason: 'lost_on_restart', exitCode: null })
  return previous
}

describe('Líder: retomada que não existe mais', () => {
  it('sem transcript do provedor abre sessão nova em vez de --resume', async () => {
    const h = setup()
    seedPreviousLeader(h, h.fx.task.id, 'sumiu-1')
    await h.coordinator.ensureLeader(h.fx.task.id)
    expect(h.launches.at(-1)?.resumeProviderSessionId).toBeNull()
  })

  it('--resume que falha não prende a tarefa: abre sessão nova e esquece o id', async () => {
    const h = setup({ transcripts: new Set(['velho-1']) })
    seedPreviousLeader(h, h.fx.task.id, 'velho-1')
    const resumed = await h.coordinator.ensureLeader(h.fx.task.id)
    expect(h.launches.at(-1)?.resumeProviderSessionId).toBe('velho-1')

    // `claude --resume` responde "No conversation found" e sai com 1.
    h.exitLeader(resumed.id, 1)
    await h.settle()

    expect(h.tasks.getSession(resumed.id)).toMatchObject({
      status: 'exited',
      providerSessionId: null,
    })
    expect(h.launches).toHaveLength(2)
    expect(h.launches[1]?.resumeProviderSessionId).toBeNull()
    const live = h.tasks.getLiveLeaderSession(h.fx.task.id)
    expect(live?.status).toBe('running')
    expect(live?.id).not.toBe(resumed.id)

    // E o próximo ensure não volta ao id velho.
    expect(await h.coordinator.ensureLeader(h.fx.task.id)).toMatchObject({ id: live?.id })
    expect(h.launches).toHaveLength(2)
  })
})

describe('Líder encerrado durante a abertura', () => {
  it('arquivar a tarefa enquanto o Líder abre mata o processo que acabou de abrir', async () => {
    const h = setup()
    const gate = h.hold()
    const opening = h.coordinator.ensureLeader(h.fx.task.id)
    await new Promise((r) => setTimeout(r, 0))
    await h.coordinator.archiveTask(h.fx.task.id, { removeWorktree: false })
    gate.resolve()
    const session = await opening
    expect(session.status).toBe('exited')
    expect(h.killed).toEqual(['pty-1'])
    expect(h.alive.size).toBe(0)
  })
})

describe('avisos ao Líder fora de turno', () => {
  it('resposta do usuário sem Líder vivo fica na fila durável e sai quando ele abre', async () => {
    const h = setup()
    const question = h.tasks.createQuestion({
      taskId: h.fx.task.id,
      subtaskId: null,
      items: [
        { id: 'i1', prompt: 'Qual banco?', options: [], multiSelect: false, allowFreeText: true },
      ],
    })
    await h.coordinator.answerUserQuestion(question.id, [
      { itemId: 'i1', optionIds: [], text: 'Postgres' },
    ])
    await h.settle()
    expect(h.delivered).toEqual([])
    const pending = h.tasks.listPendingLeaderNotices(h.fx.task.id)
    expect(pending).toHaveLength(1)
    expect(pending[0]?.text).toContain('Postgres')

    const leader = await h.coordinator.ensureLeader(h.fx.task.id)
    await h.settle()
    expect(h.delivered).toHaveLength(1)
    expect(h.delivered[0]).toMatchObject({ sessionId: leader.id })
    expect(h.delivered[0]?.text).toContain('Postgres')
    expect(h.tasks.listPendingLeaderNotices(h.fx.task.id)).toEqual([])
  })

  it('recuperação avisa o Líder das subtarefas perdidas sem turno aberto', async () => {
    const h = setup()
    const queued = h.tasks.createSubtask({
      taskId: h.fx.task.id,
      roleId: h.fx.dev.id,
      title: 'na fila',
      instructions: 'x',
      referenceTaskIds: [],
    })
    await h.coordinator.recover()
    await h.settle()
    const pending = h.tasks.listPendingLeaderNotices(h.fx.task.id).map((n) => n.text)
    expect(pending).toHaveLength(1)
    expect(pending[0]).toContain(queued.id)
    expect(pending[0]).toContain('sessão perdida')
  })
})

describe('status da tarefa', () => {
  it('turno do Líder começando põe a tarefa em andamento', async () => {
    const h = setup()
    const leader = await h.coordinator.ensureLeader(h.fx.task.id)
    expect(h.tasks.getTask(h.fx.task.id).workflowStatus).toBe('a_fazer')
    h.emitLeader({ type: 'activity', sessionId: leader.id, activity: 'idle' })
    expect(h.tasks.getTask(h.fx.task.id).workflowStatus).toBe('a_fazer')
    h.emitLeader({ type: 'activity', sessionId: leader.id, activity: 'working' })
    expect(h.tasks.getTask(h.fx.task.id).workflowStatus).toBe('em_andamento')
  })

  it('usuário marca Lançado: fecha o Líder, arquiva e não remove a worktree', async () => {
    const h = setup()
    await h.coordinator.ensureLeader(h.fx.task.id)
    const task = await h.coordinator.setTaskStatus(h.fx.task.id, 'lancado')
    expect(task).toMatchObject({ status: 'archived', workflowStatus: 'lancado' })
    expect(h.tasks.getLiveLeaderSession(h.fx.task.id)).toBeNull()
    expect(h.killed).toEqual(['pty-1'])
    expect(h.removedWorktrees).toEqual([])
  })

  it('tirar de Lançado sem a worktree no disco é recusado', async () => {
    const h = setup()
    await h.coordinator.setTaskStatus(h.fx.task.id, 'lancado')
    await expect(h.coordinator.setTaskStatus(h.fx.task.id, 'em_revisao')).rejects.toMatchObject({
      code: 'unavailable',
    })
    expect(h.tasks.getTask(h.fx.task.id).workflowStatus).toBe('lancado')
  })

  it('usuário troca entre status abertos sem abrir nem fechar agentes', async () => {
    const h = setup()
    const task = await h.coordinator.setTaskStatus(h.fx.task.id, 'pronto_lancar')
    expect(task).toMatchObject({ status: 'open', workflowStatus: 'pronto_lancar' })
    expect(h.launches).toHaveLength(0)
  })
})

describe('pergunta respondida no terminal do Líder', () => {
  const ITEM = {
    id: 'i1',
    prompt: 'Qual banco?',
    options: [],
    multiSelect: false,
    allowFreeText: true,
  }

  async function withOpenQuestion() {
    const h = setup()
    const leader = await h.coordinator.ensureLeader(h.fx.task.id)
    const question = h.tasks.createQuestion({
      taskId: h.fx.task.id,
      subtaskId: null,
      items: [ITEM],
    })
    const route = createIpcRouter(createIpcHandlers({ tasks: h.tasks, coordinator: h.coordinator }))
    return { h, leader, question, route }
  }

  it('terminal.write com Enter fecha a pergunta e a tarefa volta a em_andamento', async () => {
    const { h, leader, question, route } = await withOpenQuestion()
    expect(h.tasks.getTask(h.fx.task.id).workflowStatus).toBe('pergunta')
    const result = await route({
      channel: 'terminal.write',
      input: { sessionId: leader.id, data: 'use Postgres\r' },
    })
    expect(result).toEqual({ ok: true, value: undefined })
    expect(h.ptyWrites.at(-1)).toEqual({ ptyId: 'pty-1', data: 'use Postgres\r' })
    expect(h.tasks.getQuestion(question.id).status).toBe('answered_in_terminal')
    expect(h.tasks.getTask(h.fx.task.id).workflowStatus).toBe('em_andamento')
    expect(h.tasks.listOpenQuestions(h.fx.project.id)).toEqual([])
  })

  it('digitação sem Enter não fecha', async () => {
    const { h, leader, question, route } = await withOpenQuestion()
    await route({ channel: 'terminal.write', input: { sessionId: leader.id, data: 'use Post' } })
    expect(h.tasks.getQuestion(question.id).status).toBe('open')
    expect(h.tasks.getTask(h.fx.task.id).workflowStatus).toBe('pergunta')
    await route({ channel: 'terminal.write', input: { sessionId: leader.id, data: 'gres\n' } })
    expect(h.tasks.getQuestion(question.id).status).toBe('answered_in_terminal')
  })

  it('aviso do relay colado no pty do Líder (com Enter) não fecha a pergunta', async () => {
    const { h, question } = await withOpenQuestion()
    const before = h.ptyWrites.length
    h.turnRelay.notify(h.fx.task.id, '[eclipse] membro terminou o turno')
    await h.settle()
    // O relay escreveu de verdade no pty, Enter incluso...
    expect(h.ptyWrites.slice(before).map((w) => w.data)).toContain('\r')
    // ...e a pergunta continua aberta: só a digitação da tela conta.
    expect(h.tasks.getQuestion(question.id).status).toBe('open')
    expect(h.tasks.getTask(h.fx.task.id).workflowStatus).toBe('pergunta')
  })
})
