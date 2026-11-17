/**
 * TaskService: unico escritor do estado duravel (ver ports.ts).
 *
 * Como cada metodo funciona:
 *   1. Abre uma transacao no TaskStore (aninhada reaproveita a de fora).
 *   2. Valida as invariantes e grava.
 *   3. Para cada mudanca chama store.appendEvent dentro da mesma transacao.
 *   4. So depois do commit entrega os envelopes aos assinantes (I3).
 *      Se a transacao falhar, nenhum evento sai.
 *
 * Invariantes:
 *   I1. Subtarefa final (completed | failed | canceled) nao muda: 'final_state'.
 *   I2. No maximo um leader-pty nao encerrado por tarefa: 'conflict'.
 *   I3. Evento so depois do commit, com revisao global crescente.
 *   I4. Tarefa arquivada nao aceita subtarefa nova, sessao nova nem pergunta nova.
 *   I5. Uma subtarefa tem no maximo uma sessao de membro (seq de atividade e por sessao).
 *   I6. Status de trabalho da tarefa (W1-W3 em domain.ts): so muda aqui, na mesma transacao
 *       do fato que o causou (subtarefa em working, pergunta aberta/fechada, tarefa_concluir,
 *       pedido do usuario). Agente nunca escreve pronto_lancar/lancado/cancelado; lancado ou cancelado <=> arquivada.
 */
import { DEFAULT_ROLES } from './defaultRoles'
import { basename, isAbsolute, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  DomainError,
  MAX_ACTIVITY_TEXT_CHARS,
  canTransitionSubtask,
  isArchivedWorkflowStatus,
  isFinalSubtaskState,
  isUserOnlyTaskWorkflowStatus,
  TASK_WORKFLOW_STATUS_LABELS,
  type ActivityEvent,
  type ActivityEventDraft,
  type ActivityPayload,
  type Artifact,
  type Delivery,
  type DomainEvent,
  type DomainEventEnvelope,
  type Message,
  type Part,
  type Project,
  type ProjectId,
  type QuestionAnswer,
  type QuestionId,
  type QuestionItem,
  type Role,
  type RoleId,
  type Session,
  type SessionEndReason,
  type SessionId,
  type Subtask,
  type SubtaskFailureCode,
  type SubtaskId,
  type SubtaskState,
  type Task,
  type TaskId,
  type TaskWorkflowActor,
  type TaskWorkflowStatus,
  type Turn,
  type TurnId,
  type TurnResult,
  type UserQuestion,
  type UserQuestionStatus,
} from '@shared/domain'
import { agentLimitSettingsSchema } from '@shared/ipc'
import { isAbsolutePath } from '@shared/paths'
import type { ActivityPage, ProjectSummary, SubtaskDetail } from '@shared/ipc'
import type {
  AgentLimitSettings,
  AgentLimits,
  Clock,
  CreateSubtaskRecord,
  CreateTaskRecord,
  FinishTurnOutcome,
  IdFactory,
  LeaderNotice,
  LeaderNoticeStore,
  OpenSessionRecord,
  SaveRoleInput,
  StartTurnRecord,
  TaskService,
  TransitionSubtaskPatch,
  Unsubscribe,
} from '@shared/ports'
import {
  deliverySchema,
  partSchema,
  questionAnswerSchema,
  questionItemsSchema,
} from '@shared/schemas'
import {
  RESTART_PAUSE_MESSAGE,
  assembleFinalText,
  failureMessage,
  isPausedByRestart,
  resolveTurn,
} from '@shared/subtaskRules'
import { nextTaskWorkflowStatus, type TaskWorkflowSignal } from '@shared/taskWorkflow'
import { limitsFromSettings } from './agentLimits'
import { roleNameKey, type SqliteTaskStore } from './sqliteTaskStore'

export const systemClock: Clock = { now: () => Date.now() }
export const uuidIds: IdFactory = { newId: () => randomUUID() }

const AGENT_LIMITS_KEY = 'agentLimits'
const LAST_SEEN_VERSION_KEY = 'lastSeenVersion'

export interface TaskServiceDeps {
  store: SqliteTaskStore
  clock?: Clock
  ids?: IdFactory
  /** Erros de assinante nao derrubam a escrita; vao para ca (padrao: console.error). */
  onListenerError?: (error: unknown) => void
}

/** O que a recuperacao no boot fez. */
export interface RecoveryReport {
  /** Sessoes abertas que nao voltaram e foram encerradas com 'lost_on_restart'. */
  lostSessions: Session[]
  /**
   * Subtarefas que ficaram paradas em input_required ("parada: o app reiniciou"), esperando
   * o Lider responder (reabre o membro) ou cancelar. Uma entrada (e um aviso) por subtarefa.
   */
  pausedSubtasks: Subtask[]
  /** Subtarefas fechadas pela entrega estruturada gravada antes da queda. */
  deliveredSubtasks: Subtask[]
  /**
   * Ultima sessao de Lider de cada tarefa aberta, encerrada agora, que tem
   * providerSessionId: o TeamCoordinator retoma com --resume / resume.
   */
  leadersToResume: Session[]
}

const PROMPT_ACTIVITY_MAX = MAX_ACTIVITY_TEXT_CHARS

/**
 * Teto de avisos pendentes por tarefa: protege o banco de um laco que gere avisos sem fim.
 * Passou do teto, o mais antigo sai (o Lider ainda le tudo com subtarefas_ver).
 */
export const MAX_PENDING_LEADER_NOTICES = 200

function normalizeRootPath(rootPath: string): string {
  const resolved = resolve(rootPath.trim())
  return resolved.length > 1 ? resolved.replace(/\/+$/, '') : resolved
}

function clip(text: string, max = MAX_ACTIVITY_TEXT_CHARS): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function clipPayload(payload: ActivityPayload): ActivityPayload {
  switch (payload.kind) {
    case 'prompt':
    case 'text':
    case 'thought':
      return { ...payload, text: clip(payload.text) }
    case 'tool_result':
      return { ...payload, output: payload.output === null ? null : clip(payload.output) }
    case 'error':
      return { ...payload, message: clip(payload.message) }
    default:
      return payload
  }
}

function textOfParts(parts: readonly Part[]): string {
  return parts.flatMap((p) => (p.kind === 'text' ? [p.text] : [])).join('\n')
}

function defaultStatusMessage(
  to: SubtaskState,
  failureCode: SubtaskFailureCode | null,
): string | null {
  if (to === 'failed') return failureMessage(failureCode ?? 'error')
  if (to === 'canceled') return 'cancelada'
  return null
}

function notFound(what: string, id: string): DomainError {
  return new DomainError('not_found', `${what} não encontrado(a): ${id}`, { id })
}

