import { describe, expect, it, vi } from 'vitest'
import {
  DomainError,
  SUBTASK_STATES,
  SUBTASK_TRANSITIONS,
  isFinalSubtaskState,
  isTerminalTask,
  type DomainEventEnvelope,
  type SubtaskState,
} from '@shared/domain'
import {
  createHarness,
  endTurnResult,
  sampleDelivery,
  seedTeam,
  seedWorkingSubtask,
  type Harness,
  type TeamFixture,
} from './testing'
import { SqliteTaskService } from './taskService'
import { limitsFromSettings } from './agentLimits'

function errorCode(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    if (error instanceof DomainError) return error.code
    throw error
  }
  throw new Error('esperava DomainError')
}

const PATH_TO: Record<SubtaskState, SubtaskState[]> = {
  submitted: [],
  working: ['working'],
  input_required: ['working', 'input_required'],
  completed: ['working', 'completed'],
  failed: ['failed'],
  canceled: ['canceled'],
}

function subtaskIn(service: SqliteTaskService, fx: TeamFixture, state: SubtaskState): string {
  const s = service.createSubtask({
    taskId: fx.task.id,
    roleId: fx.dev.id,
    title: `em ${state}`,
    instructions: 'x',
    referenceTaskIds: [],
  })
  for (const step of PATH_TO[state]) service.transitionSubtask(s.id, step)
  expect(service.getSubtask(s.id).state).toBe(state)
  return s.id
}

describe('TaskService: máquina de estados da subtarefa', () => {
  const pairs = SUBTASK_STATES.flatMap((from) => SUBTASK_STATES.map((to) => [from, to] as const))

  it.each(pairs)('%s -> %s segue SUBTASK_TRANSITIONS', (from, to) => {
    const { service } = createHarness()
    const fx = seedTeam(service)
    const id = subtaskIn(service, fx, from)
    const before = service.getSubtask(id)
    if (SUBTASK_TRANSITIONS[from].includes(to)) {
      const after = service.transitionSubtask(id, to)
      expect(after.state).toBe(to)
      expect(after.finishedAt !== null).toBe(isFinalSubtaskState(to))
      if (to === 'failed') expect(after.failureCode).toBe('error')
      else expect(after.failureCode).toBeNull()
    } else {
      const code = errorCode(() => service.transitionSubtask(id, to))
      expect(code).toBe(isFinalSubtaskState(from) ? 'final_state' : 'invalid_transition')
      expect(service.getSubtask(id)).toEqual(before)
    }
  })

  it('failed guarda failureCode e mensagem em português', () => {
    const { service } = createHarness()
    const fx = seedTeam(service)
    const id = subtaskIn(service, fx, 'working')
    const s = service.transitionSubtask(id, 'failed', { failureCode: 'silent_timeout' })
    expect(s.failureCode).toBe('silent_timeout')
    expect(s.statusMessage).toBe('bloqueado: sem resposta')
  })

  it('o banco recusa mudar subtarefa final mesmo sem passar pelo serviço', () => {
    const { service, store } = createHarness()
    const fx = seedTeam(service)
    const id = subtaskIn(service, fx, 'completed')
    expect(() =>
      store.db.prepare("UPDATE subtasks SET state = 'working' WHERE id = ?").run(id),
    ).toThrow(/final_state/)
  })

  it('correção vira subtarefa nova com referenceTaskIds; origem precisa ser da mesma tarefa', () => {
    const { service } = createHarness()
    const fx = seedTeam(service)
    const done = subtaskIn(service, fx, 'completed')
    const fix = service.createSubtask({
      taskId: fx.task.id,
      roleId: fx.dev.id,
      title: 'corrigir achado',
      instructions: 'y',
      referenceTaskIds: [done, done],
    })
    expect(fix.referenceTaskIds).toEqual([done])
    expect(fix.state).toBe('submitted')

    const other = service.createTask({
      projectId: fx.project.id,
      title: 'Outra',
      kind: 'team',
      worktreePath: '/wt/outra',
      branch: 'feat/outra',
      baseBranch: 'main',
      leadRoleId: null,
      soloProvider: null,
    })
    expect(
      errorCode(() =>
        service.createSubtask({
          taskId: other.id,
          roleId: fx.dev.id,
          title: 'z',
          instructions: 'z',
          referenceTaskIds: [done],
        }),
      ),
    ).toBe('invalid_input')
  })

  it('avulso não tem subtarefas e papel apagado não recebe subtarefa', () => {
    const { service } = createHarness()
    const fx = seedTeam(service)
    const solo = service.createTask({
      projectId: fx.project.id,
      title: 'Avulso',
      kind: 'solo',
      worktreePath: null,
      branch: null,
      baseBranch: null,
      leadRoleId: null,
      soloProvider: 'claude',
    })
    const mk = (taskId: string) => () =>
      service.createSubtask({
        taskId,
        roleId: fx.dev.id,
        title: 'a',
        instructions: 'b',
        referenceTaskIds: [],
      })
    expect(errorCode(mk(solo.id))).toBe('invalid_input')
    service.deleteRole(fx.dev.id)
    expect(errorCode(mk(fx.task.id))).toBe('not_found')
    // O histórico ainda acha o papel apagado.
    expect(service.getRole(fx.dev.id).name).toBe('Dev 1')
    expect(service.listRoles(fx.project.id).map((r) => r.name)).toEqual(['Líder'])
  })
})

