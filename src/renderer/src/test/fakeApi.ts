/**
 * EclipseApi falsa para os testes da tela. Responde comandos a partir de dados em
 * memoria e deixa o teste emitir eventos como o main faria.
 */
import type { BrainGraph, MemoryDetail } from '@shared/brain'
import type {
  ActivityEvent,
  Artifact,
  DomainEvent,
  Project,
  Role,
  Session,
  Subtask,
  Task,
  UserQuestion,
} from '@shared/domain'
import type { WallSnapshot } from '@shared/wall'
import type {
  TaskProcessState,
  EclipseApi,
  IpcCommandChannel,
  IpcEventChannel,
  IpcEvents,
  IpcResult,
  PickedFolder,
  UpdateCheck,
  UpdateState,
  WhatsNew,
} from '@shared/ipc'

const T0 = 1_700_000_000_000

export function makeProject(): Project {
  return { id: 'p1', name: 'ereemby', rootPath: '/repo/ereemby', createdAt: T0, updatedAt: T0 }
}

export function makeRole(id: string, name: string, extra: Partial<Role> = {}): Role {
  return {
    id,
    projectId: 'p1',
    name,
    description: '',
    provider: 'claude',
    model: 'sonnet',
    promptTemplate: '',
    isLead: false,
    access: 'full',
    createdAt: T0,
    updatedAt: T0,
    ...extra,
  }
}

export function makeTask(id: string, title: string, extra: Partial<Task> = {}): Task {
  return {
    id,
    projectId: 'p1',
    contextId: `ctx-${id}`,
    title,
    kind: 'team',
    worktreePath: `/repo/wt/${id}`,
    branch: id,
    baseBranch: 'main',
    leadRoleId: 'lead',
    soloProvider: null,
    status: 'open',
    workflowStatus: 'em_andamento',
    startCommand: null,
    startDir: null,
    createdAt: T0,
    updatedAt: T0,
    archivedAt: null,
    ...extra,
  }
}

export function makeSubtask(id: string, taskId: string, extra: Partial<Subtask> = {}): Subtask {
  return {
    id,
    taskId,
    roleId: 'dev',
    title: `subtarefa ${id}`,
    instructions: 'faça o trabalho',
    state: 'working',
    statusMessage: null,
    failureCode: null,
    referenceTaskIds: [],
    sessionId: `sess-${id}`,
    createdAt: T0,
    updatedAt: T0,
    finishedAt: null,
    ...extra,
  }
}

export function makeArtifact(subtask: Subtask, summary: string): Artifact {
  return {
    id: `art-${subtask.id}`,
    taskId: subtask.taskId,
    subtaskId: subtask.id,
    sessionId: subtask.sessionId ?? 's',
    turnId: 'turn1',
    format: 'structured',
    delivery: {
      state: 'completed',
      summary,
      files: [{ path: 'src/reports/report.ts', change: 'modified' }],
      tests: [{ command: 'npm run analise', result: 'limpo', passed: true }],
      questions: [],
    },
    parts: [],
    createdAt: T0 + 1000,
  }
}

export function makeActivity(
  subtask: Subtask,
  seq: number,
  payload: ActivityEvent['payload'],
): ActivityEvent {
  return {
    seq,
    sessionId: subtask.sessionId ?? 's',
    subtaskId: subtask.id,
    turnId: 'turn1',
    at: T0 + seq * 1000,
    payload,
  }
}

export interface FakeData {
  projects: Project[]
  roles: Role[]
  tasks: Task[]
  subtasks: Subtask[]
  artifacts: Artifact[]
  activity: ActivityEvent[]
  questions: UserQuestion[]
  scrollback: Record<string, string>
}

type Listener = (payload: unknown) => void

export class FakeApi implements EclipseApi {
  readonly calls: { channel: string; input: unknown }[] = []
  private readonly listeners = new Map<string, Set<Listener>>()
  private revision = 0
  /** Respostas fixas que sobrescrevem a logica padrao. */
  readonly overrides = new Map<string, (input: unknown) => IpcResult<unknown>>()

  /** Resposta do explorador de pastas no proximo projects.pickFolder (null = cancelou). */
  nextPickedFolder: PickedFolder | null = null

