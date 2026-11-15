// TeamCoordinator com SQLite em memoria e portas falsas (pty, Lider, membros, ponte).
// Nenhum processo real, nenhum modelo, nenhuma janela.
import { describe, expect, it } from 'vitest'
import {
  DomainError,
  type Provider,
  type SessionId,
  type TaskId,
  type TurnResult,
} from '@shared/domain'
import type { McpCaller } from '@shared/mcp'
import { RESTART_PAUSE_MESSAGE } from '@shared/subtaskRules'
import type {
  AgentLimits,
  LeaderLaunchRequest,
  LeaderLaunchResult,
  McpBridgeServer,
  MemberRuntime,
  MemberSessionStart,
  PtyHost,
  WorktreeService,
} from '@shared/ports'
import type { LeaderModule, LeaderSessionEvent } from '../leader'
import { startTeamTurnRelay } from '../mcp'
import { createHarness, seedTeam, seedWorkingSubtask } from '../tasks/testing'
import { createIpcHandlers } from './ipcHandlers'
import { createIpcRouter } from './ipcRouter'
import type { AppServices } from './services'
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

function setup(
  options: {
    transcripts?: Set<string>
    members?: MemberRuntime
    limits?: () => AgentLimits
    taskProcesses?: { stopTask(taskId: string): void }
  } = {},
) {
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
      noteUserInput: () => undefined,
    },
    async canResume(input: { provider: Provider; providerSessionId: string; cwd: string }) {
      return transcripts.has(input.providerSessionId)
    },
    dispose: async () => undefined,
  } as unknown as LeaderModule

  const members =
    options.members ??
    ({
      onActivity: () => () => undefined,
      onSessionExit: () => () => undefined,
      isAlive: () => false,
      close: async () => undefined,
      dispose: async () => undefined,
    } as unknown as MemberRuntime)
  const bridge = {
    issueToken: () => 'tok',
    revokeSession: () => undefined,
    launchSpec: () => ({ name: 'eclipse', command: 'node', args: [], env: {} }),
  } as unknown as McpBridgeServer
  const removedWorktrees: string[] = []
  const createdWorktrees: unknown[] = []
  const worktrees = {
    create: async (request: unknown) => {
      createdWorktrees.push(request)
      throw new Error('create não deveria ser chamado')
    },
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
    ...(options.taskProcesses ? { taskProcesses: options.taskProcesses } : {}),
    ...(options.limits ? { limits: options.limits } : {}),
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
    createdWorktrees,
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

describe('aviso de reinício ao Líder retomado', () => {
  const openLostLeader = (h: ReturnType<typeof setup>) =>
    h.tasks.openSession({
      taskId: h.fx.task.id,
      subtaskId: null,
      roleId: null,
      kind: 'leader-pty',
      provider: 'claude',
      model: null,
      cwd: '/wt/corrigir-login',
      providerSessionId: 'conv-1',
    })

  it('sem subtarefa parada: o Líder retomado recebe 1 aviso de reinício', async () => {
    const h = setup({ transcripts: new Set(['conv-1']) })
    openLostLeader(h)
    const report = await h.coordinator.recover()
    expect(report.leadersToResume).toHaveLength(1)
    await h.settle()
    expect(h.launches.at(-1)?.initialNotices).toHaveLength(1)
    expect(h.launches.at(-1)?.initialNotices?.[0]?.text).toContain('Nenhuma subtarefa parou')
  })

  it('com subtarefa parada: só o aviso da subtarefa', async () => {
    const h = setup({ transcripts: new Set(['conv-1']) })
    openLostLeader(h)
    const queued = h.tasks.createSubtask({
      taskId: h.fx.task.id,
      roleId: h.fx.dev.id,
      title: 'na fila',
      instructions: 'x',
      referenceTaskIds: [],
    })
    await h.coordinator.recover()
    await h.settle()
    const texts = h.launches.at(-1)?.initialNotices?.map((n) => n.text) ?? []
    expect(texts).toHaveLength(1)
    expect(texts[0]).toContain(queued.id)
  })
})

describe('Líder Claude: prompt de sistema', () => {
  it('sessão nova: papel inteiro no systemPrompt e primeira mensagem curta', async () => {
    const h = setup()
    await h.coordinator.ensureLeader(h.fx.task.id)
    const launch = h.launches.at(-1)
    expect(launch?.systemPrompt).toContain('tarefa_concluir')
    expect(launch?.initialPrompt).toBe(`Tarefa: ${h.fx.task.title}. Comece.`)
  })

  it('retomada: systemPrompt vai de novo e não há primeira mensagem', async () => {
    const h = setup({ transcripts: new Set(['velho-1']) })
    seedPreviousLeader(h, h.fx.task.id, 'velho-1')
    await h.coordinator.ensureLeader(h.fx.task.id)
    const launch = h.launches.at(-1)
    expect(launch?.systemPrompt).toContain('tarefa_concluir')
    expect(launch?.initialPrompt).toBeNull()
  })
})

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

describe('tarefa Terminal (avulso sem agente)', () => {
  const terminal = (h: ReturnType<typeof setup>) =>
    h.coordinator.createTask({
      projectId: h.fx.project.id,
      title: 'shell',
      kind: 'solo',
      useWorktree: false,
    })

  it('criar não abre Líder e ensureLeader recusa', async () => {
    const h = setup()
    const task = await terminal(h)
    await h.settle()
    expect(h.launches).toEqual([])
    await expect(h.coordinator.ensureLeader(task.id)).rejects.toMatchObject({
      code: 'invalid_input',
      message: 'tarefa de terminal não tem agente',
    })
    expect(h.launches).toEqual([])
  })

  it('time sem worktree abre o Líder na raiz do projeto e não cria worktree', async () => {
    const h = setup()
    const task = await h.coordinator.createTask({
      projectId: h.fx.project.id,
      title: 't',
      kind: 'team',
      useWorktree: false,
    })
    await h.settle()
    expect(task).toMatchObject({ kind: 'team', worktreePath: null, branch: null })
    expect(h.createdWorktrees).toEqual([])
    expect(h.launches).toHaveLength(1)
    expect(h.launches[0]?.cwd).toBe('/repo/projeto')
  })
})

describe('processos das abas Iniciar e Terminal', () => {
  it('arquivar e lançar a tarefa param os processos dela', async () => {
    const stopped: string[] = []
    const h = setup({ taskProcesses: { stopTask: (id) => void stopped.push(id) } })
    await h.coordinator.archiveTask(h.fx.task.id, { removeWorktree: false })
    expect(stopped).toEqual([h.fx.task.id])
    const h2 = setup({ taskProcesses: { stopTask: (id) => void stopped.push(id) } })
    await h2.coordinator.setTaskStatus(h2.fx.task.id, 'lancado')
    expect(stopped).toEqual([h.fx.task.id, h2.fx.task.id])
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

  it('recuperação avisa o Líder das subtarefas paradas sem turno aberto', async () => {
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
    expect(pending[0]).toContain('O app reiniciou')
    expect(h.tasks.getSubtask(queued.id)).toMatchObject({
      state: 'input_required',
      statusMessage: RESTART_PAUSE_MESSAGE,
    })
  })
})

/** MemberRuntime falso: grava partidas e prompts; o turno termina com STATUS: PRONTO. */
function fakeMembers(options: { loadFails?: boolean; startFails?: boolean } = {}) {
  const starts: MemberSessionStart[] = []
  const prompts: { sessionId: string; text: string }[] = []
  const alive = new Set<string>()
  const runtime = {
    onActivity: () => () => undefined,
    onSessionExit: () => () => undefined,
    isAlive: (id: string) => alive.has(id),
    liveCount: () => alive.size,
    async startSession(request: MemberSessionStart) {
      starts.push(request)
      if (options.startFails) throw new DomainError('unavailable', 'agente não abriu')
      if (request.resumeProviderSessionId && options.loadFails) {
        throw new DomainError('unavailable', 'Este agente não sabe retomar sessão (session/load).')
      }
      alive.add(request.sessionId)
      return {
        sessionId: request.sessionId,
        providerSessionId: request.resumeProviderSessionId ?? `novo-${starts.length}`,
        pid: 4242,
      }
    },
    async prompt(sessionId: string, input: { turnId: string; text: string }): Promise<TurnResult> {
      prompts.push({ sessionId, text: input.text })
      return {
        turnId: input.turnId,
        sessionId,
        outcome: { kind: 'stopped', stopReason: 'end_turn' },
        finalText: 'Continuei e terminei.\nSTATUS: PRONTO',
        deliveries: [],
        startedAt: 1,
        endedAt: 2,
      }
    },
    async close(id: string) {
      alive.delete(id)
    },
    cancel: async () => undefined,
    dispose: async () => undefined,
  } as unknown as MemberRuntime
  return { runtime, starts, prompts }
}

/**
 * Subtarefa com membro no meio do turno quando o app fechou, depois da recuperacao da
 * partida seguinte: parada em input_required, sessao antiga com providerSessionId 'acp-1'.
 */
async function pausedByRestart(members: ReturnType<typeof fakeMembers>) {
  const h = setup({ members: members.runtime })
  const { subtask, session } = seedWorkingSubtask(h.tasks, h.fx)
  const turn = h.tasks.startTurn({
    sessionId: session.id,
    subtaskId: subtask.id,
    author: 'leader',
    parts: [{ kind: 'text', text: 'faça a rota' }],
  })
  h.tasks.appendActivity([
    {
      sessionId: session.id,
      subtaskId: subtask.id,
      turnId: turn.id,
      at: 5,
      payload: { kind: 'text', text: 'Criei src/rota.ts; faltam os testes.' },
    },
  ])
  await h.coordinator.recover()
  await h.settle()
  const leader: McpCaller = {
    role: 'leader',
    sessionId: 'sess-lider',
    taskId: h.fx.task.id,
    subtaskId: null,
  }
  return { h, subtask, session, leader }
}

describe('subtarefa parada pelo reinício do app', () => {
  it('turno aberto na queda: fica parada e o Líder recebe um aviso só, o de reinício', async () => {
    const { h, subtask, session } = await pausedByRestart(fakeMembers())
    expect(h.tasks.getSubtask(subtask.id)).toMatchObject({
      state: 'input_required',
      statusMessage: 'parada: o app reiniciou',
      failureCode: null,
    })
    expect(h.tasks.getSession(session.id)).toMatchObject({
      endReason: 'lost_on_restart',
      providerSessionId: 'acp-1',
    })
    const pending = h.tasks.listPendingLeaderNotices(h.fx.task.id).map((n) => n.text)
    expect(pending).toEqual([
      `[eclipse] O app reiniciou e a subtarefa ${subtask.id} (Dev 1: Implementar rota) parou no meio. O que o membro já alterou continua na worktree. Para continuar: subtarefa_responder com o que ele deve fazer (o app reabre o membro na mesma conversa). Para encerrar: subtarefa_cancelar.`,
    ])
    // Quando o Líder abre, recebe exatamente esse aviso (e não o "terminou o turno").
    await h.coordinator.ensureLeader(h.fx.task.id)
    await h.settle()
    expect(h.delivered.map((d) => d.text)).toEqual(pending)
  })

  it('Líder cancela depois do reinício', async () => {
    const { h, subtask, leader } = await pausedByRestart(fakeMembers())
    const canceled = await h.coordinator.cancelSubtask(leader, subtask.id, null)
    await h.settle()
    expect(canceled).toMatchObject({ state: 'canceled', statusMessage: 'cancelada pelo Líder' })
  })

  it('Líder responde: o membro é reaberto com session/load na mesma conversa e o turno roda', async () => {
    const members = fakeMembers()
    const { h, subtask, session, leader } = await pausedByRestart(members)
    const answered = await h.coordinator.answerSubtask(leader, subtask.id, 'Faça os testes.')
    expect(answered.state).toBe('working')
    await h.settle()

    expect(members.starts).toHaveLength(1)
    expect(members.starts[0]).toMatchObject({
      subtaskId: subtask.id,
      provider: 'codex',
      cwd: '/wt/corrigir-login',
      resumeProviderSessionId: 'acp-1',
    })
    expect(members.prompts).toHaveLength(1)
    expect(members.prompts[0]!.text).toContain('A conversa foi retomada')
    expect(members.prompts[0]!.text).toContain('Faça os testes.')

    const after = h.tasks.getSubtask(subtask.id)
    expect(after.state).toBe('completed')
    expect(after.sessionId).not.toBe(session.id)
    const reopened = h.tasks.getSession(after.sessionId!)
    expect(reopened).toMatchObject({ providerSessionId: 'acp-1', endReason: 'closed' })
    expect(h.tasks.getSession(session.id).endReason).toBe('lost_on_restart')
  })

  it('sem session/load: conversa nova e o primeiro prompt leva o contexto da subtarefa', async () => {
    const members = fakeMembers({ loadFails: true })
    const { h, subtask, leader } = await pausedByRestart(members)
    await h.coordinator.answerSubtask(leader, subtask.id, 'Faça os testes.')
    await h.settle()

    expect(members.starts.map((s) => s.resumeProviderSessionId)).toEqual(['acp-1', null])
    // As duas tentativas usam a mesma sessão do app.
    expect(new Set(members.starts.map((s) => s.sessionId)).size).toBe(1)
    const text = members.prompts[0]!.text
    expect(text).toContain(`Subtarefa ${subtask.id}: Implementar rota`)
    expect(text).toContain('faça a rota')
    expect(text).toContain('Criei src/rota.ts; faltam os testes.')
    expect(text).toContain('Mensagem do Líder:\nFaça os testes.')
    expect(h.tasks.getSubtask(subtask.id).state).toBe('completed')
    expect(h.tasks.getSession(h.tasks.getSubtask(subtask.id).sessionId!).providerSessionId).toBe(
      'novo-2',
    )
  })

  it('falha ao reabrir: subtarefa bloqueada (spawn_failed) e o Líder é avisado', async () => {
    const { h, subtask, leader } = await pausedByRestart(fakeMembers({ startFails: true }))
    await h.coordinator.answerSubtask(leader, subtask.id, 'Faça os testes.')
    await h.settle()
    const after = h.tasks.getSubtask(subtask.id)
    expect(after).toMatchObject({ state: 'failed', failureCode: 'spawn_failed' })
    expect(h.tasks.getSession(after.sessionId!).endReason).toBe('spawn_failed')
    const pending = h.tasks.listPendingLeaderNotices(h.fx.task.id).map((n) => n.text)
    expect(pending).toHaveLength(2)
    expect(pending[1]).toContain(`Subtarefa ${subtask.id}`)
    expect(pending[1]).toContain('não abriu: bloqueado')
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
    const route = createIpcRouter(
      createIpcHandlers({
        tasks: h.tasks,
        coordinator: h.coordinator,
        brain: {} as AppServices['brain'],
        taskProcesses: { owns: () => false } as unknown as AppServices['taskProcesses'],
      }),
    )
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

describe('limites de agentes configuráveis', () => {
  it('limite salvo vale na próxima checagem, sem recriar o coordenador', async () => {
    const h = setup({ limits: () => h.tasks.getAgentLimits() })
    await h.coordinator.ensureLeader(h.fx.task.id)
    const caller: McpCaller = {
      role: 'leader',
      sessionId: 'x',
      taskId: h.fx.task.id,
      subtaskId: null,
    }
    const input = { roleId: h.fx.dev.id, title: 'a', instructions: 'b', referenceTaskIds: [] }
    // Sem configuração = sem limite: o limite 1 com 1 Líder vivo ainda não foi salvo.
    h.tasks.saveAgentLimitSettings({ maxLiveAgents: 1, maxLiveMembersPerTask: null })
    await expect(h.coordinator.createSubtask(caller, input)).rejects.toMatchObject({
      code: 'unavailable',
    })
    // Baixar o limite não derrubou o Líder vivo.
    expect(h.tasks.getLiveLeaderSession(h.fx.task.id)).not.toBeNull()
  })

  it('maxLiveMembersPerTask lido da configuração; voltar a null libera a criação', async () => {
    const h = setup({ limits: () => h.tasks.getAgentLimits(), members: fakeMembers().runtime })
    await h.coordinator.ensureLeader(h.fx.task.id)
    const caller: McpCaller = {
      role: 'leader',
      sessionId: 'x',
      taskId: h.fx.task.id,
      subtaskId: null,
    }
    const input = { roleId: h.fx.dev.id, title: 'a', instructions: 'b', referenceTaskIds: [] }
    h.tasks.saveAgentLimitSettings({ maxLiveAgents: null, maxLiveMembersPerTask: 1 })
    await h.coordinator.createSubtask(caller, input)
    await expect(h.coordinator.createSubtask(caller, input)).rejects.toMatchObject({
      code: 'unavailable',
    })
    h.tasks.saveAgentLimitSettings({ maxLiveAgents: null, maxLiveMembersPerTask: null })
    await expect(h.coordinator.createSubtask(caller, input)).resolves.toBeDefined()
  })
})