describe('TaskService: eventos só depois do commit', () => {
  it('cada escrita emite envelopes com revisão crescente e a entidade gravada', () => {
    const { service, store } = createHarness()
    const seen: DomainEventEnvelope[] = []
    service.subscribe((env) => {
      // No momento do evento a escrita já está no banco.
      if (env.event.type === 'subtask.upserted') {
        expect(store.getSubtask(env.event.subtask.id)).toEqual(env.event.subtask)
      }
      seen.push(env)
    })
    const fx = seedTeam(service)
    subtaskIn(service, fx, 'working')
    const revisions = seen.map((e) => e.revision)
    expect(revisions).toEqual([...revisions].sort((a, b) => a - b))
    expect(new Set(revisions).size).toBe(revisions.length)
    expect(seen.map((e) => e.event.type)).toContain('subtask.upserted')
    expect(store.latestRevision()).toBe(revisions.at(-1))
  })

  it('escrita que falha não emite nada nem deixa meia escrita', () => {
    const { service } = createHarness()
    const fx = seedTeam(service)
    const id = subtaskIn(service, fx, 'canceled')
    const seen: DomainEventEnvelope[] = []
    service.subscribe((e) => seen.push(e))
    expect(errorCode(() => service.transitionSubtask(id, 'working'))).toBe('final_state')
    // Arquivar com sessão aberta falha depois de já ter cancelado subtarefas na transação.
    const live = subtaskIn(service, fx, 'working')
    seen.length = 0
    service.openSession({
      taskId: fx.task.id,
      subtaskId: null,
      roleId: fx.lead.id,
      kind: 'leader-pty',
      provider: 'claude',
      model: 'opus',
      cwd: '/wt',
      providerSessionId: null,
    })
    seen.length = 0
    expect(errorCode(() => service.markTaskArchived(fx.task.id))).toBe('conflict')
    expect(seen).toEqual([])
    expect(service.getSubtask(live).state).toBe('working')
  })

  it('assinante que lança não derruba a escrita', () => {
    const errors: unknown[] = []
    const h: Harness = createHarness()
    const service = new SqliteTaskService({
      store: h.store,
      onListenerError: (e) => errors.push(e),
    })
    service.subscribe(() => {
      throw new Error('tela quebrou')
    })
    const p = service.addProject({ rootPath: '/repo/x/' })
    expect(p.rootPath).toBe('/repo/x')
    expect(service.getProject(p.id)).toEqual(p)
    // 1 projeto + 3 papéis do time padrão, e cada assinante lança uma vez.
    expect(errors).toHaveLength(4)
  })
})

