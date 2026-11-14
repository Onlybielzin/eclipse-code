/**
 * Store da tela. So le e pede operacoes ao main pelo contrato de src/shared/ipc.ts.
 *
 * Invariantes:
 *   S1. A tela nunca decide estado de dominio. Ela so substitui entidades inteiras
 *       que chegam do main (resposta de comando ou evento domain.event).
 *   S2. Evento com revision <= a ultima vista e descartado (chegou fora de ordem).
 *   S3. Atividade nao repete: a chave e sessionId + seq.
 *
 * Estado so da tela (derivado, nao duravel): projeto aberto, selecao, aba do meio,
 * tarefas expandidas.
 */
import type {
  ActivityEvent,
  DomainEvent,
  DomainEventEnvelope,
  Project,
  Role,
  Subtask,
  Task,
  TaskWorkflowStatus,
  UserQuestion,
} from '@shared/domain'
import type {
  EclipseApi,
  IpcCommandChannel,
  IpcCommandOutput,
  IpcCommandRequest,
  PickedFolder,
  ProjectsSummary,
  SubtaskDetail,
} from '@shared/ipc'
import { upsertById } from './format'

export type MidTab = 'leader' | 'delivery' | 'activity'

export interface AppState {
  status: 'loading' | 'ready'
  /** Ultimo erro de comando, para a faixa de aviso. */
  error: string | null
  projects: Project[]
  projectId: string | null
  roles: Record<string, Role>
  tasks: Task[]
  subtasks: Record<string, Subtask[]>
  questions: UserQuestion[]
  selectedTaskId: string | null
  selectedSubtaskId: string | null
  midTab: MidTab
  expanded: Record<string, boolean>
  details: Record<string, SubtaskDetail>
  activity: Record<string, ActivityEvent[]>
  lastRevision: number
}

export const initialState: AppState = {
  status: 'loading',
  error: null,
  projects: [],
  projectId: null,
  roles: {},
  tasks: [],
  subtasks: {},
  questions: [],
  selectedTaskId: null,
  selectedSubtaskId: null,
  midTab: 'leader',
  expanded: {},
  details: {},
  activity: {},
  lastRevision: 0,
}

const PROJECT_KEY = 'eclipse.projectId'
const ACTIVITY_PAGE = 500

function readSavedProject(): string | null {
  try {
    return globalThis.localStorage?.getItem(PROJECT_KEY) ?? null
  } catch {
    return null
  }
}

function saveProject(id: string | null): void {
  try {
    if (id === null) globalThis.localStorage?.removeItem(PROJECT_KEY)
    else globalThis.localStorage?.setItem(PROJECT_KEY, id)
  } catch {
    // armazenamento indisponivel: so perde a lembranca do projeto
  }
}

export class CommandError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'CommandError'
  }
}

export interface CreateTaskInput {
  title: string
  kind: 'team' | 'solo'
  soloProvider?: 'claude' | 'codex'
  useWorktree: boolean
}

export class AppStore {
  private state: AppState = initialState
  private readonly listeners = new Set<() => void>()
  private unsubscribe: (() => void) | null = null

  constructor(readonly api: EclipseApi) {}

  // -- assinatura (useSyncExternalStore) -------------------------------------

