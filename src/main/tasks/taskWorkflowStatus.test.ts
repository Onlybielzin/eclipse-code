// Status de trabalho da tarefa (a_fazer ... lancado): regras automaticas, pedidos do
// usuario e do agente, e a migracao 3. SQLite em memoria, nenhum processo.
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import {
  DomainError,
  TASK_WORKFLOW_STATUSES,
  type DomainEventEnvelope,
  type QuestionItem,
  type TaskWorkflowStatus,
} from '@shared/domain'
import { nextTaskWorkflowStatus, type TaskWorkflowSignal } from '@shared/taskWorkflow'
import { MIGRATIONS } from './migrations'
import { migrate, SqliteTaskStore } from './sqliteTaskStore'
import { createHarness, seedTeam, type TeamFixture } from './testing'
import type { SqliteTaskService } from './taskService'

function errorCode(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    if (error instanceof DomainError) return error.code
    throw error
  }
  throw new Error('esperava DomainError')
}

const ITEMS: QuestionItem[] = [
  { id: 'i1', prompt: 'Qual banco?', options: [], multiSelect: false, allowFreeText: true },
]

function setup(): { service: SqliteTaskService; fx: TeamFixture } {
  const { service } = createHarness()
  return { service, fx: seedTeam(service) }
}

function statusOf(service: SqliteTaskService, fx: TeamFixture): TaskWorkflowStatus {
  return service.getTask(fx.task.id).workflowStatus
}

/** Leva a tarefa a um status pelo menu do usuario (lancado usa o arquivar). */
function force(service: SqliteTaskService, fx: TeamFixture, to: TaskWorkflowStatus): void {
  service.setTaskWorkflowStatus(fx.task.id, to, 'user')
  expect(statusOf(service, fx)).toBe(to)
}

function startSubtask(service: SqliteTaskService, fx: TeamFixture): string {
  const sub = service.createSubtask({
    taskId: fx.task.id,
    roleId: fx.dev.id,
    title: 'rota',
    instructions: 'faça',
    referenceTaskIds: [],
  })
  return sub.id
}

describe('regra pura nextTaskWorkflowStatus', () => {
  const signals: TaskWorkflowSignal[] = [
    'work_started',
    'question_opened',
    'questions_cleared',
    'leader_concluded',
  ]

  it('automação nunca produz pronto_lancar nem lancado e nunca tira de lancado', () => {
    for (const from of TASK_WORKFLOW_STATUSES) {
      for (const signal of signals) {
        const to = nextTaskWorkflowStatus(from, signal)
        expect(to === 'pronto_lancar' || to === 'lancado' || to === 'cancelado').toBe(false)
        if (from === 'lancado' || from === 'cancelado') expect(to).toBeNull()
      }
    }
  })
})