describe('TaskService: projetos, papéis e tarefas', () => {
  it('projeto é único por pasta; nome padrão é a pasta', () => {
    const { service } = createHarness()
    const p = service.addProject({ rootPath: '/home/u/meu-repo/' })
    expect(p.name).toBe('meu-repo')
    expect(errorCode(() => service.addProject({ rootPath: '/home/u/meu-repo' }))).toBe('conflict')
  })

  it('renameProject troca o nome, emite o evento e recusa nome vazio e id inexistente', () => {
    const { service } = createHarness()
    const p = service.addProject({ rootPath: '/repo/velho' })
    const events: string[] = []
    service.subscribe((env) => events.push(env.event.type))
    const renamed = service.renameProject(p.id, '  Novo nome  ')
    expect(renamed.name).toBe('Novo nome')
    expect(service.getProject(p.id).name).toBe('Novo nome')
    expect(events).toEqual(['project.upserted'])
    expect(errorCode(() => service.renameProject(p.id, '   '))).toBe('invalid_input')
    expect(errorCode(() => service.renameProject('nao-existe', 'x'))).toBe('not_found')
  })

  it('projeto novo nasce com Líder, Dev e Revisor e aceita tarefa de time', () => {
    const { service } = createHarness()
    const p = service.addProject({ rootPath: '/repo/novo' })
    const roles = service.listRoles(p.id)
    expect(roles.map((r) => r.name).sort()).toEqual(['Dev', 'Líder', 'Revisor'])
    expect(roles.filter((r) => r.isLead)).toHaveLength(1)
    expect(roles.every((r) => r.provider === 'claude' && r.model === null)).toBe(true)
    expect(service.getLeadRole(p.id)?.name).toBe('Líder')
    const task = service.createTask({
      projectId: p.id,
      title: 'Primeira',
      kind: 'team',
      worktreePath: '/wt/primeira',
      branch: 'feat/primeira',
      baseBranch: 'main',
      leadRoleId: null,
      soloProvider: null,
    })
    expect(task.leadRoleId).toBe(service.getLeadRole(p.id)?.id)
  })

  it('nome de papel é único sem diferenciar acento e maiúscula', () => {
    const { service } = createHarness()
    const fx = seedTeam(service)
    expect(service.findRoleByName(fx.project.id, '  lider ')?.id).toBe(fx.lead.id)
    expect(
      errorCode(() =>
        service.saveRole({
          projectId: fx.project.id,
          name: 'LÍDER',
          description: '',
          provider: 'claude',
          model: null,
          promptTemplate: '',
          isLead: false,
          access: 'no_commit',
        }),
      ),
    ).toBe('conflict')
  })

  it('saveRole grava e devolve access; o Líder só aceita full', () => {
    const { service } = createHarness()
    const fx = seedTeam(service)
    const base = {
      projectId: fx.project.id,
      description: '',
      provider: 'claude' as const,
      model: null,
      promptTemplate: '',
    }
    const rev = service.saveRole({ ...base, name: 'Revisor 2', isLead: false, access: 'read_only' })
    expect(rev.access).toBe('read_only')
    expect(service.getRole(rev.id).access).toBe('read_only')
    const edited = service.saveRole({
      ...base,
      roleId: rev.id,
      name: 'Revisor 2',
      isLead: false,
      access: 'full',
    })
    expect(service.getRole(edited.id).access).toBe('full')
    expect(
      errorCode(() =>
        service.saveRole({ ...base, name: 'Chefe', isLead: true, access: 'read_only' }),
      ),
    ).toBe('invalid_input')
    expect(service.getRole(fx.dev.id).access).toBe('no_commit')
    // Ausente: criação vira full; edição mantém o valor atual.
    const semCampo = service.saveRole({ ...base, name: 'Novo', isLead: false })
    expect(semCampo.access).toBe('full')
    const mantido = service.saveRole({
      ...base,
      roleId: rev.id,
      name: 'Revisor 2',
      description: 'editado',
      isLead: false,
    })
    expect(mantido.access).toBe('full')
    const ro = service.saveRole({ ...base, name: 'RO', isLead: false, access: 'read_only' })
    const roEditado = service.saveRole({ ...base, roleId: ro.id, name: 'RO', isLead: false })
    expect(roEditado.access).toBe('read_only')
    expect(service.getLeadRole(fx.project.id)?.access).toBe('full')
  })

  it('só um Líder por projeto: escolher outro tira a marca do anterior', () => {
    const { service } = createHarness()
    const fx = seedTeam(service)
    const novo = service.saveRole({
      projectId: fx.project.id,
      roleId: fx.dev.id,
      name: 'Dev 1',
      description: 'agora lidera',
      provider: 'codex',
      model: null,
      promptTemplate: 'p',
      isLead: true,
      access: 'full',
    })
    expect(novo.isLead).toBe(true)
    expect(service.getRole(fx.lead.id).isLead).toBe(false)
    expect(service.getLeadRole(fx.project.id)?.id).toBe(fx.dev.id)
  })

  it('tarefa de time sem papel usa o Líder do projeto; time sem worktree é aceito', () => {
    const { service } = createHarness()
    const fx = seedTeam(service)
    expect(fx.task.leadRoleId).toBe(fx.lead.id)
    expect(fx.task.contextId).not.toBe(fx.task.id)
    const semWorktree = service.createTask({
      projectId: fx.project.id,
      title: 't',
      kind: 'team',
      worktreePath: null,
      branch: null,
      baseBranch: null,
      leadRoleId: null,
      soloProvider: null,
    })
    expect(semWorktree).toMatchObject({ kind: 'team', worktreePath: null, leadRoleId: fx.lead.id })
  })

  it('avulso sem papel e sem provedor vira tarefa Terminal', () => {
    const { service } = createHarness()
    const fx = seedTeam(service)
    const task = service.createTask({
      projectId: fx.project.id,
      title: 'shell',
      kind: 'solo',
      worktreePath: null,
      branch: null,
      baseBranch: null,
      leadRoleId: null,
      soloProvider: null,
    })
    expect(isTerminalTask(task)).toBe(true)
  })

  it('arquivar cancela subtarefas abertas, descarta perguntas e bloqueia escrita nova', () => {
    const { service } = createHarness()
    const fx = seedTeam(service)
    const open = subtaskIn(service, fx, 'input_required')
    const done = subtaskIn(service, fx, 'completed')
    const q = service.createQuestion({
      taskId: fx.task.id,
      subtaskId: open,
      items: [{ id: 'i1', prompt: 'qual?', options: [], multiSelect: false, allowFreeText: true }],
    })
    const archived = service.markTaskArchived(fx.task.id)
    expect(archived.status).toBe('archived')
    expect(service.getSubtask(open).state).toBe('canceled')
    expect(service.getSubtask(open).statusMessage).toBe('cancelada: tarefa arquivada')
    expect(service.getSubtask(done).state).toBe('completed')
    expect(service.getQuestion(q.id).status).toBe('dismissed')
    expect(
      errorCode(() =>
        service.createSubtask({
          taskId: fx.task.id,
          roleId: fx.dev.id,
          title: 'a',
          instructions: 'b',
          referenceTaskIds: [],
        }),
      ),
    ).toBe('conflict')
    expect(service.listTasks(fx.project.id, { includeArchived: false })).toEqual([])
    expect(service.listTasks(fx.project.id, { includeArchived: true })).toHaveLength(1)
  })

  it('remover projeto apaga tudo dele, mas recusa com agente vivo', () => {
    const { service, store } = createHarness()
    const fx = seedTeam(service)
    const { session } = seedWorkingSubtask(service, fx)
    expect(errorCode(() => service.removeProject(fx.project.id))).toBe('conflict')
    service.endSession(session.id, { reason: 'closed', exitCode: 0 })
    service.removeProject(fx.project.id)
    expect(service.listProjects()).toEqual([])
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM subtasks').get()).toEqual({ n: 0 })
  })
})

