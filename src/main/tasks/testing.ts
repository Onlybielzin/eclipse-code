/**
 * Utilidades de teste do modulo tasks/ (relogio e ids deterministicos, fixtures).
 * Usado so pelos testes; nao entra no app.
 */
import type { Delivery, Project, Role, Session, Subtask, Task, TurnResult } from '@shared/domain'
import type { Clock, IdFactory } from '@shared/ports'
import { openSqliteTaskStore, type SqliteTaskStore } from './sqliteTaskStore'
import { createTaskService, type SqliteTaskService } from './taskService'

export class FakeClock implements Clock {
  constructor(public time = 1_000) {}
  now(): number {
    return this.time++
  }
}

export class SeqIds implements IdFactory {
  private n = 0
  constructor(private readonly prefix = 'id') {}
  newId(): string {
    this.n += 1
    return `${this.prefix}-${this.n}`
  }
}

export interface Harness {
  store: SqliteTaskStore
  service: SqliteTaskService
  clock: FakeClock
}

export function createHarness(filename = ':memory:', idPrefix = 'id'): Harness {
  const store = openSqliteTaskStore({ filename })
  const clock = new FakeClock()
  const service = createTaskService({ store, clock, ids: new SeqIds(idPrefix) })
  return { store, service, clock }
}

export interface TeamFixture {
  project: Project
  lead: Role
  dev: Role
  task: Task
}

export function seedTeam(service: SqliteTaskService, rootPath = '/repo/projeto'): TeamFixture {
  const project = service.addProject({ rootPath })
  // Os testes montam o proprio time: tira o time padrao que o projeto novo ganha.
  for (const role of service.listRoles(project.id)) service.deleteRole(role.id)
  const lead = service.saveRole({
    projectId: project.id,
    name: 'Líder',
    description: 'coordena',
    provider: 'claude',
    model: 'opus',
    promptTemplate: 'Você é o Líder de {{tarefa}}',
    isLead: true,
  })
  const dev = service.saveRole({
    projectId: project.id,
    name: 'Dev 1',
    description: 'implementa',
    provider: 'codex',
    model: null,
    promptTemplate: 'Você é o Dev',
    isLead: false,
  })
  const task = service.createTask({
    projectId: project.id,
    title: 'Corrigir login',
    kind: 'team',
    worktreePath: '/wt/corrigir-login',
    branch: 'feat/corrigir-login',
    baseBranch: 'main',
    leadRoleId: null,
    soloProvider: null,
  })
  return { project, lead, dev, task }
}

/** Subtarefa ja com sessao de membro aberta e em 'working', pronta para turno. */
export function seedWorkingSubtask(
  service: SqliteTaskService,
  fx: TeamFixture,
  title = 'Implementar rota',
): { subtask: Subtask; session: Session } {
  const created = service.createSubtask({
    taskId: fx.task.id,
    roleId: fx.dev.id,
    title,
    instructions: 'faça a rota',
    referenceTaskIds: [],
  })
  const session = service.openSession({
    taskId: fx.task.id,
    subtaskId: created.id,
    roleId: fx.dev.id,
    kind: 'member-acp',
    provider: 'codex',
    model: null,
    cwd: '/wt/corrigir-login',
    providerSessionId: 'acp-1',
  })
  service.attachSubtaskSession(created.id, session.id)
  const subtask = service.transitionSubtask(created.id, 'working')
  return { subtask, session }
}

export const sampleDelivery = (state: Delivery['state'], summary = 'feito'): Delivery => ({
  state,
  summary,
  files: [{ path: 'src/a.ts', change: 'modified' }],
  tests: [{ command: 'pnpm test', result: '3 passed', passed: true }],
  questions: [],
})

export function endTurnResult(
  turnId: string,
  sessionId: string,
  partial: Partial<TurnResult> = {},
): TurnResult {
  return {
    turnId,
    sessionId,
    outcome: { kind: 'stopped', stopReason: 'end_turn' },
    finalText: '',
    deliveries: [],
    startedAt: 1,
    endedAt: 2,
    ...partial,
  }
}