describe('TaskService: status automático da tarefa', () => {
  it('tarefa nova (time e avulso) começa em a_fazer', () => {
    const { service, fx } = setup()
    expect(fx.task.workflowStatus).toBe('a_fazer')
    const solo = service.createTask({
      projectId: fx.project.id,
      title: 'conversa',
      kind: 'solo',
      worktreePath: null,
      branch: null,
      baseBranch: null,
      leadRoleId: null,
      soloProvider: 'claude',
    })
    expect(solo.workflowStatus).toBe('a_fazer')
    expect(service.markTaskWorkStarted(solo.id).workflowStatus).toBe('em_andamento')
  })

  it('Líder começa a trabalhar: a_fazer e em_revisao viram em_andamento', () => {
    const { service, fx } = setup()
    expect(service.markTaskWorkStarted(fx.task.id).workflowStatus).toBe('em_andamento')
    force(service, fx, 'em_revisao')
    expect(service.markTaskWorkStarted(fx.task.id).workflowStatus).toBe('em_andamento')
  })

  it('trabalho começando não mexe em pergunta nem em pronto_lancar', () => {
    const { service, fx } = setup()
    force(service, fx, 'pergunta')
    expect(service.markTaskWorkStarted(fx.task.id).workflowStatus).toBe('pergunta')
    force(service, fx, 'pronto_lancar')
    expect(service.markTaskWorkStarted(fx.task.id).workflowStatus).toBe('pronto_lancar')
  })

  it('subtarefa entrando em working põe a tarefa em andamento, na mesma escrita', () => {
    const { service, fx } = setup()
    const id = startSubtask(service, fx)
    expect(statusOf(service, fx)).toBe('a_fazer')
    const events: DomainEventEnvelope[] = []
    service.subscribe((e) => events.push(e))
    service.transitionSubtask(id, 'working')
    expect(statusOf(service, fx)).toBe('em_andamento')
    expect(events.map((e) => e.event.type)).toEqual(['subtask.upserted', 'task.upserted'])
  })

  it('pergunta pendente leva a pergunta; sem pendente volta a em_andamento', () => {
    const { service, fx } = setup()
    force(service, fx, 'em_revisao')
    const q1 = service.createQuestion({ taskId: fx.task.id, subtaskId: null, items: ITEMS })
    expect(statusOf(service, fx)).toBe('pergunta')
    // A segunda substitui a primeira: a tarefa continua em pergunta.
    const q2 = service.createQuestion({ taskId: fx.task.id, subtaskId: null, items: ITEMS })
    expect(service.getQuestion(q1.id).status).toBe('superseded')
    expect(statusOf(service, fx)).toBe('pergunta')
    service.dismissQuestion(q2.id)
    expect(statusOf(service, fx)).toBe('em_andamento')
  })

  it('pergunta fechada não mexe se o usuário já tirou a tarefa de pergunta', () => {
    const { service, fx } = setup()
    const q = service.createQuestion({ taskId: fx.task.id, subtaskId: null, items: ITEMS })
    force(service, fx, 'em_revisao')
    service.dismissQuestion(q.id)
    expect(statusOf(service, fx)).toBe('em_revisao')
  })

  it('Líder conclui: vai para em_revisao', () => {
    const { service, fx } = setup()
    service.markTaskWorkStarted(fx.task.id)
    expect(service.concludeTask(fx.task.id).workflowStatus).toBe('em_revisao')
    // Concluir de novo não gera escrita nova.
    const events: DomainEventEnvelope[] = []
    service.subscribe((e) => events.push(e))
    expect(service.concludeTask(fx.task.id).workflowStatus).toBe('em_revisao')
    // O status nao muda, mas o sinal conta como atividade (updatedAt).
    expect(events.map((e) => e.event.type)).toEqual(['task.upserted'])
  })

  it('Líder não conclui com pergunta pendente', () => {
    const { service, fx } = setup()
    service.createQuestion({ taskId: fx.task.id, subtaskId: null, items: ITEMS })
    expect(errorCode(() => service.concludeTask(fx.task.id))).toBe('conflict')
    expect(statusOf(service, fx)).toBe('pergunta')
  })

  it.each(['lancado', 'cancelado'] as const)('%s é final para a automação', (final) => {
    const { service, fx } = setup()
    force(service, fx, final)
    expect(service.getTask(fx.task.id).status).toBe('archived')
    expect(service.markTaskWorkStarted(fx.task.id).workflowStatus).toBe(final)
    expect(errorCode(() => service.concludeTask(fx.task.id))).toBe('invalid_transition')
    expect(
      errorCode(() => service.setTaskWorkflowStatus(fx.task.id, 'em_andamento', 'agent')),
    ).toBe('invalid_transition')
    // Tarefa arquivada nao aceita pergunta nova (I4), entao nada a sinalizar.
    expect(
      errorCode(() =>
        service.createQuestion({ taskId: fx.task.id, subtaskId: null, items: ITEMS }),
      ),
    ).toBe('conflict')
    expect(statusOf(service, fx)).toBe(final)
  })
})