describe('TaskService: sessões', () => {
  const leader = (fx: TeamFixture) => ({
    taskId: fx.task.id,
    subtaskId: null,
    roleId: fx.lead.id,
    kind: 'leader-pty' as const,
    provider: 'claude' as const,
    model: 'opus',
    cwd: '/wt/corrigir-login',
    providerSessionId: null,
  })

  it('um Líder vivo por tarefa; depois de encerrado pode abrir outro', () => {
    const { service } = createHarness()
    const fx = seedTeam(service)
    const first = service.openSession(leader(fx))
    expect(service.getLiveLeaderSession(fx.task.id)?.id).toBe(first.id)
    expect(errorCode(() => service.openSession(leader(fx)))).toBe('conflict')
    service.endSession(first.id, { reason: 'exited', exitCode: 0 })
    expect(service.getLiveLeaderSession(fx.task.id)).toBeNull()
    const second = service.openSession(leader(fx))
    expect(second.id).not.toBe(first.id)
    expect(service.listSessions(fx.task.id)).toHaveLength(2)
  })

  it('o banco também recusa dois Líderes vivos', () => {
    const { service, store } = createHarness()
    const fx = seedTeam(service)
    const s = service.openSession(leader(fx))
    expect(() => store.insertSession({ ...s, id: 'outro' })).toThrow(/UNIQUE/)
  })

  it('sessão de membro precisa de subtarefa da tarefa, e só uma por subtarefa', () => {
    const { service } = createHarness()
    const fx = seedTeam(service)
    const { subtask, session } = seedWorkingSubtask(service, fx)
    expect(subtask.sessionId).toBe(session.id)
    expect(
      errorCode(() =>
        service.openSession({ ...leader(fx), kind: 'member-acp', subtaskId: subtask.id }),
      ),
    ).toBe('conflict')
    expect(
      errorCode(() => service.openSession({ ...leader(fx), kind: 'member-acp', subtaskId: null })),
    ).toBe('invalid_input')
  })

  it('endSession é idempotente e sessão encerrada não volta', () => {
    const { service } = createHarness()
    const fx = seedTeam(service)
    const s = service.openSession(leader(fx))
    const running = service.updateSession(s.id, {
      status: 'running',
      pid: 42,
      providerSessionId: 'p1',
    })
    expect(running).toMatchObject({ status: 'running', pid: 42, providerSessionId: 'p1' })
    const ended = service.endSession(s.id, { reason: 'process_died', exitCode: 137 })
    expect(ended).toMatchObject({ status: 'exited', endReason: 'process_died', exitCode: 137 })
    expect(service.endSession(s.id, { reason: 'closed', exitCode: 0 })).toEqual(ended)
    expect(errorCode(() => service.updateSession(s.id, { status: 'running' }))).toBe(
      'invalid_transition',
    )
    expect(errorCode(() => service.updateSession(s.id, { status: 'exited' }))).toBe('invalid_input')
    expect(service.listOpenSessions()).toEqual([])
  })
})