  /** Limites devolvidos por settings.get / gravados por settings.save. */
  agentLimits: { maxLiveAgents: number | null; maxLiveMembersPerTask: number | null } = {
    maxLiveAgents: null,
    maxLiveMembersPerTask: null,
  }

  /** Chave do Cerebro guardada pelo fake (so o final sai em brain.status). */
  brainKey: string | null = null
  brainGraph: BrainGraph = { nodes: [], edges: [] }
  brainMemory: MemoryDetail = {
    id: 'm1',
    type: 'learning',
    scope: 'global',
    importance: 5,
    created: '2026-11-01T00:00:00Z',
    body: 'corpo',
    links: [],
    backlinks: [],
  }

  /** Estado devolvido por update.state e notas devolvidas por app.whatsNew (ate app.whatsNewSeen). */
  updateState: UpdateState = { status: 'idle', version: null }
  whatsNew: WhatsNew | null = null
  /** Resultado devolvido por update.check. */
  updateCheck: UpdateCheck = { current: '0.1.3', available: null }
  /** Retrato devolvido por wall.snapshot. */
  wallSnapshot: WallSnapshot = {
    at: T0,
    tasks: [],
    workingAgents: 0,
    maxLiveAgents: null,
    doneToday: 0,
    inReview: 0,
    openQuestions: 0,
  }

  /** Processos das abas Iniciar e Terminal, por `${taskId}:${kind}`. */
  readonly processes = new Map<string, TaskProcessState>()
  private processSeq = 0

  /** Home devolvida em projects.summary. */
  homeDir = '/home/vings'

  constructor(readonly data: FakeData) {}

  invoke: EclipseApi['invoke'] = async (channel, input) => {
    this.calls.push({ channel, input })
    const override = this.overrides.get(channel)
    if (override) return override(input) as never
    return { ok: true, value: this.handle(channel, input as Record<string, unknown>) } as never
  }

  on: EclipseApi['on'] = (channel, listener) => {
    const set = this.listeners.get(channel) ?? new Set<Listener>()
    set.add(listener as Listener)
    this.listeners.set(channel, set)
    return () => {
      set.delete(listener as Listener)
    }
  }

  emit<C extends IpcEventChannel>(channel: C, payload: IpcEvents[C]): void {
    for (const l of this.listeners.get(channel) ?? []) l(payload)
  }

  /** Emite um domain.event com revisao nova (ou a informada). */
  emitDomain(event: DomainEvent, revision?: number): void {
    const rev = revision ?? ++this.revision
    this.revision = Math.max(this.revision, rev)
    this.emit('domain.event', { revision: rev, at: Date.now(), event })
  }

  callsTo(channel: IpcCommandChannel): unknown[] {
    return this.calls.filter((c) => c.channel === channel).map((c) => c.input)
  }