  getState = (): AppState => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private set(patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)): void {
    const delta = typeof patch === 'function' ? patch(this.state) : patch
    this.state = { ...this.state, ...delta }
    for (const l of this.listeners) l()
  }

  /** Chama o main e devolve o valor, ou lanca CommandError. Nunca engole erro. */
  async call<C extends IpcCommandChannel>(
    channel: C,
    input: IpcCommandRequest<C>,
  ): Promise<IpcCommandOutput<C>> {
    const result = await this.api.invoke(channel, input)
    if (!result.ok) throw new CommandError(result.error.code, result.error.message)
    return result.value
  }

  private async guard<T>(work: () => Promise<T>): Promise<T | undefined> {
    try {
      return await work()
    } catch (error) {
      this.set({ error: error instanceof Error ? error.message : String(error) })
      return undefined
    }
  }

  clearError(): void {
    this.set({ error: null })
  }

  // -- ciclo de vida ----------------------------------------------------------

  async start(): Promise<void> {
    if (this.unsubscribe === null) {
      this.unsubscribe = this.api.on('domain.event', (envelope) => this.applyEnvelope(envelope))
    }
    await this.guard(async () => {
      const projects = await this.call('projects.list', {})
      const saved = readSavedProject()
      const projectId = projects.find((p) => p.id === saved)?.id ?? projects[0]?.id ?? null
      this.set({ projects })
      await this.openProject(projectId)
    })
    this.set({ status: 'ready' })
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  async openProject(projectId: string | null): Promise<void> {
    saveProject(projectId)
    this.set({
      projectId,
      roles: {},
      tasks: [],
      subtasks: {},
      questions: [],
      selectedTaskId: null,
      selectedSubtaskId: null,
      midTab: 'leader',
      details: {},
      activity: {},
    })
    if (projectId === null) return
    await this.guard(async () => {
      const [roles, tasks, questions] = await Promise.all([
        this.call('roles.list', { projectId }),
        // Arquivadas entram para o grupo "Lançado" (recolhido por padrao na lista).
        this.call('tasks.list', { projectId, includeArchived: true }),
        this.call('questions.list', { projectId }),
      ])
      const subtaskLists = await Promise.all(
        tasks.map((t) => this.call('subtasks.list', { taskId: t.id })),
      )
      if (this.state.projectId !== projectId) return
      const subtasks: Record<string, Subtask[]> = {}
      tasks.forEach((t, i) => {
        subtasks[t.id] = subtaskLists[i] ?? []
      })
      const open = tasks.filter((t) => t.status === 'open')
      const first = open.find((t) => t.kind === 'team') ?? open[0] ?? null
      this.set((s) => ({
        roles: Object.fromEntries(roles.map((r) => [r.id, r])),
        tasks,
        subtasks,
        questions,
        selectedTaskId: s.selectedTaskId ?? first?.id ?? null,
        expanded: first ? { ...s.expanded, [first.id]: true } : s.expanded,
      }))
    })
  }

  /** Abre o explorador de pastas do sistema. Cancelar devolve null. */
  async pickProjectFolder(): Promise<PickedFolder | null> {
    return (await this.guard(() => this.call('projects.pickFolder', {}))) ?? null
  }

  /** Contadores de cada projeto para o seletor do topo. Erro vai para a faixa e devolve null. */
  async loadProjectsSummary(): Promise<ProjectsSummary | null> {
    return (await this.guard(() => this.call('projects.summary', {}))) ?? null
  }

  async addProject(rootPath: string, name?: string): Promise<void> {
    await this.guard(async () => {
      const project = await this.call(
        'projects.add',
        name && name.trim() ? { rootPath, name: name.trim() } : { rootPath },
      )
      this.set((s) => ({ projects: upsertById(s.projects, project) }))
      await this.openProject(project.id)
    })
  }

  // -- selecao ----------------------------------------------------------------

  /** Clicar na tarefa volta o meio para o terminal do Lider. */
  selectTask(taskId: string): void {
    this.set((s) => ({
      selectedTaskId: taskId,
      selectedSubtaskId: null,
      midTab: 'leader',
      expanded: { ...s.expanded, [taskId]: true },
    }))
  }

  toggleExpanded(taskId: string): void {
    this.set((s) => ({ expanded: { ...s.expanded, [taskId]: !s.expanded[taskId] } }))
  }

  /** Clicar na subtarefa abre a entrega. */
  async selectSubtask(subtaskId: string): Promise<void> {
    const subtask = this.findSubtask(subtaskId)
    this.set({
      selectedTaskId: subtask?.taskId ?? this.state.selectedTaskId,
      selectedSubtaskId: subtaskId,
      // Membro ainda trabalhando: abre no que ele esta fazendo. Terminou: abre na entrega.
      midTab: subtask && !isFinalOrWaiting(subtask.state) ? 'activity' : 'delivery',
    })
    await Promise.all([this.loadDetail(subtaskId), this.loadActivity(subtaskId)])
  }

  setMidTab(tab: MidTab): void {
    this.set({ midTab: tab })
  }

  findSubtask(subtaskId: string): Subtask | undefined {
    for (const list of Object.values(this.state.subtasks)) {
      const found = list.find((s) => s.id === subtaskId)
      if (found) return found
    }
    return undefined
  }

  async loadDetail(subtaskId: string): Promise<void> {
    await this.guard(async () => {
      const detail = await this.call('subtasks.detail', { subtaskId })
      this.set((s) => ({ details: { ...s.details, [subtaskId]: detail } }))
    })
  }

  /** Carrega a atividade inteira em paginas. Eventos ao vivo se juntam sem repetir (S3). */
  async loadActivity(subtaskId: string): Promise<void> {
    await this.guard(async () => {
      let afterSeq: number | undefined
      for (;;) {
        const page = await this.call('activity.list', {
          subtaskId,
          limit: ACTIVITY_PAGE,
          ...(afterSeq === undefined ? {} : { afterSeq }),
        })
        this.mergeActivity(page.events)
        if (!page.hasMore || page.lastSeq === null) break
        afterSeq = page.lastSeq
      }
    })
  }

  // -- comandos ---------------------------------------------------------------

  async createTask(input: CreateTaskInput): Promise<Task | undefined> {
    const projectId = this.state.projectId
    if (projectId === null) {
      this.set({ error: 'Abra um projeto antes de criar uma tarefa.' })
      return undefined
    }
    return this.guard(async () => {
      const task = await this.call('tasks.create', {
        projectId,
        title: input.title,
        kind: input.kind,
        useWorktree: input.kind === 'team' ? true : input.useWorktree,
        ...(input.kind === 'solo' && input.soloProvider
          ? { soloProvider: input.soloProvider }
          : {}),
      })
      this.set((s) => ({
        tasks: upsertById(s.tasks, task),
        subtasks: { [task.id]: s.subtasks[task.id] ?? [], ...s.subtasks },
      }))
      this.selectTask(task.id)
      return task
    })
  }

  /** Status escolhido no menu do icone. O main decide; a tela so troca pela resposta (S1). */
  async setTaskStatus(taskId: string, status: TaskWorkflowStatus): Promise<void> {
    await this.guard(async () => {
      const task = await this.call('tasks.setStatus', { taskId, status })
      this.applyTask(task)
    })
  }

  private applyTask(task: Task): void {
    this.set((s) => ({
      tasks: upsertById(s.tasks, task),
      subtasks: s.subtasks[task.id] ? s.subtasks : { ...s.subtasks, [task.id]: [] },
    }))
  }

  async answerQuestion(
    questionId: string,
    answers: { itemId: string; optionIds: string[]; text: string | null }[],
  ): Promise<void> {
    await this.guard(async () => {
      const q = await this.call('questions.answer', { questionId, answers })
      this.set((s) => ({ questions: upsertById(s.questions, q) }))
    })
  }

  async dismissQuestion(questionId: string): Promise<void> {
    await this.guard(async () => {
      const q = await this.call('questions.dismiss', { questionId })
      this.set((s) => ({ questions: upsertById(s.questions, q) }))
    })
  }

  // -- eventos do main --------------------------------------------------------

  applyEnvelope(envelope: DomainEventEnvelope): void {
    if (envelope.revision <= this.state.lastRevision) return // S2
    this.set({ lastRevision: envelope.revision })
    this.applyEvent(envelope.event)
  }

  private mergeActivity(events: readonly ActivityEvent[]): void {
    if (events.length === 0) return
    this.set((s) => {
      const next = { ...s.activity }
      for (const ev of events) {
        const list = next[ev.subtaskId] ?? []
        if (list.some((x) => x.sessionId === ev.sessionId && x.seq === ev.seq)) continue
        const merged = [...list, ev]
        merged.sort((a, b) => a.at - b.at || a.seq - b.seq)
        next[ev.subtaskId] = merged
      }
      return { activity: next }
    })
  }

  private patchDetail(subtaskId: string, fn: (d: SubtaskDetail) => SubtaskDetail): void {
    const current = this.state.details[subtaskId]
    if (!current) return
    this.set((s) => ({ details: { ...s.details, [subtaskId]: fn(current) } }))
  }

  private applyEvent(event: DomainEvent): void {
    const s = this.state
    switch (event.type) {
      case 'project.upserted':
        this.set({ projects: upsertById(s.projects, event.project) })
        return
      case 'project.removed':
        this.set({ projects: s.projects.filter((p) => p.id !== event.projectId) })
        if (s.projectId === event.projectId) {
          void this.openProject(this.state.projects[0]?.id ?? null)
        }
        return
      case 'role.upserted':
        if (event.role.projectId !== s.projectId) return
        this.set({ roles: { ...s.roles, [event.role.id]: event.role } })
        return
      case 'role.deleted': {
        const roles = { ...s.roles }
        delete roles[event.roleId]
        this.set({ roles })
        return
      }
      case 'task.upserted': {
        const task = event.task
        if (task.projectId !== s.projectId) return
        // Arquivada continua na lista, no grupo "Lançado".
        this.applyTask(task)
        return
      }
      case 'subtask.upserted': {
        const sub = event.subtask
        if (!s.tasks.some((t) => t.id === sub.taskId)) return
        this.set({
          subtasks: { ...s.subtasks, [sub.taskId]: upsertById(s.subtasks[sub.taskId] ?? [], sub) },
        })
        this.patchDetail(sub.id, (d) => ({ ...d, subtask: sub }))
        return
      }
      case 'message.added':
        this.patchDetail(event.message.subtaskId, (d) => ({
          ...d,
          messages: upsertById(d.messages, event.message),
        }))
        return
      case 'artifact.added':
        this.patchDetail(event.artifact.subtaskId, (d) => ({
          ...d,
          artifacts: upsertById(d.artifacts, event.artifact),
        }))
        return
      case 'turn.upserted':
        this.patchDetail(event.turn.subtaskId, (d) => ({
          ...d,
          turns: upsertById(d.turns, event.turn),
        }))
        return
      case 'session.upserted': {
        const session = event.session
        if (session.subtaskId === null) return
        this.patchDetail(session.subtaskId, (d) => ({ ...d, session }))
        return
      }
      case 'activity.appended':
        this.mergeActivity(event.events)
        return
      case 'question.upserted':
        if (!s.tasks.some((t) => t.id === event.question.taskId)) return
        this.set({ questions: upsertById(s.questions, event.question) })
        return
    }
  }
}

/** Subtarefa que ja tem algo para ler na entrega (pronta, bloqueada, cancelada ou em duvida). */
function isFinalOrWaiting(state: Subtask['state']): boolean {
  return state !== 'submitted' && state !== 'working'
}