describe('TaskService: turnos e entregas', () => {
  it('startTurn grava turno, mensagem e atividade prompt; segundo turno simultâneo é recusado', () => {
    const { service } = createHarness()
    const fx = seedTeam(service)
    const { subtask, session } = seedWorkingSubtask(service, fx)
    const turn = service.startTurn({
      sessionId: session.id,
      subtaskId: subtask.id,
      author: 'leader',
      parts: [{ kind: 'text', text: 'faça a rota' }],
    })
    expect(service.getSession(session.id)).toMatchObject({
      activeTurnId: turn.id,
      status: 'running',
    })
    const detail = service.getSubtaskDetail(subtask.id)
    expect(detail.messages).toHaveLength(1)
    expect(detail.messages[0]).toMatchObject({ author: 'leader', turnId: turn.id })
    expect(detail.turns).toEqual([turn])
    const page = service.listActivity(subtask.id, null, 10)
    expect(page.events[0]).toMatchObject({
      seq: 1,
      payload: { kind: 'prompt', text: 'faça a rota' },
    })
    expect(
      errorCode(() =>
        service.startTurn({
          sessionId: session.id,
          subtaskId: subtask.id,
          author: 'leader',
          parts: [],
        }),
      ),
    ).toBe('conflict')
  })

  it('turno só começa com a subtarefa em working', () => {
    const { service } = createHarness()
    const fx = seedTeam(service)
    const { subtask, session } = seedWorkingSubtask(service, fx)
    service.transitionSubtask(subtask.id, 'input_required')
    expect(
      errorCode(() =>
        service.startTurn({
          sessionId: session.id,
          subtaskId: subtask.id,
          author: 'user',
          parts: [],
        }),
      ),
    ).toBe('invalid_transition')
  })

  it('entrega estruturada fecha a subtarefa como pronto; finishTurn é idempotente', () => {
    const { service } = createHarness()
    const fx = seedTeam(service)
    const { subtask, session } = seedWorkingSubtask(service, fx)
    const turn = service.startTurn({
      sessionId: session.id,
      subtaskId: subtask.id,
      author: 'leader',
      parts: [],
    })
    const artifact = service.recordDelivery(
      session.id,
      sampleDelivery('completed', 'rota pronta\ndetalhe'),
    )
    expect(artifact).toMatchObject({ format: 'structured', turnId: turn.id })
    expect(service.listTurnDeliveries(turn.id)).toEqual([artifact])

    const result = endTurnResult(turn.id, session.id, { finalText: 'feito', deliveries: [] })
    const out = service.finishTurn(result)
    expect(out.transitioned).toBe(true)
    expect(out.fallbackArtifact).toBeNull()
    expect(out.subtask).toMatchObject({ state: 'completed', statusMessage: 'rota pronta' })
    expect(out.turn).toMatchObject({ stopReason: 'end_turn', finalText: 'feito' })
    expect(service.getSession(session.id).activeTurnId).toBeNull()

    const again = service.finishTurn(result)
    expect(again.transitioned).toBe(false)
    expect(
      service.getSubtaskDetail(subtask.id).messages.filter((m) => m.author === 'member'),
    ).toHaveLength(1)
    // Entrega fora de turno e entrega em subtarefa final são recusadas.
    expect(errorCode(() => service.recordDelivery(session.id, sampleDelivery('completed')))).toBe(
      'invalid_transition',
    )
  })

  it('sem entrega: linha STATUS vira entrega "sem formato"; sem STATUS fica em dúvida', () => {
    const { service } = createHarness()
    const fx = seedTeam(service)
    const a = seedWorkingSubtask(service, fx, 'a')
    const t1 = service.startTurn({
      sessionId: a.session.id,
      subtaskId: a.subtask.id,
      author: 'leader',
      parts: [],
    })
    const out1 = service.finishTurn(
      endTurnResult(t1.id, a.session.id, {
        finalText: 'mexi em x\nSTATUS: BLOQUEADO — sem acesso',
      }),
    )
    expect(out1.subtask).toMatchObject({ state: 'failed', failureCode: 'member_blocked' })
    expect(out1.fallbackArtifact).toMatchObject({
      format: 'unformatted',
      delivery: { state: 'failed' },
    })

    const b = seedWorkingSubtask(service, fx, 'b')
    const t2 = service.startTurn({
      sessionId: b.session.id,
      subtaskId: b.subtask.id,
      author: 'leader',
      parts: [],
    })
    const out2 = service.finishTurn(
      endTurnResult(t2.id, b.session.id, { finalText: 'acho que terminei' }),
    )
    expect(out2.subtask.state).toBe('input_required')
    expect(out2.fallbackArtifact?.delivery.state).toBe('input_required')

    // Dúvida respondida: volta a working e roda outro turno na mesma sessão.
    service.transitionSubtask(b.subtask.id, 'working')
    const t3 = service.startTurn({
      sessionId: b.session.id,
      subtaskId: b.subtask.id,
      author: 'user',
      parts: [{ kind: 'text', text: 'resposta' }],
    })
    service.recordDelivery(b.session.id, sampleDelivery('completed'))
    expect(service.finishTurn(endTurnResult(t3.id, b.session.id)).subtask.state).toBe('completed')
    expect(service.listActivity(b.subtask.id, null, 100).events.map((e) => e.seq)).toEqual([1, 2])
  })

  it('erro de turno (vigia de silêncio) vira bloqueado com o código', () => {
    const { service } = createHarness()
    const fx = seedTeam(service)
    const { subtask, session } = seedWorkingSubtask(service, fx)
    const turn = service.startTurn({
      sessionId: session.id,
      subtaskId: subtask.id,
      author: 'leader',
      parts: [],
    })
    const out = service.finishTurn(
      endTurnResult(turn.id, session.id, {
        outcome: { kind: 'error', error: { code: 'silent_timeout', message: 'sem eventos' } },
      }),
    )
    expect(out.subtask).toMatchObject({
      state: 'failed',
      failureCode: 'silent_timeout',
      statusMessage: 'bloqueado: sem resposta',
    })
    expect(out.turn.error?.code).toBe('silent_timeout')
  })

  it('subtarefa cancelada no meio do turno continua cancelada', () => {
    const { service } = createHarness()
    const fx = seedTeam(service)
    const { subtask, session } = seedWorkingSubtask(service, fx)
    const turn = service.startTurn({
      sessionId: session.id,
      subtaskId: subtask.id,
      author: 'leader',
      parts: [],
    })
    service.transitionSubtask(subtask.id, 'canceled')
    expect(errorCode(() => service.recordDelivery(session.id, sampleDelivery('completed')))).toBe(
      'final_state',
    )
    const out = service.finishTurn(
      endTurnResult(turn.id, session.id, { finalText: 'STATUS: PRONTO' }),
    )
    expect(out.transitioned).toBe(false)
    expect(out.subtask.state).toBe('canceled')
    expect(out.turn.endedAt).not.toBeNull()
  })

  it('atividade: seq por sessão, paginação e texto cortado', () => {
    const { service } = createHarness()
    const fx = seedTeam(service)
    const { subtask, session } = seedWorkingSubtask(service, fx)
    const turn = service.startTurn({
      sessionId: session.id,
      subtaskId: subtask.id,
      author: 'leader',
      parts: [],
    })
    const drafts = Array.from({ length: 5 }, (_, i) => ({
      sessionId: session.id,
      subtaskId: subtask.id,
      turnId: turn.id,
      at: i,
      payload: { kind: 'text' as const, text: i === 4 ? 'x'.repeat(20_000) : `t${i}` },
    }))
    const written = service.appendActivity(drafts)
    expect(written.map((e) => e.seq)).toEqual([2, 3, 4, 5, 6])
    const p1 = service.listActivity(subtask.id, null, 3)
    expect(p1).toMatchObject({ lastSeq: 3, hasMore: true })
    const p2 = service.listActivity(subtask.id, p1.lastSeq, 3)
    expect(p2.events.map((e) => e.seq)).toEqual([4, 5, 6])
    expect(p2.hasMore).toBe(false)
    const last = p2.events.at(-1)?.payload
    expect(last?.kind === 'text' && last.text.length).toBe(16_000)
    expect(errorCode(() => service.appendActivity([{ ...drafts[0]!, subtaskId: 'outra' }]))).toBe(
      'invalid_input',
    )
  })
})