  private handle(channel: IpcCommandChannel, input: Record<string, unknown>): unknown {
    const d = this.data
    switch (channel) {
      case 'projects.list':
        return d.projects
      case 'projects.pickFolder':
        return this.nextPickedFolder
      case 'projects.add': {
        const rootPath = String(input.rootPath)
        const project: Project = {
          id: `p-new-${d.projects.length + 1}`,
          rootPath,
          name: (input.name as string | undefined) ?? rootPath.split('/').pop() ?? rootPath,
          createdAt: T0,
          updatedAt: T0,
        }
        d.projects.push(project)
        return project
      }
      case 'projects.update': {
        const project = d.projects.find((p) => p.id === input.projectId)
        if (!project) throw new Error('projeto não encontrado')
        project.name = String(input.name)
        return project
      }
      case 'projects.remove':
        d.projects = d.projects.filter((p) => p.id !== input.projectId)
        return undefined
      case 'update.state':
        return this.updateState
      case 'update.check':
        return this.updateCheck
      case 'update.install':
      case 'app.whatsNewSeen':
        if (channel === 'app.whatsNewSeen') this.whatsNew = null
        return undefined
      case 'app.whatsNew':
        return this.whatsNew
      case 'settings.get':
        return this.agentLimits
      case 'settings.save':
        this.agentLimits = input as typeof this.agentLimits
        return this.agentLimits
      case 'brain.status':
      case 'brain.setKey':
        if (channel === 'brain.setKey') this.brainKey = input.key as string | null
        return {
          hasKey: this.brainKey !== null,
          keyLast4: this.brainKey?.slice(-4) ?? null,
          connected: false,
          lastError: null,
        }
      case 'wall.snapshot':
        return this.wallSnapshot
      case 'brain.graph':
        return this.brainGraph
      case 'brain.memory':
        return this.brainMemory
      case 'brain.subscribe':
      case 'brain.unsubscribe':
        return undefined
      case 'projects.summary':
        return {
          homeDir: this.homeDir,
          projects: d.projects.map((p) => {
            const taskIds = new Set(d.tasks.filter((t) => t.projectId === p.id).map((t) => t.id))
            return {
              projectId: p.id,
              openTasks: d.tasks.filter((t) => t.projectId === p.id && t.status === 'open').length,
              needsYou: d.questions.filter((q) => q.status === 'open' && taskIds.has(q.taskId))
                .length,
            }
          }),
        }
      case 'roles.list':
        return d.roles
      case 'tasks.list':
        return d.tasks.filter((t) => t.projectId === input.projectId)
      case 'questions.list': {
        const taskIds = new Set(
          d.tasks.filter((t) => t.projectId === input.projectId).map((t) => t.id),
        )
        return d.questions.filter((q) => q.status === 'open' && taskIds.has(q.taskId))
      }
      case 'subtasks.list':
        return d.subtasks.filter((s) => s.taskId === input.taskId)
      case 'subtasks.detail': {
        const subtask = d.subtasks.find((s) => s.id === input.subtaskId)
        if (!subtask) throw new Error('subtarefa inexistente no fake')
        return {
          subtask,
          messages: [],
          artifacts: d.artifacts.filter((a) => a.subtaskId === subtask.id),
          turns: [],
          session: null,
        }
      }
      case 'activity.list': {
        const after = (input.afterSeq as number | undefined) ?? 0
        const events = d.activity.filter((e) => e.subtaskId === input.subtaskId && e.seq > after)
        return { events, lastSeq: events.at(-1)?.seq ?? null, hasMore: false }
      }
      case 'leader.ensure': {
        const session: Session = {
          id: `lead-${String(input.taskId)}`,
          taskId: String(input.taskId),
          subtaskId: null,
          roleId: 'lead',
          kind: 'leader-pty',
          provider: 'claude',
          model: 'opus',
          cwd: '/repo',
          providerSessionId: null,
          pid: 1,
          status: 'running',
          activeTurnId: null,
          startedAt: T0,
          endedAt: null,
          endReason: null,
          exitCode: null,
        }
        return session
      }
      case 'terminal.attach':
        return {
          sessionId: input.sessionId,
          alive: true,
          cols: 80,
          rows: 24,
          scrollback: d.scrollback[String(input.sessionId)] ?? '',
        }
      case 'terminal.write':
      case 'terminal.resize':
        return undefined
      case 'tasks.setStartCommand': {
        const task = d.tasks.find((t) => t.id === input.taskId)
        if (!task) throw new Error('tarefa inexistente no fake')
        task.startCommand = input.command as string | null
        task.startDir = input.dir as string | null
        this.emitDomain({ type: 'task.upserted', task: { ...task } })
        return task
      }
      case 'taskProcess.attach':
      case 'taskProcess.start':
      case 'taskProcess.stop': {
        const key = `${String(input.taskId)}:${String(input.kind)}`
        const cur = this.processes.get(key)
        if (channel === 'taskProcess.stop') {
          if (cur) this.processes.set(key, { ...cur, alive: false, exited: true, exitCode: 0 })
          return undefined
        }
        if (channel === 'taskProcess.start' && (!cur?.alive || input.restart)) {
          this.processes.set(key, {
            ptyId: `tp-${key}-${++this.processSeq}`,
            alive: true,
            cols: 80,
            rows: 24,
            scrollback: '',
            exitCode: null,
            exited: false,
            cwd: '/repo/wt',
          })
        }
        return (
          this.processes.get(key) ?? {
            ptyId: null,
            alive: false,
            cols: 80,
            rows: 24,
            scrollback: '',
            exitCode: null,
            exited: false,
            cwd: '/repo/wt',
          }
        )
      }
      case 'tasks.create': {
        const task = makeTask(`t-new-${d.tasks.length + 1}`, String(input.title), {
          kind: input.kind as Task['kind'],
          leadRoleId: input.kind === 'team' ? 'lead' : null,
          soloProvider: (input.soloProvider as Task['soloProvider']) ?? null,
          createdAt: T0 + 10_000,
        })
        d.tasks.push(task)
        return task
      }
      case 'tasks.setStatus': {
        const current = d.tasks.find((t) => t.id === input.taskId)
        if (!current) throw new Error('tarefa inexistente no fake')
        const status = input.status as Task['workflowStatus']
        const next: Task = {
          ...current,
          workflowStatus: status,
          status: status === 'lancado' ? 'archived' : 'open',
          archivedAt: status === 'lancado' ? T0 + 60_000 : null,
          updatedAt: current.updatedAt + 1,
        }
        d.tasks = d.tasks.map((t) => (t.id === next.id ? next : t))
        return next
      }
      case 'questions.answer':
      case 'questions.dismiss': {
        const q = d.questions.find((x) => x.id === input.questionId)
        if (!q) throw new Error('pergunta inexistente no fake')
        const next: UserQuestion = {
          ...q,
          status: channel === 'questions.answer' ? 'answered' : 'dismissed',
          answers:
            channel === 'questions.answer' ? (input.answers as UserQuestion['answers']) : null,
        }
        d.questions = d.questions.map((x) => (x.id === q.id ? next : x))
        return next
      }
      default:
        throw new Error(`comando sem resposta no fake: ${channel}`)
    }
  }
}

