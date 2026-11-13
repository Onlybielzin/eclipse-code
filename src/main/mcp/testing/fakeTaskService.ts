/**
 * TaskService em memoria so com o que o modulo mcp/ usa. Para testes: emite os
 * eventos depois de "gravar", como o real.
 */
import {
  DomainError,
  type Artifact,
  type Delivery,
  type DomainEvent,
  type DomainEventEnvelope,
  type Role,
  type Session,
  type Subtask,
  type SubtaskState,
  type Task,
  type Turn,
  type UserQuestion,
} from '@shared/domain'
import type { TaskService } from '@shared/ports'

export interface FakeTaskService extends TaskService {
  emit(event: DomainEvent): void
  seedSubtask(partial: Partial<Subtask> & { id: string }): Subtask
  setState(id: string, state: SubtaskState, statusMessage?: string | null): Subtask
  addArtifact(
    subtaskId: string,
    turnId: string,
    delivery: Partial<Delivery>,
    format?: Artifact['format'],
  ): Artifact
  endTurn(turn: Partial<Turn> & { id: string; subtaskId: string }): Turn
  sessions: Map<string, Session>
  questions: UserQuestion[]
  deliveries: { sessionId: string; delivery: Delivery }[]
}

export function createFakeTaskService(): FakeTaskService {
  let revision = 0
  const seq = 0
  const now = () => 1_000 + seq
  const listeners = new Set<(e: DomainEventEnvelope) => void>()
  let task: Task = {
    id: 'task1',
    projectId: 'proj1',
    contextId: 'ctx1',
    title: 'Tarefa',
    kind: 'team',
    worktreePath: '/tmp/wt',
    branch: 'eclipse/x',
    baseBranch: 'main',
    leadRoleId: 'lead',
    soloProvider: null,
    status: 'open',
    workflowStatus: 'em_andamento',
    createdAt: 1,
    updatedAt: 1,
    archivedAt: null,
  }
  const otherTask: Task = { ...task, id: 'task2', contextId: 'ctx2' }
  const role = (id: string, name: string, isLead = false): Role => ({
    id,
    projectId: 'proj1',
    name,
    description: '',
    provider: 'claude',
    model: null,
    promptTemplate: '',
    isLead,
    createdAt: 1,
    updatedAt: 1,
  })
  const roles = [role('lead', 'Líder', true), role('rev', 'Revisor'), role('dev', 'Dev')]
  const subtasks = new Map<string, Subtask>()
  const artifacts: Artifact[] = []
  const sessions = new Map<string, Session>()
  const questions: UserQuestion[] = []
  const deliveries: { sessionId: string; delivery: Delivery }[] = []

  const emit = (event: DomainEvent) => {
    const envelope = { revision: ++revision, at: now(), event }
    for (const l of [...listeners]) l(envelope)
  }
  const getSubtask = (id: string) => {
    const s = subtasks.get(id)
    if (!s) throw new DomainError('not_found', `subtarefa ${id} nao existe`)
    return s
  }
  const notImplemented = (name: string) => () => {
    throw new Error(`fake: ${name} nao implementado`)
  }
  const normalize = (s: string) =>
    s
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .toLowerCase()
      .trim()

  const fake: Partial<FakeTaskService> = {
    sessions,
    questions,
    deliveries,
    emit,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getTask(id) {
      if (id === task.id) return task
      if (id === otherTask.id) return otherTask
      throw new DomainError('not_found', 'tarefa')
    },
    concludeTask(id) {
      if (id !== task.id) throw new DomainError('not_found', 'tarefa')
      if (questions.some((q) => q.taskId === id && q.status === 'open')) {
        throw new DomainError('conflict', 'pergunta aberta')
      }
      task = { ...task, workflowStatus: 'em_revisao' }
      emit({ type: 'task.upserted', task })
      return task
    },
    listRoles: () => roles,
    getRole(id) {
      const r = roles.find((x) => x.id === id)
      if (!r) throw new DomainError('not_found', 'papel')
      return r
    },
    findRoleByName: (_p, name) => roles.find((r) => normalize(r.name) === normalize(name)) ?? null,
    listSubtasks: (taskId) => [...subtasks.values()].filter((s) => s.taskId === taskId),
    getSubtask,
    getSubtaskDetail(id) {
      const subtask = getSubtask(id)
      return {
        subtask,
        messages: [],
        artifacts: artifacts.filter((a) => a.subtaskId === id),
        turns: [],
        session: null,
      }
    },
    listTurnDeliveries: (turnId) => artifacts.filter((a) => a.turnId === turnId),
    getSession: (id) => {
      const session = sessions.get(id)
      if (!session) throw new DomainError('not_found', `sessao ${id} nao existe`)
      return session
    },
    getLiveLeaderSession: (taskId) =>
      [...sessions.values()].find(
        (s) => s.taskId === taskId && s.kind === 'leader-pty' && s.status !== 'exited',
      ) ?? null,
    recordDelivery(sessionId, delivery) {
      deliveries.push({ sessionId, delivery })
      return fake.addArtifact!('sub-of-' + sessionId, 'turn-' + sessionId, delivery)
    },
    createQuestion(input) {
      const q: UserQuestion = {
        id: `q${questions.length + 1}`,
        taskId: input.taskId,
        subtaskId: input.subtaskId,
        items: input.items,
        status: 'open',
        answers: null,
        createdAt: now(),
        answeredAt: null,
      }
      questions.push(q)
      emit({ type: 'question.upserted', question: q })
      return q
    },
    seedSubtask(partial) {
      const s: Subtask = {
        taskId: task.id,
        roleId: 'dev',
        title: `Sub ${partial.id}`,
        instructions: 'faça',
        state: 'submitted',
        statusMessage: null,
        failureCode: null,
        referenceTaskIds: [],
        sessionId: null,
        createdAt: now(),
        updatedAt: now(),
        finishedAt: null,
        ...partial,
      }
      subtasks.set(s.id, s)
      emit({ type: 'subtask.upserted', subtask: s })
      return s
    },
    setState(id, state, statusMessage) {
      const s = { ...getSubtask(id), state, updatedAt: now() }
      if (statusMessage !== undefined) s.statusMessage = statusMessage
      subtasks.set(id, s)
      emit({ type: 'subtask.upserted', subtask: s })
      return s
    },
    addArtifact(subtaskId, turnId, delivery, format = 'structured') {
      const a: Artifact = {
        id: `a${artifacts.length + 1}`,
        taskId: task.id,
        subtaskId,
        sessionId: 's',
        turnId,
        format,
        delivery: {
          state: 'completed',
          summary: 'feito',
          files: [],
          tests: [],
          questions: [],
          ...delivery,
        },
        parts: [],
        createdAt: now(),
      }
      artifacts.push(a)
      emit({ type: 'artifact.added', artifact: a })
      return a
    },
    endTurn(partial) {
      const t: Turn = {
        sessionId: 's',
        startedAt: 1,
        endedAt: 2,
        stopReason: 'end_turn',
        error: null,
        finalText: null,
        ...partial,
      }
      emit({ type: 'turn.upserted', turn: t })
      return t
    },
  }
  return new Proxy(fake, {
    get(target, prop: string) {
      if (prop in target) return target[prop as keyof typeof target]
      return notImplemented(prop)
    },
  }) as FakeTaskService
}

export function leaderSession(
  id: string,
  taskId = 'task1',
  status: Session['status'] = 'running',
): Session {
  return {
    id,
    taskId,
    subtaskId: null,
    roleId: 'lead',
    kind: 'leader-pty',
    provider: 'claude',
    model: null,
    cwd: '/tmp/wt',
    providerSessionId: null,
    pid: 1,
    status,
    activeTurnId: null,
    startedAt: 1,
    endedAt: null,
    endReason: null,
    exitCode: null,
  }
}