describe('TaskService: perguntas ao usuário', () => {
  it('abre, responde uma vez e valida itens e opções', () => {
    const { service } = createHarness()
    const fx = seedTeam(service)
    const q = service.createQuestion({
      taskId: fx.task.id,
      subtaskId: null,
      items: [
        {
          id: 'i1',
          prompt: 'Qual banco?',
          options: [
            { id: 'a', label: 'Postgres' },
            { id: 'b', label: 'SQLite' },
          ],
          multiSelect: false,
          allowFreeText: false,
        },
      ],
    })
    expect(service.listOpenQuestions(fx.project.id)).toEqual([q])
    expect(
      errorCode(() =>
        service.answerQuestion(q.id, [{ itemId: 'i1', optionIds: ['a', 'b'], text: null }]),
      ),
    ).toBe('invalid_input')
    expect(
      errorCode(() => service.answerQuestion(q.id, [{ itemId: 'zz', optionIds: [], text: 'x' }])),
    ).toBe('invalid_input')
    const answered = service.answerQuestion(q.id, [{ itemId: 'i1', optionIds: ['b'], text: null }])
    expect(answered.status).toBe('answered')
    expect(service.listOpenQuestions(fx.project.id)).toEqual([])
    expect(errorCode(() => service.dismissQuestion(q.id))).toBe('invalid_transition')
    expect(
      errorCode(() => service.createQuestion({ taskId: fx.task.id, subtaskId: null, items: [] })),
    ).toBe('invalid_input')
  })
})

