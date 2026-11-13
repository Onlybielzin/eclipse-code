/**
 * TeamCoordinator: liga TaskService, PtyHost + Lider, MemberRuntime (ACP), worktrees e a
 * ponte MCP. Implementa as ferramentas MCP com efeito fora do banco (McpTeamActions) e os
 * comandos da tela que abrem ou fecham agentes. Nao grava nada direto: tudo passa pelo
 * TaskService, que grava no SQLite antes de avisar a tela.
 *
 * Fluxo de uma subtarefa (subtarefa_criar do Lider):
 *   TaskService.createSubtask (na fila) -> openSession + MemberRuntime.startSession
 *   -> transition working -> startTurn -> MemberRuntime.prompt -> finishTurn
 *   -> (TeamTurnRelay avisa o Lider) -> estado final: fecha a sessao ACP.
 *
 * Invariantes:
 *   C1. Um Lider vivo por tarefa: ensureLeader roda em fila por tarefa.
 *   C2. Membro em estado final nunca fica com processo aberto (closeMember depois do finishTurn).
 *   C3. No desligamento nenhum turno e fechado a forca: a recuperacao na proxima partida decide
 *       (entrega gravada vale; sem entrega vira "bloqueado: sessão perdida").
 *   C4. Processo de Lider aberto para uma sessao ja encerrada (arquivada/fechada durante o
 *       launch) e morto na hora: nenhum Lider vive sem sessao aberta no banco.
 *   C5. Aviso ao Lider nunca e descartado: vai para a fila duravel (leaderNotices) e so sai
 *       dela com entrega confirmada.
 *   C6. Um providerSessionId que falhou no --resume nao e tentado de novo: a sessao fica com
 *       providerSessionId null e o Lider abre sessao nova.
 */
import { join } from 'node:path'
import {
  DomainError,
  isFinalSubtaskState,
  type Provider,
  type QuestionAnswer,
  type QuestionId,
  type Role,
  type RoleId,
  type Session,
  type SessionId,
  type Subtask,
  type SubtaskId,
  type Task,
  type TaskId,
  type TaskKind,
  type TurnResult,
  type UserQuestion,
} from '@shared/domain'
import type { TerminalAttachResult } from '@shared/ipc'
import type { McpCaller, McpToolName, McpToolResult } from '@shared/mcp'
import type {
  AgentLimits,
  McpBridgeServer,
  MemberRuntime,
  PtyHost,
  TeamCoordinator,
  Unsubscribe,
  WorktreeService,
} from '@shared/ports'
import { claudeSessionIdFor, type LeaderModule } from '../leader'
import { createMcpToolHandler, type DisposableMcpToolHandler, type McpTeamActions } from '../mcp'
import {
  DEFAULT_AGENT_LIMITS,
  assertAgentCapacity,
  type RecoveryReport,
  type SqliteTaskService,
} from '../tasks'
import {
  composeLeaderPrompt,
  composeMemberAnswerPrompt,
  composeMemberFirstPrompt,
  composeMemberSystemPrompt,
  composeQuestionNotice,
  composeMemberStoppedNotice,
  composeSessionLostNotice,
  composeSpawnFailureNotice,
} from './prompts'

export interface AppLogger {
  info(message: string, meta?: Record<string, unknown>): void
  warn(message: string, meta?: Record<string, unknown>): void
  error(message: string, meta?: Record<string, unknown>): void
}

export const silentLogger: AppLogger = { info: () => {}, warn: () => {}, error: () => {} }

export interface TeamCoordinatorDeps {
  tasks: SqliteTaskService
  ptyHost: PtyHost
  leader: LeaderModule
  members: MemberRuntime
  worktrees: WorktreeService
  bridge: McpBridgeServer
  /** AppPaths.worktrees: as worktrees de cada projeto ficam em <raiz>/<projectId>. */
  worktreesRoot: string
  limits?: AgentLimits
  /** Tamanho inicial do terminal do Lider (a tela ajusta com terminal.resize). */
  terminalSize?: { cols: number; rows: number }
  /** Variaveis extras para o Lider e para os membros. */
  leaderEnv?: Record<string, string>
  memberEnv?: Record<string, string>
  /**
   * Fila duravel de avisos ao Lider (TeamTurnRelay.notify). Resposta do usuario, membro que
   * nao abriu ou que parou: tudo entra aqui e sai so com entrega confirmada.
   */
  leaderNotices: { notify(taskId: TaskId, text: string): void }
  /**
   * Saida com erro de um Lider aberto com --resume dentro deste prazo, antes de qualquer
   * sinal de turno, conta como retomada que falhou (padrao 60 s).
   */
  resumeFailureWindowMs?: number
  now?: () => number
  log?: AppLogger
}