export class SqliteTaskService implements TaskService, LeaderNoticeStore {
  private readonly store: SqliteTaskStore
  private readonly clock: Clock
  private readonly ids: IdFactory
  private readonly onListenerError: (error: unknown) => void
  private readonly listeners = new Set<(envelope: DomainEventEnvelope) => void>()
  /** Envelopes da escrita em curso. null fora de escrita. */
  private pending: DomainEventEnvelope[] | null = null

  constructor(deps: TaskServiceDeps) {
    this.store = deps.store
    this.clock = deps.clock ?? systemClock
    this.ids = deps.ids ?? uuidIds
    this.onListenerError = deps.onListenerError ?? ((e) => console.error('[tasks] assinante', e))
  }

  // -------------------------------------------------------------------------
  // Escrita + eventos
  // -------------------------------------------------------------------------

  subscribe(listener: (envelope: DomainEventEnvelope) => void): Unsubscribe {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Roda fn numa transacao e so publica os eventos depois do commit da escrita mais externa. */
  private write<T>(fn: () => T): T {
    if (this.pending !== null) return this.store.transaction(fn)
    const buffer: DomainEventEnvelope[] = []
    this.pending = buffer
    let result: T
    try {
      result = this.store.transaction(fn)
    } finally {
      this.pending = null
    }
    for (const envelope of buffer) {
      for (const listener of [...this.listeners]) {
        try {
          listener(envelope)
        } catch (error) {
          this.onListenerError(error)
        }
      }
    }
    return result
  }

  private emit(event: DomainEvent): void {
    if (this.pending === null) throw new DomainError('internal', 'evento fora de escrita')
    this.pending.push(this.store.appendEvent(event, this.clock.now()))
  }

  // -------------------------------------------------------------------------
  // Projetos
  // -------------------------------------------------------------------------

  listProjects(): Project[] {
    return this.store.listProjects()
  }

  /** Limites de agentes gravados; valor ausente ou ilegivel = sem limite. */
  getAgentLimitSettings(): AgentLimitSettings {
    const raw = this.store.getSetting(AGENT_LIMITS_KEY)
    const none = { maxLiveAgents: null, maxLiveMembersPerTask: null }
    if (raw === null) return none
    try {
      const parsed = agentLimitSettingsSchema.safeParse(JSON.parse(raw))
      if (parsed.success) return parsed.data
    } catch {
      // JSON corrompido: cai em sem limite, como valor fora de 1-100.
    }
    console.warn('[eclipse] limites de agentes gravados são inválidos; usando sem limite')
    return none
  }

  /** Ultima versao cujas "Novidades" o usuario fechou; null na primeira instalacao. */
  getLastSeenVersion(): string | null {
    const raw = this.store.getSetting(LAST_SEEN_VERSION_KEY)
    return raw === null ? null : (JSON.parse(raw) as string)
  }

  saveLastSeenVersion(version: string): void {
    this.store.setSetting(LAST_SEEN_VERSION_KEY, JSON.stringify(version))
  }

  getAgentLimits(): AgentLimits {
    return limitsFromSettings(this.getAgentLimitSettings())
  }

  saveAgentLimitSettings(settings: AgentLimitSettings): AgentLimitSettings {
    this.store.setSetting(AGENT_LIMITS_KEY, JSON.stringify(settings))
    return settings
  }

  summarizeProjects(): ProjectSummary[] {
    return this.store.listProjects().map((project) => ({
      projectId: project.id,
      openTasks: this.store.listTasks(project.id, { includeArchived: false }).length,
      needsYou: this.store.listOpenQuestions(project.id).length,
    }))
  }

  getProject(id: ProjectId): Project {
    return (
      this.store.getProject(id) ??
      (() => {
        throw notFound('projeto', id)
      })()
    )
  }

  addProject(input: { rootPath: string; name?: string | undefined }): Project {
    const rootPath = normalizeRootPath(input.rootPath)
    if (!isAbsolutePath(rootPath)) {
      throw new DomainError('invalid_input', 'caminho do projeto precisa ser absoluto')
    }
    return this.write(() => {
      if (this.store.getProjectByRoot(rootPath)) {
        throw new DomainError('conflict', `projeto já existe nesta pasta: ${rootPath}`)
      }
      const now = this.clock.now()
      const name = input.name?.trim() || basename(rootPath) || rootPath
      const project: Project = {
        id: this.ids.newId(),
        name,
        rootPath,
        createdAt: now,
        updatedAt: now,
      }
      this.store.insertProject(project)
      this.emit({ type: 'project.upserted', project })
      for (const role of DEFAULT_ROLES) this.saveRole({ ...role, projectId: project.id })
      return project
    })
  }

  getProjectByRoot(rootPath: string): Project | null {
    return this.store.getProjectByRoot(normalizeRootPath(rootPath))
  }

  renameProject(id: ProjectId, name: string): Project {
    const trimmed = name.trim()
    if (!trimmed) throw new DomainError('invalid_input', 'o nome do projeto não pode ficar vazio')
    return this.write(() => {
      const project: Project = {
        ...this.getProject(id),
        name: trimmed,
        updatedAt: this.clock.now(),
      }
      this.store.updateProject(project)
      this.emit({ type: 'project.upserted', project })
      return project
    })
  }

  removeProject(id: ProjectId): void {
    this.write(() => {
      this.getProject(id)
      const live = this.store
        .listOpenSessions()
        .filter((s) => this.store.getTask(s.taskId)?.projectId === id)
      if (live.length > 0) {
        throw new DomainError('conflict', 'feche os agentes do projeto antes de removê-lo', {
          liveSessions: live.length,
        })
      }
      this.store.deleteProject(id)
      this.emit({ type: 'project.removed', projectId: id })
    })
  }

  // -------------------------------------------------------------------------
  // Papeis
  // -------------------------------------------------------------------------

  listRoles(projectId: ProjectId): Role[] {
    return this.store.listRoles(projectId)
  }

  getRole(id: RoleId): Role {
    return (
      this.store.getRole(id) ??
      (() => {
        throw notFound('papel', id)
      })()
    )
  }

  findRoleByName(projectId: ProjectId, name: string): Role | null {
    const key = roleNameKey(name)
    return this.store.listRoles(projectId).find((r) => roleNameKey(r.name) === key) ?? null
  }

  getLeadRole(projectId: ProjectId): Role | null {
    return this.store.listRoles(projectId).find((r) => r.isLead) ?? null
  }

  saveRole(input: SaveRoleInput): Role {
    const name = input.name.trim()
    if (!name) throw new DomainError('invalid_input', 'papel precisa de nome')
    return this.write(() => {
      this.getProject(input.projectId)
      const now = this.clock.now()
      const existing = input.roleId ? this.store.getRole(input.roleId) : null
      if (input.roleId) {
        if (!existing || this.store.isRoleDeleted(input.roleId)) {
          throw notFound('papel', input.roleId)
        }
        if (existing.projectId !== input.projectId) {
          throw new DomainError('invalid_input', 'papel pertence a outro projeto')
        }
      }
      const access = input.access ?? existing?.access ?? 'full'
      // O Lider roda com permissao total: acesso restrito a ele nao teria efeito.
      if (input.isLead && access !== 'full') {
        throw new DomainError('invalid_input', 'o Líder precisa de acesso total')
      }
      const clash = this.findRoleByName(input.projectId, name)
      if (clash && clash.id !== existing?.id) {
        throw new DomainError('conflict', `já existe um papel chamado "${clash.name}"`)
      }
      // No maximo um Lider por projeto: escolher outro Lider tira a marca do anterior.
      if (input.isLead) {
        const lead = this.getLeadRole(input.projectId)
        if (lead && lead.id !== existing?.id) {
          const demoted: Role = { ...lead, isLead: false, updatedAt: now }
          this.store.updateRole(demoted)
          this.emit({ type: 'role.upserted', role: demoted })
        }
      }
      const role: Role = {
        id: existing?.id ?? this.ids.newId(),
        projectId: input.projectId,
        name,
        description: input.description,
        provider: input.provider,
        model: input.model,
        promptTemplate: input.promptTemplate,
        isLead: input.isLead,
        access,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      }
      if (existing) this.store.updateRole(role)
      else this.store.insertRole(role)
      this.emit({ type: 'role.upserted', role })
      return role
    })
  }

  deleteRole(id: RoleId): void {
    this.write(() => {
      const role = this.getRole(id)
      if (this.store.isRoleDeleted(id)) return
      this.store.deleteRole(id)
      this.emit({ type: 'role.deleted', roleId: id, projectId: role.projectId })
    })
  }

  // -------------------------------------------------------------------------
  // Tarefas
  // -------------------------------------------------------------------------

  listTasks(projectId: ProjectId, options: { includeArchived: boolean }): Task[] {
    return this.store.listTasks(projectId, options)
  }

  getTask(id: TaskId): Task {
    return (
      this.store.getTask(id) ??
      (() => {
        throw notFound('tarefa', id)
      })()
    )
  }

  private getOpenTask(id: TaskId): Task {
    const task = this.getTask(id)
    if (task.status === 'archived') {
      throw new DomainError('conflict', 'tarefa arquivada não aceita mudanças', { taskId: id })
    }
    return task
  }

  private getActiveRole(id: RoleId, projectId: ProjectId): Role {
    const role = this.store.getRole(id)
    if (!role || this.store.isRoleDeleted(id)) throw notFound('papel', id)
    if (role.projectId !== projectId) {
      throw new DomainError('invalid_input', 'papel pertence a outro projeto', { roleId: id })
    }
    return role
  }

  createTask(record: CreateTaskRecord): Task {
    const title = record.title.trim()
    if (!title) throw new DomainError('invalid_input', 'tarefa precisa de título')
    if (record.worktreePath === null && (record.branch !== null || record.baseBranch !== null)) {
      throw new DomainError('invalid_input', 'branch sem worktree')
    }
    return this.write(() => {
      this.getProject(record.projectId)
      let leadRoleId = record.leadRoleId
      if (leadRoleId) this.getActiveRole(leadRoleId, record.projectId)
      if (record.kind === 'team' && !leadRoleId) {
        leadRoleId = this.getLeadRole(record.projectId)?.id ?? null
        if (!leadRoleId) {
          throw new DomainError('invalid_input', 'o projeto não tem papel de Líder')
        }
      }
      const now = this.clock.now()
      const task: Task = {
        id: this.ids.newId(),
        projectId: record.projectId,
        contextId: this.ids.newId(),
        title,
        name: title,
        kind: record.kind,
        worktreePath: record.worktreePath,
        branch: record.branch,
        baseBranch: record.baseBranch,
        leadRoleId,
        soloProvider: record.soloProvider,
        status: 'open',
        workflowStatus: 'a_fazer',
        startCommand: null,
        startDir: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
      }
      this.store.insertTask(task)
      this.emit({ type: 'task.upserted', task })
      return task
    })
  }

  /**
   * Arquiva a tarefa. Recusa ('conflict') se ainda houver sessao aberta: o
   * TeamCoordinator fecha os agentes antes. Subtarefas nao finais viram 'canceled'.
   */
  markTaskArchived(id: TaskId, finalStatus: 'lancado' | 'cancelado' = 'lancado'): Task {
    return this.write(() => {
      const task = this.getTask(id)
      if (task.status === 'archived') return task
      const open = this.store.listSessions(id).filter((s) => s.status !== 'exited')
      if (open.length > 0) {
        throw new DomainError('conflict', 'feche os agentes da tarefa antes de arquivar', {
          openSessions: open.length,
        })
      }
      for (const subtask of this.store.listSubtasks(id)) {
        if (!isFinalSubtaskState(subtask.state)) {
          this.applyTransition(subtask, 'canceled', {
            statusMessage: 'cancelada: tarefa arquivada',
          })
        }
      }
      for (const question of this.store.listOpenQuestions(task.projectId)) {
        if (question.taskId === id) this.closeQuestion(question, 'dismissed', null)
      }
      const now = this.clock.now()
      const archived: Task = {
        ...this.getTask(id),
        status: 'archived',
        workflowStatus: finalStatus,
        archivedAt: now,
        updatedAt: now,
      }
      this.store.updateTask(archived)
      this.emit({ type: 'task.upserted', task: archived })
      return archived
    })
  }

  // -------------------------------------------------------------------------
  // Status de trabalho da tarefa (I6)
  // -------------------------------------------------------------------------

  setTaskWorkflowStatus(id: TaskId, to: TaskWorkflowStatus, actor: TaskWorkflowActor): Task {
    return this.write(() => {
      const task = this.getTask(id)
      if (actor !== 'user') {
        if (isUserOnlyTaskWorkflowStatus(to)) {
          throw new DomainError(
            'forbidden',
            `só o usuário marca "${TASK_WORKFLOW_STATUS_LABELS[to]}"`,
            { taskId: id, to },
          )
        }
        if (isArchivedWorkflowStatus(task.workflowStatus)) {
          throw new DomainError(
            'invalid_transition',
            'tarefa lançada ou cancelada não muda por automação',
            { taskId: id },
          )
        }
      }
      if (task.workflowStatus === to) return task
      // Lancar arquiva (W3): fecha subtarefas e perguntas pelo mesmo caminho do arquivar.
      if (isArchivedWorkflowStatus(to) && task.status !== 'archived') {
        return this.markTaskArchived(id, to as 'lancado' | 'cancelado')
      }
      const now = this.clock.now()
      // Ja arquivada e indo para o outro status final: so troca o rotulo (continua arquivada).
      const next: Task =
        task.status === 'archived' && !isArchivedWorkflowStatus(to)
          ? { ...task, status: 'open', archivedAt: null, workflowStatus: to, updatedAt: now }
          : { ...task, workflowStatus: to, updatedAt: now }
      this.store.updateTask(next)
      this.emit({ type: 'task.upserted', task: next })
      return next
    })
  }

  setTaskStartCommand(id: TaskId, command: string | null, dir: string | null): Task {
    if (dir && (isAbsolute(dir) || dir.split(/[\\/]+/).includes('..'))) {
      throw new DomainError(
        'invalid_input',
        'a pasta precisa ser relativa e ficar dentro da worktree',
      )
    }
    return this.write(() => {
      const task = this.getTask(id)
      const next: Task = {
        ...task,
        startCommand: command,
        startDir: command ? dir : null,
        updatedAt: this.clock.now(),
      }
      this.store.updateTask(next)
      this.emit({ type: 'task.upserted', task: next })
      return next
    })
  }

  renameTask(id: TaskId, name: string): Task {
    const trimmed = name.trim()
    if (!trimmed) throw new DomainError('invalid_input', 'a tarefa precisa de um nome')
    return this.write(() => {
      const next: Task = { ...this.getTask(id), name: trimmed, updatedAt: this.clock.now() }
      this.store.updateTask(next)
      this.emit({ type: 'task.upserted', task: next })
      return next
    })
  }

  markTaskWorkStarted(id: TaskId): Task {
    return this.write(() => this.applyTaskSignal(id, 'work_started'))
  }

  concludeTask(id: TaskId): Task {
    return this.write(() => {
      const task = this.getTask(id)
      if (isArchivedWorkflowStatus(task.workflowStatus)) {
        throw new DomainError('invalid_transition', 'a tarefa já foi lançada ou cancelada', { taskId: id })
      }
      const open = this.store.countOpenQuestions(id)
      if (open > 0) {
        throw new DomainError(
          'conflict',
          'há pergunta ao usuário sem resposta; espere a resposta antes de concluir',
          { taskId: id, openQuestions: open },
        )
      }
      return this.applyTaskSignal(id, 'leader_concluded')
    })
  }

  /** Aplica a regra automatica (taskWorkflow.ts). Chamar sempre dentro de write(). */
  private applyTaskSignal(id: TaskId, signal: TaskWorkflowSignal): Task {
    const task = this.getTask(id)
    const to = nextTaskWorkflowStatus(task.workflowStatus, signal)
    if (to === null) return task
    const next: Task = { ...task, workflowStatus: to, updatedAt: this.clock.now() }
    this.store.updateTask(next)
    this.emit({ type: 'task.upserted', task: next })
    return next
  }

  // -------------------------------------------------------------------------
  // Subtarefas
  // -------------------------------------------------------------------------

  listSubtasks(taskId: TaskId): Subtask[] {
    return this.store.listSubtasks(taskId)
  }

  getSubtask(id: SubtaskId): Subtask {
    return (
      this.store.getSubtask(id) ??
      (() => {
        throw notFound('subtarefa', id)
      })()
    )
  }

  getSubtaskDetail(id: SubtaskId): SubtaskDetail {
    const subtask = this.getSubtask(id)
    return {
      subtask,
      messages: this.store.listMessages(id),
      artifacts: this.store.listArtifacts(id),
      turns: this.store.listTurns(id),
      session: subtask.sessionId ? this.store.getSession(subtask.sessionId) : null,
    }
  }

  createSubtask(record: CreateSubtaskRecord): Subtask {
    const title = record.title.trim()
    if (!title) throw new DomainError('invalid_input', 'subtarefa precisa de título')
    return this.write(() => {
      const task = this.getOpenTask(record.taskId)
      if (task.kind !== 'team') {
        throw new DomainError('invalid_input', 'avulso não tem subtarefas')
      }
      this.getActiveRole(record.roleId, task.projectId)
      const refs = [...new Set(record.referenceTaskIds)]
      for (const refId of refs) {
        const ref = this.store.getSubtask(refId)
        if (!ref || ref.taskId !== task.id) {
          throw new DomainError('invalid_input', `origem não é subtarefa desta tarefa: ${refId}`, {
            subtaskId: refId,
          })
        }
      }
      const now = this.clock.now()
      const subtask: Subtask = {
        id: this.ids.newId(),
        taskId: task.id,
        roleId: record.roleId,
        title,
        instructions: record.instructions,
        state: 'submitted',
        statusMessage: null,
        failureCode: null,
        referenceTaskIds: refs,
        sessionId: null,
        createdAt: now,
        updatedAt: now,
        finishedAt: null,
      }
      this.store.insertSubtask(subtask)
      this.emit({ type: 'subtask.upserted', subtask })
      return subtask
    })
  }

  /** Valida e grava uma transicao. Chamar sempre dentro de write(). */
  private applyTransition(
    subtask: Subtask,
    to: SubtaskState,
    patch: TransitionSubtaskPatch = {},
  ): Subtask {
    if (isFinalSubtaskState(subtask.state)) {
      throw new DomainError(
        'final_state',
        `subtarefa já terminou (${subtask.state}); correção vira subtarefa nova`,
        { subtaskId: subtask.id, state: subtask.state },
      )
    }
    if (!canTransitionSubtask(subtask.state, to)) {
      throw new DomainError('invalid_transition', `transição inválida: ${subtask.state} -> ${to}`, {
        subtaskId: subtask.id,
        from: subtask.state,
        to,
      })
    }
    const now = this.clock.now()
    const failureCode = to === 'failed' ? (patch.failureCode ?? 'error') : null
    const next: Subtask = {
      ...subtask,
      state: to,
      failureCode,
      statusMessage:
        patch.statusMessage !== undefined
          ? patch.statusMessage
          : defaultStatusMessage(to, failureCode),
      updatedAt: now,
      finishedAt: isFinalSubtaskState(to) ? now : null,
    }
    this.store.updateSubtask(next)
    this.emit({ type: 'subtask.upserted', subtask: next })
    if (to === 'working') this.applyTaskSignal(subtask.taskId, 'work_started')
    return next
  }

  transitionSubtask(id: SubtaskId, to: SubtaskState, patch?: TransitionSubtaskPatch): Subtask {
    return this.write(() => this.applyTransition(this.getSubtask(id), to, patch))
  }

  private isSessionOpen(sessionId: SessionId): boolean {
    const session = this.store.getSession(sessionId)
    return !!session && session.status !== 'exited'
  }

  attachSubtaskSession(id: SubtaskId, sessionId: SessionId): Subtask {
    return this.write(() => {
      const subtask = this.getSubtask(id)
      if (isFinalSubtaskState(subtask.state)) {
        throw new DomainError('final_state', 'subtarefa já terminou', { subtaskId: id })
      }
      const session = this.getSession(sessionId)
      if (session.kind !== 'member-acp' || session.subtaskId !== id) {
        throw new DomainError('invalid_input', 'sessão não é do membro desta subtarefa')
      }
      if (subtask.sessionId === sessionId) return subtask
      // Sessao anterior encerrada (ex: o app reiniciou): o membro reaberto a substitui.
      if (subtask.sessionId !== null && this.isSessionOpen(subtask.sessionId)) {
        throw new DomainError('conflict', 'subtarefa já tem sessão de membro', { subtaskId: id })
      }
      const next: Subtask = { ...subtask, sessionId, updatedAt: this.clock.now() }
      this.store.updateSubtask(next)
      this.emit({ type: 'subtask.upserted', subtask: next })
      return next
    })
  }

  addMessage(input: Omit<Message, 'id' | 'createdAt'>): Message {
    const parts = this.validateParts(input.parts)
    return this.write(() => {
      const subtask = this.getSubtask(input.subtaskId)
      if (subtask.taskId !== input.taskId) {
        throw new DomainError('invalid_input', 'mensagem com tarefa diferente da subtarefa')
      }
      return this.insertMessage({ ...input, parts })
    })
  }

  private insertMessage(input: Omit<Message, 'id' | 'createdAt'>): Message {
    const message: Message = { ...input, id: this.ids.newId(), createdAt: this.clock.now() }
    this.store.insertMessage(message)
    this.emit({ type: 'message.added', message })
    return message
  }

  private validateParts(parts: unknown): Part[] {
    const parsed = partSchema.array().max(100).safeParse(parts)
    if (!parsed.success) throw new DomainError('invalid_input', 'partes da mensagem inválidas')
    return parsed.data
  }

  // -------------------------------------------------------------------------
  // Sessoes
  // -------------------------------------------------------------------------

  getSession(id: SessionId): Session {
    return (
      this.store.getSession(id) ??
      (() => {
        throw notFound('sessão', id)
      })()
    )
  }

  listSessions(taskId: TaskId): Session[] {
    return this.store.listSessions(taskId)
  }

  listOpenSessions(): Session[] {
    return this.store.listOpenSessions()
  }

  getLiveLeaderSession(taskId: TaskId): Session | null {
    return (
      this.store
        .listSessions(taskId)
        .find((s) => s.kind === 'leader-pty' && s.status !== 'exited') ?? null
    )
  }

  /** Ultima sessao de Lider da tarefa (viva ou nao), para retomar com o providerSessionId. */
  getLatestLeaderSession(taskId: TaskId): Session | null {
    return (
      this.store
        .listSessions(taskId)
        .filter((s) => s.kind === 'leader-pty')
        .at(-1) ?? null
    )
  }

  openSession(record: OpenSessionRecord): Session {
    return this.write(() => {
      const task = this.getOpenTask(record.taskId)
      if (record.roleId) this.getActiveRole(record.roleId, task.projectId)
      if (record.kind === 'leader-pty') {
        if (record.subtaskId !== null) {
          throw new DomainError('invalid_input', 'sessão do Líder não tem subtarefa')
        }
        const live = this.getLiveLeaderSession(task.id)
        if (live) {
          throw new DomainError('conflict', 'a tarefa já tem um Líder vivo', {
            sessionId: live.id,
          })
        }
      } else {
        if (record.subtaskId === null) {
          throw new DomainError('invalid_input', 'sessão de membro precisa de subtarefa')
        }
        const subtask = this.getSubtask(record.subtaskId)
        if (subtask.taskId !== task.id) {
          throw new DomainError('invalid_input', 'subtarefa de outra tarefa')
        }
        if (isFinalSubtaskState(subtask.state)) {
          throw new DomainError('final_state', 'subtarefa já terminou', { subtaskId: subtask.id })
        }
        if (subtask.sessionId !== null && this.isSessionOpen(subtask.sessionId)) {
          throw new DomainError('conflict', 'subtarefa já tem sessão de membro', {
            subtaskId: subtask.id,
          })
        }
      }
      const session: Session = {
        id: this.ids.newId(),
        taskId: task.id,
        subtaskId: record.subtaskId,
        roleId: record.roleId,
        kind: record.kind,
        provider: record.provider,
        model: record.model,
        cwd: record.cwd,
        providerSessionId: record.providerSessionId,
        pid: null,
        status: 'starting',
        activeTurnId: null,
        startedAt: this.clock.now(),
        endedAt: null,
        endReason: null,
        exitCode: null,
      }
      this.store.insertSession(session)
      this.emit({ type: 'session.upserted', session })
      return session
    })
  }

  updateSession(
    id: SessionId,
    patch: Partial<Pick<Session, 'providerSessionId' | 'pid' | 'status'>>,
  ): Session {
    return this.write(() => {
      const session = this.getSession(id)
      if (patch.status === 'exited') {
        throw new DomainError('invalid_input', 'use endSession para encerrar a sessão')
      }
      if (patch.status !== undefined && session.status === 'exited') {
        throw new DomainError('invalid_transition', 'sessão encerrada não volta', {
          sessionId: id,
        })
      }
      const next: Session = {
        ...session,
        providerSessionId:
          patch.providerSessionId !== undefined
            ? patch.providerSessionId
            : session.providerSessionId,
        pid: patch.pid !== undefined ? patch.pid : session.pid,
        status: patch.status ?? session.status,
      }
      this.store.updateSession(next)
      this.emit({ type: 'session.upserted', session: next })
      return next
    })
  }

  /** Idempotente: sessao ja encerrada volta como esta, sem evento. */
  endSession(id: SessionId, end: { reason: SessionEndReason; exitCode: number | null }): Session {
    return this.write(() => {
      const session = this.getSession(id)
      if (session.status === 'exited') return session
      const next: Session = {
        ...session,
        status: 'exited',
        endedAt: this.clock.now(),
        endReason: end.reason,
        exitCode: end.exitCode,
      }
      this.store.updateSession(next)
      this.emit({ type: 'session.upserted', session: next })
      return next
    })
  }

  // -------------------------------------------------------------------------
  // Turnos e entregas
  // -------------------------------------------------------------------------

  startTurn(record: StartTurnRecord): Turn {
    const parts = this.validateParts(record.parts)
    return this.write(() => {
      const session = this.getSession(record.sessionId)
      if (session.kind !== 'member-acp' || session.subtaskId !== record.subtaskId) {
        throw new DomainError('invalid_input', 'turno só existe em sessão de membro da subtarefa')
      }
      if (session.status === 'exited') {
        throw new DomainError('invalid_transition', 'sessão encerrada', { sessionId: session.id })
      }
      if (session.activeTurnId !== null) {
        throw new DomainError('conflict', 'a sessão já tem um turno em andamento', {
          turnId: session.activeTurnId,
        })
      }
      const subtask = this.getSubtask(record.subtaskId)
      if (subtask.state !== 'working') {
        throw new DomainError(
          isFinalSubtaskState(subtask.state) ? 'final_state' : 'invalid_transition',
          `turno só começa com a subtarefa em 'working' (está em '${subtask.state}')`,
        )
      }
      const now = this.clock.now()
      const turn: Turn = {
        id: this.ids.newId(),
        sessionId: session.id,
        subtaskId: subtask.id,
        startedAt: now,
        endedAt: null,
        stopReason: null,
        error: null,
        finalText: null,
      }
      this.store.insertTurn(turn)
      this.emit({ type: 'turn.upserted', turn })
      this.insertMessage({
        taskId: subtask.taskId,
        subtaskId: subtask.id,
        author: record.author,
        parts,
        turnId: turn.id,
      })
      this.appendActivityInWrite([
        {
          sessionId: session.id,
          subtaskId: subtask.id,
          turnId: turn.id,
          at: now,
          payload: { kind: 'prompt', text: clip(textOfParts(parts), PROMPT_ACTIVITY_MAX) },
        },
      ])
      const nextSession: Session = {
        ...session,
        activeTurnId: turn.id,
        status: session.status === 'starting' ? 'running' : session.status,
      }
      this.store.updateSession(nextSession)
      this.emit({ type: 'session.upserted', session: nextSession })
      return turn
    })
  }

  recordDelivery(sessionId: SessionId, delivery: Delivery, parts: Part[] = []): Artifact {
    const parsed = deliverySchema.safeParse(delivery)
    if (!parsed.success) throw new DomainError('invalid_input', 'entrega inválida')
    const validParts = this.validateParts(parts)
    return this.write(() => {
      const session = this.getSession(sessionId)
      if (session.kind !== 'member-acp' || session.subtaskId === null) {
        throw new DomainError('forbidden', 'só o membro entrega')
      }
      if (session.activeTurnId === null) {
        throw new DomainError('invalid_transition', 'entrega fora de turno', { sessionId })
      }
      const subtask = this.getSubtask(session.subtaskId)
      if (isFinalSubtaskState(subtask.state)) {
        throw new DomainError('final_state', 'subtarefa já terminou', { subtaskId: subtask.id })
      }
      const artifact: Artifact = {
        id: this.ids.newId(),
        taskId: subtask.taskId,
        subtaskId: subtask.id,
        sessionId,
        turnId: session.activeTurnId,
        format: 'structured',
        delivery: parsed.data,
        parts: validParts,
        createdAt: this.clock.now(),
      }
      this.store.insertArtifact(artifact)
      this.emit({ type: 'artifact.added', artifact })
      return artifact
    })
  }

  listTurnDeliveries(turnId: TurnId): Artifact[] {
    return this.store.listArtifactsForTurn(turnId).filter((a) => a.format === 'structured')
  }

  finishTurn(result: TurnResult): FinishTurnOutcome {
    return this.write(() => this.applyFinishTurn(result, false))
  }

  /**
   * Fecha o turno. `afterRestart` (recuperacao): sem entrega final (pronto ou bloqueado)
   * gravada, a subtarefa fica parada em input_required com RESTART_PAUSE_MESSAGE,
   * esperando o Lider, porque o membro nao existe mais para continuar sozinho.
   */
  private applyFinishTurn(result: TurnResult, afterRestart: boolean): FinishTurnOutcome {
    const turn =
      this.store.getTurn(result.turnId) ??
      (() => {
        throw notFound('turno', result.turnId)
      })()
    if (turn.sessionId !== result.sessionId) {
      throw new DomainError('invalid_input', 'turno de outra sessão')
    }
    const subtask = this.getSubtask(turn.subtaskId)
    if (turn.endedAt !== null) {
      return { turn, subtask, fallbackArtifact: null, transitioned: false }
    }
    // As entregas vem do banco (fonte da verdade), nao do que o runtime mandou.
    const deliveries = this.listTurnDeliveries(turn.id)
    const resolution = resolveTurn({ ...result, deliveries })
    const endedTurn: Turn = {
      ...turn,
      endedAt: result.endedAt,
      stopReason: result.outcome.kind === 'stopped' ? result.outcome.stopReason : null,
      error: result.outcome.kind === 'error' ? result.outcome.error : null,
      finalText: result.finalText,
    }
    this.store.updateTurn(endedTurn)
    this.emit({ type: 'turn.upserted', turn: endedTurn })

    const session = this.getSession(turn.sessionId)
    if (session.activeTurnId === turn.id) {
      const nextSession: Session = { ...session, activeTurnId: null }
      this.store.updateSession(nextSession)
      this.emit({ type: 'session.upserted', session: nextSession })
    }

    if (isFinalSubtaskState(subtask.state)) {
      return { turn: endedTurn, subtask, fallbackArtifact: null, transitioned: false }
    }

    let fallbackArtifact: Artifact | null = null
    if (resolution.fallbackDelivery) {
      fallbackArtifact = {
        id: this.ids.newId(),
        taskId: subtask.taskId,
        subtaskId: subtask.id,
        sessionId: turn.sessionId,
        turnId: turn.id,
        format: 'unformatted',
        delivery: resolution.fallbackDelivery,
        parts: [],
        createdAt: this.clock.now(),
      }
      this.store.insertArtifact(fallbackArtifact)
      this.emit({ type: 'artifact.added', artifact: fallbackArtifact })
    }

    const memberText = result.finalText || deliveries.at(-1)?.delivery.summary || ''
    if (memberText) {
      this.insertMessage({
        taskId: subtask.taskId,
        subtaskId: subtask.id,
        author: 'member',
        parts: [{ kind: 'text', text: memberText }],
        turnId: turn.id,
      })
    }

    let state = resolution.state
    let failureCode = resolution.failureCode
    let statusMessage = resolution.statusMessage
    // Sem entrega final gravada (ou com uma duvida): o membro nao existe mais para seguir.
    // A subtarefa para e espera o Lider (responder reabre o membro; ou cancelar).
    if (afterRestart && (deliveries.length === 0 || !isFinalSubtaskState(state))) {
      state = 'input_required'
      failureCode = null
      statusMessage = RESTART_PAUSE_MESSAGE
    }
    // O turno roda com a subtarefa em 'working'; se ela nao esta mais la (ex: a tela
    // mexeu no meio), so transiciona se a regra deixar.
    const from = subtask.state
    if (from === state || !canTransitionSubtask(from, state)) {
      return { turn: endedTurn, subtask, fallbackArtifact, transitioned: false }
    }
    const next = this.applyTransition(subtask, state, { statusMessage, failureCode })
    return { turn: endedTurn, subtask: next, fallbackArtifact, transitioned: true }
  }

  // -------------------------------------------------------------------------
  // Atividade
  // -------------------------------------------------------------------------

  appendActivity(drafts: ActivityEventDraft[]): ActivityEvent[] {
    if (drafts.length === 0) return []
    return this.write(() => this.appendActivityInWrite(drafts))
  }

  private appendActivityInWrite(drafts: ActivityEventDraft[]): ActivityEvent[] {
    const sessions = new Map<SessionId, Session>()
    for (const draft of drafts) {
      const session = sessions.get(draft.sessionId) ?? this.getSession(draft.sessionId)
      sessions.set(session.id, session)
      if (session.subtaskId !== draft.subtaskId) {
        throw new DomainError('invalid_input', 'atividade com subtarefa diferente da sessão')
      }
    }
    const events = this.store.appendActivity(
      drafts.map((d) => ({ ...d, payload: clipPayload(d.payload) })),
    )
    this.emit({ type: 'activity.appended', events })
    return events
  }

  listActivity(subtaskId: SubtaskId, afterSeq: number | null, limit: number): ActivityPage {
    return this.store.listActivity(subtaskId, afterSeq, Math.max(1, Math.min(limit, 1_000)))
  }

  // -------------------------------------------------------------------------
  // Perguntas ao usuario
  // -------------------------------------------------------------------------

  listOpenQuestions(projectId: ProjectId): UserQuestion[] {
    return this.store.listOpenQuestions(projectId)
  }

  createQuestion(input: {
    taskId: TaskId
    subtaskId: SubtaskId | null
    items: QuestionItem[]
  }): UserQuestion {
    const parsed = questionItemsSchema.safeParse(input.items)
    if (!parsed.success) throw new DomainError('invalid_input', 'pergunta precisa de 1 a 4 itens')
    const ids = parsed.data.map((i) => i.id)
    if (new Set(ids).size !== ids.length) {
      throw new DomainError('invalid_input', 'itens da pergunta com id repetido')
    }
    return this.write(() => {
      const task = this.getOpenTask(input.taskId)
      if (input.subtaskId !== null) {
        const subtask = this.getSubtask(input.subtaskId)
        if (subtask.taskId !== task.id) {
          throw new DomainError('invalid_input', 'subtarefa de outra tarefa')
        }
      }
      // Pergunta nova substitui as abertas da mesma tarefa (Q1): so a ultima fica em
      // "Precisa de voce". Sem sinal questions_cleared: a tarefa continua em 'pergunta'.
      for (const previous of this.store.listOpenTaskQuestions(task.id)) {
        this.markQuestionClosed(previous, 'superseded', null)
      }
      const question: UserQuestion = {
        id: this.ids.newId(),
        taskId: task.id,
        subtaskId: input.subtaskId,
        items: parsed.data,
        status: 'open',
        answers: null,
        createdAt: this.clock.now(),
        answeredAt: null,
      }
      this.store.insertQuestion(question)
      this.emit({ type: 'question.upserted', question })
      this.applyTaskSignal(task.id, 'question_opened')
      return question
    })
  }

  getQuestion(id: QuestionId): UserQuestion {
    return (
      this.store.getQuestion(id) ??
      (() => {
        throw notFound('pergunta', id)
      })()
    )
  }

  answerQuestion(id: QuestionId, answers: QuestionAnswer[]): UserQuestion {
    const parsed = questionAnswerSchema.array().min(1).max(4).safeParse(answers)
    if (!parsed.success) throw new DomainError('invalid_input', 'respostas inválidas')
    return this.write(() => {
      const question = this.getQuestion(id)
      const itemIds = new Set(question.items.map((i) => i.id))
      for (const answer of parsed.data) {
        const item = question.items.find((i) => i.id === answer.itemId)
        if (!item || !itemIds.has(answer.itemId)) {
          throw new DomainError(
            'invalid_input',
            `resposta para item desconhecido: ${answer.itemId}`,
          )
        }
        const optionIds = new Set(item.options.map((o) => o.id))
        if (answer.optionIds.some((o) => !optionIds.has(o))) {
          throw new DomainError('invalid_input', `opção desconhecida no item ${item.id}`)
        }
        if (!item.multiSelect && answer.optionIds.length > 1) {
          throw new DomainError('invalid_input', `item ${item.id} aceita uma opção só`)
        }
      }
      return this.closeQuestion(question, 'answered', parsed.data)
    })
  }

  dismissQuestion(id: QuestionId): UserQuestion {
    return this.write(() => this.closeQuestion(this.getQuestion(id), 'dismissed', null))
  }

  closeQuestionsAnsweredInTerminal(taskId: TaskId): UserQuestion[] {
    return this.write(() => {
      const open = this.store.listOpenTaskQuestions(taskId)
      if (open.length === 0) return []
      const closed = open.map((q) => this.markQuestionClosed(q, 'answered_in_terminal', null))
      this.applyTaskSignal(taskId, 'questions_cleared')
      return closed
    })
  }

  private closeQuestion(
    question: UserQuestion,
    status: 'answered' | 'dismissed',
    answers: QuestionAnswer[] | null,
  ): UserQuestion {
    const next = this.markQuestionClosed(question, status, answers)
    if (this.store.countOpenQuestions(question.taskId) === 0) {
      this.applyTaskSignal(question.taskId, 'questions_cleared')
    }
    return next
  }

  /** open -> status final. Grava e emite; o sinal da tarefa fica com quem chamou. */
  private markQuestionClosed(
    question: UserQuestion,
    status: Exclude<UserQuestionStatus, 'open'>,
    answers: QuestionAnswer[] | null,
  ): UserQuestion {
    if (question.status !== 'open') {
      throw new DomainError('invalid_transition', 'pergunta já foi respondida ou descartada', {
        questionId: question.id,
        status: question.status,
      })
    }
    const next: UserQuestion = {
      ...question,
      status,
      answers,
      answeredAt: this.clock.now(),
    }
    this.store.updateQuestion(next)
    this.emit({ type: 'question.upserted', question: next })
    return next
  }

  // -------------------------------------------------------------------------
  // Avisos ao Lider (fila duravel; sem evento de dominio: a tela nao mostra)
  // -------------------------------------------------------------------------

  enqueueLeaderNotice(taskId: TaskId, text: string, subtaskId?: SubtaskId): LeaderNotice {
    return this.write(() => this.insertLeaderNotice(taskId, text, subtaskId))
  }

  discardPendingLeaderNoticesForSubtasks(taskId: TaskId, subtaskIds: readonly SubtaskId[]): void {
    // delivered_at = -2: o Lider ja viu a subtarefa; nunca colado (-1 e o teto).
    this.write(() => this.store.discardPendingLeaderNoticesForSubtasks(taskId, subtaskIds, -2))
  }

  private insertLeaderNotice(taskId: TaskId, text: string, subtaskId?: SubtaskId): LeaderNotice {
    if (!this.store.getTask(taskId)) throw notFound('tarefa', taskId)
    const notice = this.store.insertLeaderNotice(taskId, text, this.clock.now(), subtaskId ?? null)
    const excess = this.store.countPendingLeaderNotices(taskId) - MAX_PENDING_LEADER_NOTICES
    if (excess > 0) {
      // delivered_at = -1: descartado pelo teto, nunca colado no terminal.
      for (const dropped of this.store.listPendingLeaderNotices(taskId, excess)) {
        this.store.markLeaderNoticeDelivered(dropped.id, -1)
      }
    }
    return notice
  }

  listPendingLeaderNotices(taskId: TaskId): LeaderNotice[] {
    return this.store.listPendingLeaderNotices(taskId)
  }

  markLeaderNoticeDelivered(id: number): void {
    this.write(() => this.store.markLeaderNoticeDelivered(id, this.clock.now()))
  }

  listTasksWithPendingLeaderNotices(): TaskId[] {
    return this.store.listTasksWithPendingLeaderNotices()
  }

  // -------------------------------------------------------------------------
  // Recuperacao no boot
  // -------------------------------------------------------------------------

  /**
   * Chamado uma vez na partida, depois que o TeamCoordinator tentou retomar o que
   * podia. Toda sessao aberta fora de `survivingSessionIds` nao voltou:
   *   - a sessao e encerrada com 'lost_on_restart' (o providerSessionId fica gravado: o
   *     membro reaberto pelo Lider retoma a conversa com session/load);
   *   - turno aberto dela e fechado com erro 'app_restarted'. Se o membro ja tinha chamado
   *     entregar com pronto ou bloqueado, a entrega vale;
   *   - toda subtarefa nao final cuja sessao nao voltou (ou que nem chegou a ter sessao)
   *     fica parada: input_required com RESTART_PAUSE_MESSAGE ("parada: o app reiniciou").
   *     Nao vira cancelada nem bloqueada: o Lider decide (subtarefa_responder reabre o
   *     membro; subtarefa_cancelar encerra).
   * Com `composeLostNotice`, cada subtarefa parada deixa UM aviso na fila duravel
   * (leader_notices), na mesma transacao. O fim de turno 'app_restarted' de subtarefa parada
   * nao gera outro aviso no TeamTurnRelay. Subtarefa que ja estava parada por um reinicio
   * anterior nao gera aviso de novo.
   * Lideres nao viram erro: voltam em leadersToResume para o --resume.
   * Uma transacao so: ou recupera tudo, ou nada muda.
   */
  recoverAfterRestart(
    input: {
      survivingSessionIds?: ReadonlySet<SessionId>
      composeLostNotice?: (subtask: Subtask) => string
    } = {},
  ): RecoveryReport {
    const survivors = input.survivingSessionIds ?? new Set<SessionId>()
    return this.write(() => {
      const report: RecoveryReport = {
        lostSessions: [],
        pausedSubtasks: [],
        deliveredSubtasks: [],
        leadersToResume: [],
      }
      const now = this.clock.now()
      for (const session of this.store.listOpenSessions()) {
        if (survivors.has(session.id)) continue
        if (session.activeTurnId !== null && session.subtaskId !== null) {
          const finalText = assembleFinalText(
            this.store.listTurnActivity(session.activeTurnId).map((e) => e.payload),
          )
          const outcome = this.applyFinishTurn(
            {
              turnId: session.activeTurnId,
              sessionId: session.id,
              outcome: {
                kind: 'error',
                error: { code: 'app_restarted', message: 'o app reiniciou no meio do turno' },
              },
              finalText,
              deliveries: [],
              startedAt: now,
              endedAt: now,
            },
            true,
          )
          if (outcome.transitioned && isFinalSubtaskState(outcome.subtask.state)) {
            report.deliveredSubtasks.push(outcome.subtask)
          }
        }
        const ended = this.endSession(session.id, { reason: 'lost_on_restart', exitCode: null })
        report.lostSessions.push(ended)
      }

      // Inclui as que o laco acima acabou de parar: o aviso sai aqui, um por subtarefa.
      const pausedNow = new Set(
        report.lostSessions.map((s) => s.subtaskId).filter((id): id is SubtaskId => !!id),
      )
      for (const subtask of this.store.listUnfinishedSubtasks()) {
        if (subtask.sessionId !== null && survivors.has(subtask.sessionId)) continue
        // Parada por um reinicio anterior e ainda sem decisao do Lider: o aviso ja saiu.
        if (isPausedByRestart(subtask) && !pausedNow.has(subtask.id)) continue
        const paused = this.pauseAfterRestart(subtask)
        report.pausedSubtasks.push(paused)
        if (input.composeLostNotice) {
          this.insertLeaderNotice(paused.taskId, input.composeLostNotice(paused), paused.id)
        }
      }

      const lostLeaderTasks = new Set(
        report.lostSessions.filter((s) => s.kind === 'leader-pty').map((s) => s.taskId),
      )
      for (const taskId of lostLeaderTasks) {
        const task = this.store.getTask(taskId)
        if (!task || task.status !== 'open') continue
        if (this.getLiveLeaderSession(taskId)) continue
        const latest = this.getLatestLeaderSession(taskId)
        if (latest && latest.providerSessionId) report.leadersToResume.push(latest)
      }
      return report
    })
  }

  /** submitted/working -> input_required, ou so a mensagem se ja estava em duvida. */
  private pauseAfterRestart(subtask: Subtask): Subtask {
    if (isPausedByRestart(subtask)) return subtask
    if (subtask.state !== 'input_required') {
      return this.applyTransition(subtask, 'input_required', {
        statusMessage: RESTART_PAUSE_MESSAGE,
      })
    }
    const next: Subtask = {
      ...subtask,
      statusMessage: RESTART_PAUSE_MESSAGE,
      updatedAt: this.clock.now(),
    }
    this.store.updateSubtask(next)
    this.emit({ type: 'subtask.upserted', subtask: next })
    return next
  }
}

export function createTaskService(deps: TaskServiceDeps): SqliteTaskService {
  return new SqliteTaskService(deps)
}