describe('limites de agentes salvos', () => {
  it('valor corrompido ou fora de 1-100 vira sem limite, sem lançar', () => {
    const { service, store } = createHarness()
    const none = { maxLiveAgents: null, maxLiveMembersPerTask: null }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    store.setSetting('agentLimits', '{nao e json')
    expect(service.getAgentLimitSettings()).toEqual(none)
    store.setSetting('agentLimits', JSON.stringify({ maxLiveAgents: 0, maxLiveMembersPerTask: 2 }))
    expect(service.getAgentLimitSettings()).toEqual(none)
    expect(service.getAgentLimits().maxLiveAgents).toBe(Number.POSITIVE_INFINITY)
    expect(warn).toHaveBeenCalledTimes(3)
    warn.mockRestore()
  })

  it('ausente = sem limite; grava e lê de volta; null volta a sem limite', () => {
    const { service } = createHarness()
    expect(service.getAgentLimitSettings()).toEqual({
      maxLiveAgents: null,
      maxLiveMembersPerTask: null,
    })
    expect(service.getAgentLimits().maxLiveAgents).toBe(Number.POSITIVE_INFINITY)
    service.saveAgentLimitSettings({ maxLiveAgents: 7, maxLiveMembersPerTask: 2 })
    expect(service.getAgentLimitSettings()).toEqual({ maxLiveAgents: 7, maxLiveMembersPerTask: 2 })
    expect(service.getAgentLimits()).toEqual({ maxLiveAgents: 7, maxLiveMembersPerTask: 2 })
    service.saveAgentLimitSettings({ maxLiveAgents: null, maxLiveMembersPerTask: 3 })
    expect(service.getAgentLimitSettings()).toEqual({
      maxLiveAgents: null,
      maxLiveMembersPerTask: 3,
    })
    expect(limitsFromSettings({ maxLiveAgents: null, maxLiveMembersPerTask: null })).toEqual({
      maxLiveAgents: Number.POSITIVE_INFINITY,
      maxLiveMembersPerTask: Number.POSITIVE_INFINITY,
    })
  })
})