const DEFAULT_RESUME_FAILURE_WINDOW_MS = 60_000

export interface CreateTaskInput {
  projectId: string
  title: string
  kind: TaskKind
  leadRoleId?: RoleId | undefined
  soloProvider?: Provider | undefined
  baseBranch?: string | undefined
  useWorktree: boolean
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class AppTeamCoordinator implements TeamCoordinator, McpTeamActions {
  private readonly tasks: SqliteTaskService
  private readonly ptyHost: PtyHost
  private readonly leader: LeaderModule
  private readonly members: MemberRuntime
  private readonly worktrees: WorktreeService
  private readonly bridge: McpBridgeServer
  private readonly limits: AgentLimits
  private readonly log: AppLogger
  private readonly toolHandler: DisposableMcpToolHandler
  private readonly unsubscribers: Unsubscribe[] = []

  /** Lider: sessionId <-> ptyId. Mantido depois da saida para repintar o scrollback. */
  private readonly leaderPtys = new Map<SessionId, string>()
  private readonly ptyLeaders = new Map<string, SessionId>()
  private readonly leaderLocks = new Map<TaskId, Promise<Session>>()
  private readonly closingLeaders = new Set<SessionId>()
  /** Lideres abertos com --resume e quando abriram (para detectar retomada que falhou). */
  private readonly resumedLeaders = new Map<SessionId, { taskId: TaskId; startedAt: number }>()
  private readonly now: () => number
  private readonly resumeFailureWindowMs: number
  /** Membros entre openSession e o fim do startSession (contam no limite). */
  private readonly startingMembers = new Set<SessionId>()
  private readonly closingMembers = new Set<SessionId>()
  private readonly inflight = new Set<Promise<unknown>>()
  private readonly exitListeners = new Set<
    (event: { sessionId: SessionId; exitCode: number | null; signal: string | null }) => void
  >()
  private shuttingDown = false

  constructor(private readonly deps: TeamCoordinatorDeps) {
    this.tasks = deps.tasks
    this.ptyHost = deps.ptyHost
    this.leader = deps.leader
    this.members = deps.members
    this.worktrees = deps.worktrees
    this.bridge = deps.bridge
    this.limits = deps.limits ?? DEFAULT_AGENT_LIMITS
    this.log = deps.log ?? silentLogger
    this.now = deps.now ?? Date.now
    this.resumeFailureWindowMs = deps.resumeFailureWindowMs ?? DEFAULT_RESUME_FAILURE_WINDOW_MS
    this.toolHandler = createMcpToolHandler({ tasks: this.tasks, actions: this })

    this.unsubscribers.push(
      this.leader.sessions.onEvent((event) => {
        if (event.type === 'provider-session-id') {
          this.safely('gravar id de sessão do Líder', () =>
            this.tasks.updateSession(event.sessionId, {
              providerSessionId: event.providerSessionId,
            }),
          )
        } else if (event.type === 'exit') {
          this.onLeaderExit(event.sessionId, event.exit.exitCode, event.exit.signal)
        }
      }),
      this.members.onActivity((draft) => {
        if (this.shuttingDown) return
        // O TaskService ja grava o 'prompt' no startTurn, na mesma transacao do turno.
        if (draft.payload.kind === 'prompt') return
        this.safely('gravar atividade do membro', () => this.tasks.appendActivity([draft]))
      }),
      this.members.onSessionExit((sessionId, exit) => this.onMemberExit(sessionId, exit.exitCode)),
    )
  }

  // -------------------------------------------------------------------------
  // McpToolHandler
  // -------------------------------------------------------------------------

  callTool(caller: McpCaller, name: McpToolName, args: unknown): Promise<McpToolResult> {
    return this.toolHandler.callTool(caller, name, args)
  }

  // -------------------------------------------------------------------------
  // Tarefas
  // -------------------------------------------------------------------------

  async createTask(input: CreateTaskInput): Promise<Task> {
    this.assertRunning()
    const project = this.tasks.getProject(input.projectId)
    if (input.kind === 'team' && !input.useWorktree) {
      throw new DomainError('invalid_input', 'tarefa de time precisa de worktree')
    }
    if (input.kind === 'team' && !input.leadRoleId && !this.tasks.getLeadRole(project.id)) {
      throw new DomainError('invalid_input', 'o projeto não tem papel de Líder')
    }
    const worktree = input.useWorktree
      ? await this.worktrees.create({
          projectRoot: project.rootPath,
          worktreesRoot: join(this.deps.worktreesRoot, project.id),
          name: input.title,
          baseBranch: input.baseBranch,
        })
      : null
    let task: Task
    try {
      task = this.tasks.createTask({
        projectId: project.id,
        title: input.title,
        kind: input.kind,
        worktreePath: worktree?.path ?? null,
        branch: worktree?.branch ?? null,
        baseBranch: worktree?.baseBranch ?? null,
        leadRoleId: input.leadRoleId ?? null,
        soloProvider: input.soloProvider ?? null,
      })
    } catch (error) {
      if (worktree) {
        await this.worktrees
          .remove({
            projectRoot: project.rootPath,
            worktreePath: worktree.path,
            branch: worktree.branch,
            deleteBranch: true,
            force: true,
          })
          .catch((cleanup: unknown) =>
            this.log.warn('worktree órfã não foi removida', { error: errorMessage(cleanup) }),
          )
      }
      throw error
    }
    // Abre o Lider em seguida. Erro aqui nao desfaz a tarefa: a tela chama leader.ensure
    // (que entra na mesma fila) e mostra o erro.
    this.track(
      this.ensureLeader(task.id).catch((error: unknown) =>
        this.log.warn('Líder não abriu ao criar a tarefa', {
          taskId: task.id,
          error: errorMessage(error),
        }),
      ),
    )
    return task
  }

  async archiveTask(taskId: TaskId, options: { removeWorktree: boolean }): Promise<Task> {
    const task = this.tasks.getTask(taskId)
    for (const session of this.tasks.listSessions(taskId)) {
      if (session.status === 'exited') continue
      if (session.kind === 'member-acp') await this.closeMember(session.id)
      else this.stopLeader(session.id)
    }
    const archived = this.tasks.markTaskArchived(taskId)
    if (options.removeWorktree && task.worktreePath) {
      const project = this.tasks.getProject(task.projectId)
      await this.worktrees.remove({
        projectRoot: project.rootPath,
        worktreePath: task.worktreePath,
        branch: task.branch,
        deleteBranch: true,
        force: false,
      })
    }
    return archived
  }

  // -------------------------------------------------------------------------
  // Lider
  // -------------------------------------------------------------------------

  ensureLeader(taskId: TaskId): Promise<Session> {
    const running = this.leaderLocks.get(taskId)
    if (running) return running
    const job = this.openLeader(taskId).finally(() => this.leaderLocks.delete(taskId))
    this.leaderLocks.set(taskId, job)
    return job
  }

  private async openLeader(taskId: TaskId): Promise<Session> {
    this.assertRunning()
    const task = this.tasks.getTask(taskId)
    if (task.status !== 'open') throw new DomainError('invalid_input', 'tarefa arquivada')

    const live = this.tasks.getLiveLeaderSession(taskId)
    if (live) {
      const ptyId = this.leaderPtys.get(live.id)
      if (ptyId && this.ptyHost.isAlive(ptyId)) return live
      // Aberta no banco mas sem processo: nao ocupa vaga nem trava a tarefa.
      this.bridge.revokeSession(live.id)
      this.tasks.endSession(live.id, { reason: 'process_died', exitCode: null })
    }

    assertAgentCapacity({
      limits: this.limits,
      kind: 'leader',
      taskId,
      openSessions: this.tasks.listOpenSessions(),
      liveness: { isAlive: (s) => this.isSessionAlive(s) },
    })

    const project = this.tasks.getProject(task.projectId)
    const cwd = task.worktreePath ?? project.rootPath
    const role = this.findRole(task.leadRoleId)
    const provider: Provider = role?.provider ?? task.soloProvider ?? 'claude'
    const latest = this.tasks.getLatestLeaderSession(taskId)
    let resumeId = latest?.provider === provider ? latest.providerSessionId : null
    if (
      resumeId &&
      !(await this.leader.canResume({ provider, providerSessionId: resumeId, cwd }))
    ) {
      // Conversa sumiu (nunca gravada ou limpa pelo provedor): --resume so falharia.
      this.log.warn('Líder sem conversa para retomar; abrindo sessão nova', {
        taskId,
        providerSessionId: resumeId,
      })
      resumeId = null
    }
    this.assertRunning()

    const session = this.tasks.openSession({
      taskId,
      subtaskId: null,
      roleId: role?.id ?? null,
      kind: 'leader-pty',
      provider,
      model: role?.model ?? null,
      cwd,
      providerSessionId: resumeId,
    })
    const token = this.bridge.issueToken({
      role: 'leader',
      sessionId: session.id,
      taskId,
      subtaskId: null,
    })
    const size = this.deps.terminalSize ?? { cols: 120, rows: 32 }
    let launched
    try {
      launched = await this.leader.launcher.launch({
        sessionId: session.id,
        taskId,
        provider,
        model: role?.model ?? null,
        cwd,
        initialPrompt:
          resumeId || (task.kind === 'solo' && !role)
            ? null
            : composeLeaderPrompt({ task, cwd, template: role?.promptTemplate ?? null }),
        resumeProviderSessionId: resumeId,
        mcpServer: this.bridge.launchSpec(token),
        env: { ...this.deps.leaderEnv },
        cols: size.cols,
        rows: size.rows,
      })
    } catch (error) {
      this.bridge.revokeSession(session.id)
      this.tasks.endSession(session.id, { reason: 'spawn_failed', exitCode: null })
      throw error
    }
    this.leaderPtys.set(session.id, launched.ptyId)
    this.ptyLeaders.set(launched.ptyId, session.id)

    const providerSessionId = launched.resumed
      ? resumeId
      : provider === 'claude'
        ? claudeSessionIdFor(session.id)
        : null
    const current = this.tasks.getSession(session.id)
    if (current.status === 'exited' || this.shuttingDown) {
      // Encerrada durante o launch (arquivar, fechar o app, stopLeader): o processo que
      // acabou de abrir nao tem dono e morre aqui (C4).
      this.closingLeaders.add(session.id)
      this.bridge.revokeSession(session.id)
      if (this.ptyHost.isAlive(launched.ptyId)) this.ptyHost.kill(launched.ptyId, 'SIGTERM')
      if (this.shuttingDown) return current
      return this.tasks.getSession(session.id)
    }
    if (launched.resumed) {
      this.resumedLeaders.set(session.id, { taskId, startedAt: this.now() })
    }
    this.log.info('Líder aberto', { taskId, sessionId: session.id, resumed: launched.resumed })
    return this.tasks.updateSession(session.id, {
      pid: launched.pid,
      status: 'running',
      ...(providerSessionId ? { providerSessionId } : {}),
    })
  }

  private stopLeader(sessionId: SessionId): void {
    this.closingLeaders.add(sessionId)
    this.bridge.revokeSession(sessionId)
    const ptyId = this.leaderPtys.get(sessionId)
    if (ptyId && this.ptyHost.isAlive(ptyId)) this.ptyHost.kill(ptyId, 'SIGTERM')
    this.tasks.endSession(sessionId, { reason: 'closed', exitCode: null })
  }

  private onLeaderExit(sessionId: SessionId, exitCode: number | null, signal: string | null) {
    for (const listener of this.exitListeners) listener({ sessionId, exitCode, signal })
    const resumed = this.resumedLeaders.get(sessionId)
    this.resumedLeaders.delete(sessionId)
    if (this.shuttingDown) return
    this.bridge.revokeSession(sessionId)
    const closing = this.closingLeaders.has(sessionId)
    const reason = closing ? 'closed' : exitCode === 0 ? 'exited' : 'process_died'
    this.closingLeaders.delete(sessionId)
    const resumeFailed =
      !!resumed &&
      !closing &&
      exitCode !== 0 &&
      this.now() - resumed.startedAt <= this.resumeFailureWindowMs &&
      !this.leader.sessions.get(sessionId)?.hasTurnSignal
    this.safely('encerrar sessão do Líder', () => {
      // Retomada que falhou: esquece o id, senao todo ensure tentaria o mesmo --resume (C6).
      if (resumeFailed) this.tasks.updateSession(sessionId, { providerSessionId: null })
      this.tasks.endSession(sessionId, { reason, exitCode })
    })
    if (resumeFailed && resumed) {
      this.log.warn('--resume do Líder falhou; abrindo sessão nova', {
        taskId: resumed.taskId,
        sessionId,
        exitCode,
      })
      this.reopenLeaderFresh(resumed.taskId)
    }
  }

  /** Depois de uma retomada que falhou: uma tentativa de Lider novo (nunca em laco). */
  private reopenLeaderFresh(taskId: TaskId): void {
    const opening = this.leaderLocks.get(taskId) ?? Promise.resolve(null)
    this.track(
      opening
        .catch(() => null)
        .then(() => {
          if (this.shuttingDown) return null
          const task = this.tasks.getTask(taskId)
          if (task.status !== 'open') return null
          return this.ensureLeader(taskId)
        })
        .catch((error: unknown) =>
          this.log.warn('Líder novo não abriu depois do --resume', {
            taskId,
            error: errorMessage(error),
          }),
        ),
    )
  }

  /**
   * Aviso fora de turno ao Lider (membro nao abriu ou parou, resposta do usuario). Entra na
   * fila duravel e sai quando o Lider estiver vivo e ocioso; nunca e descartado (C5).
   */
  private notifyLeader(taskId: TaskId, text: string): void {
    this.deps.leaderNotices.notify(taskId, text)
  }

  // -------------------------------------------------------------------------
  // Terminal do Lider (tela)
  // -------------------------------------------------------------------------

  sessionForPty(ptyId: string): SessionId | null {
    return this.ptyLeaders.get(ptyId) ?? null
  }

  onLeaderTerminalExit(
    listener: (event: {
      sessionId: SessionId
      exitCode: number | null
      signal: string | null
    }) => void,
  ): Unsubscribe {
    this.exitListeners.add(listener)
    return () => this.exitListeners.delete(listener)
  }

  attachTerminal(sessionId: SessionId): TerminalAttachResult {
    const session = this.tasks.getSession(sessionId)
    if (session.kind !== 'leader-pty') {
      throw new DomainError('invalid_input', 'só o Líder tem terminal')
    }
    const ptyId = this.leaderPtys.get(sessionId)
    const size = (ptyId ? this.ptyHost.size(ptyId) : null) ??
      this.deps.terminalSize ?? { cols: 120, rows: 32 }
    return {
      sessionId,
      alive: ptyId ? this.ptyHost.isAlive(ptyId) : false,
      cols: size.cols,
      rows: size.rows,
      scrollback: ptyId ? this.ptyHost.scrollback(ptyId) : '',
    }
  }

  writeTerminal(sessionId: SessionId, data: string): void {
    const ptyId = this.livePty(sessionId)
    this.ptyHost.write(ptyId, data)
  }

  resizeTerminal(sessionId: SessionId, cols: number, rows: number): void {
    const ptyId = this.leaderPtys.get(sessionId)
    if (ptyId && this.ptyHost.isAlive(ptyId)) this.ptyHost.resize(ptyId, cols, rows)
  }

  private livePty(sessionId: SessionId): string {
    const ptyId = this.leaderPtys.get(sessionId)
    if (!ptyId || !this.ptyHost.isAlive(ptyId)) {
      throw new DomainError('unavailable', 'o terminal desta sessão já terminou')
    }
    return ptyId
  }

  // -------------------------------------------------------------------------
  // Membros (McpTeamActions)
  // -------------------------------------------------------------------------

  async createSubtask(
    caller: McpCaller,
    input: { roleId: string; title: string; instructions: string; referenceTaskIds: SubtaskId[] },
  ): Promise<Subtask> {
    this.assertRunning()
    if (caller.role !== 'leader') throw new DomainError('forbidden', 'só o Líder cria subtarefas')
    assertAgentCapacity({
      limits: this.limits,
      kind: 'member',
      taskId: caller.taskId,
      openSessions: this.tasks.listOpenSessions(),
      liveness: { isAlive: (s) => this.isSessionAlive(s) },
    })
    const subtask = this.tasks.createSubtask({
      taskId: caller.taskId,
      roleId: input.roleId,
      title: input.title,
      instructions: input.instructions,
      referenceTaskIds: input.referenceTaskIds,
    })
    this.track(this.startMember(subtask))
    return subtask
  }

  async answerSubtask(caller: McpCaller, subtaskId: SubtaskId, text: string): Promise<Subtask> {
    if (caller.role !== 'leader') throw new DomainError('forbidden', 'só o Líder responde')
    return this.answerMember(subtaskId, text, 'leader')
  }

  async cancelSubtask(
    caller: McpCaller,
    subtaskId: SubtaskId,
    reason: string | null,
  ): Promise<Subtask> {
    if (caller.role !== 'leader') throw new DomainError('forbidden', 'só o Líder cancela')
    const next = this.tasks.transitionSubtask(subtaskId, 'canceled', {
      statusMessage: reason ? `cancelada: ${reason}` : 'cancelada pelo Líder',
    })
    if (next.sessionId) this.track(this.closeMember(next.sessionId))
    return next
  }

  private async answerMember(
    subtaskId: SubtaskId,
    text: string,
    author: 'leader' | 'user',
  ): Promise<Subtask> {
    this.assertRunning()
    const subtask = this.tasks.getSubtask(subtaskId)
    if (subtask.state !== 'input_required') {
      throw new DomainError('invalid_transition', 'só se responde uma subtarefa em dúvida')
    }
    const sessionId = subtask.sessionId
    if (!sessionId || !this.members.isAlive(sessionId)) {
      throw new DomainError(
        'unavailable',
        'o membro desta subtarefa não está mais aberto; crie uma subtarefa nova com origem nela',
      )
    }
    const next = this.tasks.transitionSubtask(subtaskId, 'working')
    this.track(this.runTurn(sessionId, subtaskId, author, composeMemberAnswerPrompt(text)))
    return next
  }

  private async startMember(subtask: Subtask): Promise<void> {
    let session: Session | null = null
    let role: Role | null = null
    try {
      role = this.tasks.getRole(subtask.roleId)
      const task = this.tasks.getTask(subtask.taskId)
      const project = this.tasks.getProject(task.projectId)
      const cwd = task.worktreePath ?? project.rootPath
      session = this.tasks.openSession({
        taskId: task.id,
        subtaskId: subtask.id,
        roleId: role.id,
        kind: 'member-acp',
        provider: role.provider,
        model: role.model,
        cwd,
        providerSessionId: null,
      })
      this.startingMembers.add(session.id)
      this.tasks.attachSubtaskSession(subtask.id, session.id)
      const token = this.bridge.issueToken({
        role: 'member',
        sessionId: session.id,
        taskId: task.id,
        subtaskId: subtask.id,
      })
      const handle = await this.members.startSession({
        sessionId: session.id,
        taskId: task.id,
        subtaskId: subtask.id,
        provider: role.provider,
        model: role.model,
        cwd,
        systemPrompt: composeMemberSystemPrompt({
          task,
          subtask,
          cwd,
          template: role.promptTemplate,
        }),
        mcpServer: this.bridge.launchSpec(token),
        env: { ...this.deps.memberEnv },
        resumeProviderSessionId: null,
      })
      this.startingMembers.delete(session.id)
      if (this.shuttingDown) return
      if (isFinalSubtaskState(this.tasks.getSubtask(subtask.id).state)) {
        // Cancelada enquanto abria.
        await this.closeMember(session.id)
        return
      }
      this.tasks.updateSession(session.id, {
        providerSessionId: handle.providerSessionId,
        pid: handle.pid,
        status: 'running',
      })
      this.tasks.transitionSubtask(subtask.id, 'working')
    } catch (error) {
      if (session) {
        this.startingMembers.delete(session.id)
        this.bridge.revokeSession(session.id)
      }
      if (this.shuttingDown) return
      const message = errorMessage(error)
      this.log.warn('membro não abriu', { subtaskId: subtask.id, error: message })
      this.safely('marcar membro que não abriu', () => {
        if (session) this.tasks.endSession(session.id, { reason: 'spawn_failed', exitCode: null })
        const current = this.tasks.getSubtask(subtask.id)
        if (isFinalSubtaskState(current.state)) return
        this.tasks.transitionSubtask(subtask.id, 'failed', {
          failureCode: 'spawn_failed',
          statusMessage: `bloqueado: membro não abriu (${message.slice(0, 300)})`,
        })
        this.notifyLeader(
          subtask.taskId,
          composeSpawnFailureNotice(subtask, role?.name ?? subtask.roleId, message),
        )
      })
      return
    }
    const references = subtask.referenceTaskIds.map((id) => this.tasks.getSubtask(id))
    await this.runTurn(
      session.id,
      subtask.id,
      'leader',
      composeMemberFirstPrompt(subtask, references),
    )
  }

  /** Um turno do membro: startTurn -> prompt -> finishTurn -> fecha se final. */
  private async runTurn(
    sessionId: SessionId,
    subtaskId: SubtaskId,
    author: 'leader' | 'user',
    text: string,
  ): Promise<void> {
    let turnId: string
    try {
      turnId = this.tasks.startTurn({
        sessionId,
        subtaskId,
        author,
        parts: [{ kind: 'text', text }],
      }).id
    } catch (error) {
      this.log.error('turno não começou', { subtaskId, error: errorMessage(error) })
      return
    }
    const startedAt = Date.now()
    let result: TurnResult
    try {
      result = await this.members.prompt(sessionId, { turnId, text })
    } catch (error) {
      result = {
        turnId,
        sessionId,
        outcome: {
          kind: 'error',
          error: { code: 'session_closed', message: errorMessage(error) },
        },
        finalText: '',
        deliveries: [],
        startedAt,
        endedAt: Date.now(),
      }
    }
    // Desligando: o turno fica aberto no banco e a recuperacao decide na proxima partida.
    if (this.shuttingDown) return
    const outcome = this.safely('fechar turno', () => this.tasks.finishTurn(result))
    if (!outcome) return
    if (isFinalSubtaskState(outcome.subtask.state)) await this.closeMember(sessionId)
  }

  private async closeMember(sessionId: SessionId): Promise<void> {
    this.closingMembers.add(sessionId)
    try {
      await this.members.close(sessionId)
    } finally {
      this.bridge.revokeSession(sessionId)
      if (!this.shuttingDown) {
        this.safely('encerrar sessão do membro', () =>
          this.tasks.endSession(sessionId, { reason: 'closed', exitCode: null }),
        )
      }
    }
  }

  private onMemberExit(sessionId: SessionId, exitCode: number | null): void {
    if (this.shuttingDown) return
    this.bridge.revokeSession(sessionId)
    const closing = this.closingMembers.delete(sessionId)
    this.safely('encerrar membro que saiu', () => {
      const session = this.tasks.getSession(sessionId)
      this.tasks.endSession(sessionId, {
        reason: closing ? 'closed' : exitCode === 0 ? 'exited' : 'process_died',
        exitCode,
      })
      // Com turno aberto quem fecha e o runTurn (o prompt resolve com process_exited).
      if (closing || session.activeTurnId !== null || !session.subtaskId) return
      const subtask = this.tasks.getSubtask(session.subtaskId)
      if (isFinalSubtaskState(subtask.state) || subtask.state === 'submitted') return
      this.tasks.transitionSubtask(subtask.id, 'failed', { failureCode: 'process_exited' })
      this.notifyLeader(
        subtask.taskId,
        composeMemberStoppedNotice(subtask, this.findRole(subtask.roleId)?.name ?? subtask.roleId),
      )
    })
  }

  // -------------------------------------------------------------------------
  // Perguntas ao usuario
  // -------------------------------------------------------------------------

  async answerUserQuestion(
    questionId: QuestionId,
    answers: QuestionAnswer[],
  ): Promise<UserQuestion> {
    const question = this.tasks.answerQuestion(questionId, answers)
    this.notifyLeader(question.taskId, composeQuestionNotice(question))
    return question
  }

  async dismissUserQuestion(questionId: QuestionId): Promise<UserQuestion> {
    const question = this.tasks.dismissQuestion(questionId)
    this.notifyLeader(question.taskId, composeQuestionNotice(question))
    return question
  }

  // -------------------------------------------------------------------------
  // Partida e desligamento
  // -------------------------------------------------------------------------

  /**
   * Fecha o que nao voltou (membros viram "bloqueado: sessão perdida") e reabre cada
   * Lider que estava aberto com --resume / resume, em segundo plano.
   */
  async recoverOnStartup(): Promise<void> {
    await this.recover()
  }

  /** recoverOnStartup com o relatorio (o composition root registra os numeros). */
  async recover(): Promise<RecoveryReport> {
    const report = this.tasks.recoverAfterRestart({
      survivingSessionIds: new Set(),
      // Subtarefa perdida sem turno aberto nao gera fim de turno: o aviso vai para a fila.
      composeLostNotice: (subtask) =>
        composeSessionLostNotice(subtask, this.findRole(subtask.roleId)?.name ?? subtask.roleId),
    })
    for (const leader of report.leadersToResume) {
      this.track(
        this.ensureLeader(leader.taskId).catch((error: unknown) =>
          this.log.warn('Líder não voltou com --resume', {
            taskId: leader.taskId,
            error: errorMessage(error),
          }),
        ),
      )
    }
    return report
  }

  /**
   * Mata membros e Lideres sem gravar fim de sessao nem fechar turno: a proxima partida
   * recupera (C3) e reabre os Lideres com --resume.
   */
  async shutdown(): Promise<void> {
    if (this.shuttingDown) return
    this.shuttingDown = true
    this.toolHandler.dispose()
    for (const ptyId of this.leaderPtys.values()) {
      if (this.ptyHost.isAlive(ptyId)) this.ptyHost.kill(ptyId, 'SIGTERM')
    }
    await this.members.dispose()
    await this.idle()
    for (const off of this.unsubscribers.splice(0)) off()
  }

  /** Espera o trabalho em segundo plano (abrir membro, turnos, avisos). Para testes e desligar. */
  async idle(): Promise<void> {
    while (this.inflight.size > 0) {
      await Promise.allSettled([...this.inflight])
    }
  }

  // -------------------------------------------------------------------------
  // Utilidades
  // -------------------------------------------------------------------------

  private isSessionAlive(session: Session): boolean {
    if (session.kind === 'leader-pty') {
      const ptyId = this.leaderPtys.get(session.id)
      return !!ptyId && this.ptyHost.isAlive(ptyId)
    }
    return this.startingMembers.has(session.id) || this.members.isAlive(session.id)
  }

  private findRole(roleId: RoleId | null): Role | null {
    if (!roleId) return null
    try {
      return this.tasks.getRole(roleId)
    } catch {
      return null
    }
  }

  private assertRunning(): void {
    if (this.shuttingDown) throw new DomainError('unavailable', 'o app está fechando')
  }

  private track(promise: Promise<unknown>): void {
    const tracked = promise.catch((error: unknown) =>
      this.log.error('tarefa em segundo plano falhou', { error: errorMessage(error) }),
    )
    this.inflight.add(tracked)
    void tracked.finally(() => this.inflight.delete(tracked))
  }

  private safely<T>(what: string, fn: () => T): T | null {
    try {
      return fn()
    } catch (error) {
      this.log.error(`falha ao ${what}`, { error: errorMessage(error) })
      return null
    }
  }
}