/** Cenario da maquete: uma tarefa de time com 3 subtarefas, uma duvida aberta e um avulso. */
export function mockupData(): FakeData {
  const d1 = makeSubtask('d1', 't1', {
    title: 'group_by=offer em report.ts',
    state: 'completed',
    finishedAt: T0 + 5 * 60_000,
  })
  const d2 = makeSubtask('d2', 't1', {
    title: 'source_name da venda mais recente',
    state: 'input_required',
  })
  const tst = makeSubtask('t', 't1', { roleId: 'qa', title: 'Cobrir by_offer', state: 'working' })
  return {
    projects: [makeProject()],
    roles: [
      makeRole('lead', 'Líder', { model: 'opus', isLead: true }),
      makeRole('dev', 'Dev'),
      makeRole('qa', 'Testes', { provider: 'codex', model: null }),
    ],
    tasks: [
      makeTask('t1', 'feat-orfer-e-up'),
      makeTask('solo1', 'conversa solta', {
        kind: 'solo',
        leadRoleId: null,
        soloProvider: 'claude',
        worktreePath: null,
        branch: null,
        baseBranch: null,
        workflowStatus: 'a_fazer',
      }),
      makeTask('old1', 'checkout antigo', {
        status: 'archived',
        workflowStatus: 'lancado',
        archivedAt: T0 + 1000,
      }),
    ],
    subtasks: [d1, d2, tst],
    artifacts: [makeArtifact(d1, 'Adicionei group_by=offer e computeAdditionalRevenueByOffer.')],
    activity: [
      makeActivity(d1, 1, { kind: 'prompt', text: 'faça o group_by' }),
      makeActivity(d1, 2, {
        kind: 'tool_call',
        toolCallId: 'c1',
        title: 'Ler report.ts',
        toolKind: 'read',
        status: 'completed',
        input: null,
      }),
      makeActivity(d1, 3, { kind: 'text', text: 'Pronto, group_by adicionado.' }),
      makeActivity(d1, 4, { kind: 'turn_end', stopReason: 'end_turn', error: null }),
    ],
    questions: [
      {
        id: 'q1',
        taskId: 't1',
        subtaskId: 'd2',
        items: [
          {
            id: 'i1',
            prompt: 'Quando a venda mais recente não tem source_name, o relatório mostra:',
            options: [
              { id: 'o1', label: 'Vazio (null)' },
              { id: 'o2', label: 'Sem origem' },
            ],
            multiSelect: false,
            allowFreeText: false,
          },
        ],
        status: 'open',
        answers: null,
        createdAt: T0,
        answeredAt: null,
      },
    ],
    scrollback: { 'lead-t1': 'vings: plano já está feito\r\n' },
  }
}