describe('TaskService: quem pode escolher o status', () => {
  it.each(['pronto_lancar', 'lancado', 'cancelado'] as const)('agente não marca %s', (to) => {
    const { service, fx } = setup()
    service.markTaskWorkStarted(fx.task.id)
    expect(errorCode(() => service.setTaskWorkflowStatus(fx.task.id, to, 'agent'))).toBe(
      'forbidden',
    )
    expect(statusOf(service, fx)).toBe('em_andamento')
    expect(service.getTask(fx.task.id).status).toBe('open')
  })

  it('usuário escolhe qualquer status, em qualquer ordem', () => {
    const { service, fx } = setup()
    for (const to of [...TASK_WORKFLOW_STATUSES].reverse()) force(service, fx, to)
    expect(service.getTask(fx.task.id).status).toBe('open')
  })

  it('lancado arquiva pelo mesmo caminho do arquivar e sair de lancado reabre', () => {
    const { service, fx } = setup()
    const id = startSubtask(service, fx)
    const q = service.createQuestion({ taskId: fx.task.id, subtaskId: null, items: ITEMS })
    const lancada = service.setTaskWorkflowStatus(fx.task.id, 'lancado', 'user')
    expect(lancada).toMatchObject({ status: 'archived', workflowStatus: 'lancado' })
    expect(lancada.archivedAt).not.toBeNull()
    expect(service.getSubtask(id).state).toBe('canceled')
    expect(service.getQuestion(q.id).status).toBe('dismissed')

    const reaberta = service.setTaskWorkflowStatus(fx.task.id, 'em_revisao', 'user')
    expect(reaberta).toMatchObject({
      status: 'open',
      workflowStatus: 'em_revisao',
      archivedAt: null,
    })
  })

  it('cancelado arquiva como lancado, fecha subtarefas e perguntas; trocar entre os dois mantém arquivada', () => {
    const { service, fx } = setup()
    const id = startSubtask(service, fx)
    const q = service.createQuestion({ taskId: fx.task.id, subtaskId: null, items: ITEMS })
    const cancelada = service.setTaskWorkflowStatus(fx.task.id, 'cancelado', 'user')
    expect(cancelada).toMatchObject({ status: 'archived', workflowStatus: 'cancelado' })
    expect(cancelada.archivedAt).not.toBeNull()
    expect(service.getSubtask(id).state).toBe('canceled')
    expect(service.getQuestion(q.id).status).toBe('dismissed')

    const lancada = service.setTaskWorkflowStatus(fx.task.id, 'lancado', 'user')
    expect(lancada).toMatchObject({
      status: 'archived',
      workflowStatus: 'lancado',
      archivedAt: cancelada.archivedAt,
    })
    expect(service.setTaskWorkflowStatus(fx.task.id, 'cancelado', 'user')).toMatchObject({
      status: 'archived',
      workflowStatus: 'cancelado',
    })
    expect(service.setTaskWorkflowStatus(fx.task.id, 'a_fazer', 'user')).toMatchObject({
      status: 'open',
      workflowStatus: 'a_fazer',
      archivedAt: null,
    })
  })

  it('arquivar pode marcar cancelado', () => {
    const { service, fx } = setup()
    expect(service.markTaskArchived(fx.task.id, 'cancelado').workflowStatus).toBe('cancelado')
  })

  it('lancar com agente aberto é recusado como no arquivar', () => {
    const { service, fx } = setup()
    service.openSession({
      taskId: fx.task.id,
      subtaskId: null,
      roleId: fx.lead.id,
      kind: 'leader-pty',
      provider: 'claude',
      model: null,
      cwd: '/wt',
      providerSessionId: null,
    })
    expect(errorCode(() => service.setTaskWorkflowStatus(fx.task.id, 'lancado', 'user'))).toBe(
      'conflict',
    )
    expect(service.getTask(fx.task.id)).toMatchObject({ status: 'open', workflowStatus: 'a_fazer' })
  })

  it('arquivar marca lancado (status arquivado <=> lancado)', () => {
    const { service, fx } = setup()
    expect(service.markTaskArchived(fx.task.id).workflowStatus).toBe('lancado')
  })

  it('status persiste no SQLite', () => {
    const { service, store } = createHarness()
    const fx = seedTeam(service)
    service.concludeTask(fx.task.id)
    expect(store.getTask(fx.task.id)?.workflowStatus).toBe('em_revisao')
  })
})