describe('nome da tarefa', () => {
  it('começa igual ao title; renomear muda só o name e emite task.upserted', () => {
    const { service } = createHarness()
    const fx = seedTeam(service)
    expect(fx.task.name).toBe(fx.task.title)
    const events: string[] = []
    service.subscribe((env) => events.push(env.event.type))
    const renamed = service.renameTask(fx.task.id, '  Login  ')
    expect(renamed).toMatchObject({ name: 'Login', title: 'Corrigir login' })
    expect(service.getTask(fx.task.id).name).toBe('Login')
    expect(events).toEqual(['task.upserted'])
  })

  it('nome em branco falha', () => {
    const { service } = createHarness()
    const fx = seedTeam(service)
    expect(errorCode(() => service.renameTask(fx.task.id, '   '))).toBe('invalid_input')
    expect(service.getTask(fx.task.id).name).toBe('Corrigir login')
  })
})

describe('comando de iniciar por tarefa', () => {
  it('guarda por tarefa, limpa a subpasta sem comando e recusa subpasta fora', () => {
    const { service } = createHarness()
    const fx = seedTeam(service)
    const other = service.createTask({
      projectId: fx.project.id,
      title: 'Outra',
      kind: 'team',
      worktreePath: '/wt/outra',
      branch: 'feat/outra',
      baseBranch: 'main',
      leadRoleId: null,
      soloProvider: null,
    })
    expect(fx.task).toMatchObject({ startCommand: null, startDir: null })
    service.setTaskStartCommand(fx.task.id, 'pnpm dev', 'apps/web')
    expect(service.getTask(fx.task.id)).toMatchObject({
      startCommand: 'pnpm dev',
      startDir: 'apps/web',
    })
    expect(service.getTask(other.id).startCommand).toBeNull()
    service.setTaskStartCommand(fx.task.id, null, 'apps/web')
    expect(service.getTask(fx.task.id)).toMatchObject({ startCommand: null, startDir: null })
    expect(errorCode(() => service.setTaskStartCommand(fx.task.id, 'x', '../fora'))).toBe(
      'invalid_input',
    )
    expect(errorCode(() => service.setTaskStartCommand(fx.task.id, 'x', '/etc'))).toBe(
      'invalid_input',
    )
  })
})