describe('migração 3', () => {
  it('tarefas existentes viram a_fazer, ou lancado se arquivadas', () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    for (const m of MIGRATIONS.filter((x) => x.version <= 2)) db.exec(m.sql)
    db.pragma('user_version = 2')
    db.exec(`
      INSERT INTO projects VALUES ('p', 'p', '/p', 1, 1);
      INSERT INTO tasks (id, project_id, context_id, title, kind, status, created_at, updated_at, archived_at)
        VALUES ('aberta', 'p', 'c1', 'A', 'solo', 'open', 1, 1, NULL),
               ('velha', 'p', 'c2', 'B', 'solo', 'archived', 1, 1, 2);
    `)
    expect(migrate(db)).toBeGreaterThanOrEqual(3)
    const store = new SqliteTaskStore(db)
    expect(store.getTask('aberta')?.workflowStatus).toBe('a_fazer')
    expect(store.getTask('velha')?.workflowStatus).toBe('lancado')
    expect(() =>
      db.prepare("UPDATE tasks SET workflow_status = 'feito' WHERE id = 'aberta'").run(),
    ).toThrow(/CHECK/)
  })
})

describe('migração 10', () => {
  it('aceita cancelado e mantém tarefas, subtarefas e sessões', () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    for (const m of MIGRATIONS.filter((x) => x.version <= 9)) db.exec(m.sql)
    db.pragma('user_version = 9')
    db.exec(`
      INSERT INTO projects VALUES ('p', 'p', '/p', 1, 1);
      INSERT INTO tasks (id, project_id, context_id, title, kind, status, created_at, updated_at, archived_at)
        VALUES ('aberta', 'p', 'c1', 'A', 'solo', 'open', 1, 1, NULL),
               ('velha', 'p', 'c2', 'B', 'solo', 'archived', 1, 1, 2);
      INSERT INTO sessions (id, task_id, kind, provider, cwd, status, started_at)
        VALUES ('s1', 'aberta', 'leader-pty', 'claude', '/wt', 'exited', 1);
    `)
    db.exec("UPDATE tasks SET workflow_status = 'lancado' WHERE id = 'velha'")
    const subtasks = db.prepare('SELECT COUNT(*) AS n FROM subtasks').get() as { n: number }
    expect(migrate(db)).toBeGreaterThanOrEqual(10)
    expect(db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 1 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM subtasks').get()).toEqual(subtasks)
    const store = new SqliteTaskStore(db)
    expect(store.getTask('aberta')?.workflowStatus).toBe('a_fazer')
    expect(store.getTask('velha')?.workflowStatus).toBe('lancado')
    db.prepare("UPDATE tasks SET workflow_status = 'cancelado' WHERE id = 'aberta'").run()
    expect(store.getTask('aberta')?.workflowStatus).toBe('cancelado')
    expect(() =>
      db.prepare("UPDATE tasks SET workflow_status = 'feito' WHERE id = 'aberta'").run(),
    ).toThrow(/CHECK/)
    expect(db.pragma('foreign_key_check')).toEqual([])
  })
})

describe('TaskService: última atividade', () => {
  function setupClock() {
    const { service } = createHarness()
    return { service, fx: seedTeam(service) }
  }

  it('sinal sem mudança de status avança o updatedAt', () => {
    const { service, fx } = setupClock()
    service.markTaskWorkStarted(fx.task.id)
    const before = service.getTask(fx.task.id).updatedAt
    const task = service.markTaskWorkStarted(fx.task.id)
    expect(task.workflowStatus).toBe('em_andamento')
    expect(task.updatedAt).toBeGreaterThan(before)
  })

  it('touchTask avança o updatedAt, emite e não muda status nem arquivamento', () => {
    const { service, fx } = setupClock()
    const events: DomainEventEnvelope[] = []
    service.subscribe((e) => events.push(e))
    const before = service.getTask(fx.task.id)
    const task = service.touchTask(fx.task.id)
    expect(task.updatedAt).toBeGreaterThan(before.updatedAt)
    expect(task).toMatchObject({ workflowStatus: before.workflowStatus, status: before.status })
    expect(events.map((e) => e.event.type)).toEqual(['task.upserted'])
  })

  it('subtarefa indo a estado final avança o updatedAt da tarefa', () => {
    const { service, fx } = setupClock()
    const id = startSubtask(service, fx)
    service.transitionSubtask(id, 'working')
    const before = service.getTask(fx.task.id).updatedAt
    service.transitionSubtask(id, 'completed')
    expect(service.getTask(fx.task.id).updatedAt).toBeGreaterThan(before)
  })
})
