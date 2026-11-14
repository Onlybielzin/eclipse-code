/**
 * Interfaces que os modulos do main implementam em paralelo.
 *
 * Dono de cada porta (pasta em src/main):
 *   TaskStore, TaskService                  -> tasks/
 *   TeamCoordinator                         -> app/ (teamCoordinator.ts; liga todos os modulos)
 *   PtyHost                                 -> terminal/
 *   LeaderLauncher, LeaderRelay             -> leader/
 *   MemberRuntime                           -> acp/
 *   WorktreeService                         -> worktree/
 *   McpBridgeServer, McpBridgeClient        -> mcp/
 *   ligacao de tudo (composition root)      -> app/
 *
 * Regras que valem para toda implementacao:
 *   - So o TaskService escreve tarefas, subtarefas, entregas, sessoes e turnos.
 *     Os outros modulos pedem por operacoes; nunca falam com o TaskStore.
 *   - Toda escrita vai ao SQLite (dentro de uma transacao) ANTES do evento sair.
 *   - Erros esperados saem como DomainError (domain.ts), nunca string solta.
 *   - Nenhuma porta abre janela. Nada aqui depende de Electron.
 */
import type {
  ActivityEvent,
  ActivityEventDraft,
  Artifact,
  Delivery,
  DomainEvent,
  DomainEventEnvelope,
  EpochMs,
  Message,
  MessageAuthor,
  Part,
  Project,
  ProjectId,
  Provider,
  QuestionAnswer,
  QuestionId,
  QuestionItem,
  Role,
  RoleId,
  Session,
  SessionEndReason,
  SessionId,
  SessionKind,
  Subtask,
  SubtaskFailureCode,
  SubtaskId,
  SubtaskState,
  Task,
  TaskId,
  TaskKind,
  TaskWorkflowActor,
  TaskWorkflowStatus,
  Turn,
  TurnId,
  TurnResult,
  UserQuestion,
} from './domain'
import type { ActivityPage, ProjectSummary, SubtaskDetail } from './ipc'
import type { McpCaller, McpCallerRole, McpHelloResult, McpToolName, McpToolResult } from './mcp'

export type Unsubscribe = () => void

// ---------------------------------------------------------------------------
// Utilidades injetaveis (deterministicas nos testes)
// ---------------------------------------------------------------------------

export interface Clock {
  now(): EpochMs
}

export interface IdFactory {
  /** Id unico, curto e seguro para URL/arquivo (ex: uuid v7 ou ulid). */
  newId(): string
}

// ---------------------------------------------------------------------------
// tasks/: persistencia
// ---------------------------------------------------------------------------

/**
 * Acesso ao SQLite (better-sqlite3, sincrono). Sem regra de negocio: so le e grava.
 * Quem garante invariantes e o TaskService. Toda chamada roda no processo main.
 */
export interface TaskStore {
  /** Roda fn numa transacao. Aninhar reaproveita a transacao de fora. */
  transaction<T>(fn: () => T): T
  /**
   * Grava o evento com a proxima revisao global (tabela de eventos/outbox) e
   * devolve o envelope. Deve ser chamado dentro da mesma transacao da escrita.
   */
  appendEvent(event: DomainEvent, at: EpochMs): DomainEventEnvelope

  listProjects(): Project[]
  getProject(id: ProjectId): Project | null
  getProjectByRoot(rootPath: string): Project | null
  insertProject(project: Project): void
  updateProject(project: Project): void
  deleteProject(id: ProjectId): void
  /** Configuracao do app (chave -> JSON). Ausente = null. */
  getSetting(key: string): string | null
  setSetting(key: string, valueJson: string): void

  listRoles(projectId: ProjectId): Role[]
  getRole(id: RoleId): Role | null
  insertRole(role: Role): void
  updateRole(role: Role): void
  deleteRole(id: RoleId): void

  listTasks(projectId: ProjectId, options: { includeArchived: boolean }): Task[]
  getTask(id: TaskId): Task | null
  insertTask(task: Task): void
  updateTask(task: Task): void

  listSubtasks(taskId: TaskId): Subtask[]
  getSubtask(id: SubtaskId): Subtask | null
  insertSubtask(subtask: Subtask): void
  updateSubtask(subtask: Subtask): void

  listMessages(subtaskId: SubtaskId): Message[]
  insertMessage(message: Message): void

  listArtifacts(subtaskId: SubtaskId): Artifact[]
  listArtifactsForTurn(turnId: TurnId): Artifact[]
  insertArtifact(artifact: Artifact): void

  getSession(id: SessionId): Session | null
  listSessions(taskId: TaskId): Session[]
  /** Sessoes com status diferente de 'exited', de todas as tarefas. */
  listOpenSessions(): Session[]
  insertSession(session: Session): void
  updateSession(session: Session): void

  getTurn(id: TurnId): Turn | null
  listTurns(subtaskId: SubtaskId): Turn[]
  insertTurn(turn: Turn): void
  updateTurn(turn: Turn): void

  /** Atribui seq crescente por sessao e grava. Devolve os eventos gravados. */
  appendActivity(drafts: ActivityEventDraft[]): ActivityEvent[]
  listActivity(subtaskId: SubtaskId, afterSeq: number | null, limit: number): ActivityPage
  listTurnActivity(turnId: TurnId): ActivityEvent[]

  listOpenQuestions(projectId: ProjectId): UserQuestion[]
  /** Perguntas 'open' de uma tarefa, da mais antiga a mais nova. */
  listOpenTaskQuestions(taskId: TaskId): UserQuestion[]
  getQuestion(id: QuestionId): UserQuestion | null
  insertQuestion(question: UserQuestion): void
  updateQuestion(question: UserQuestion): void

  close(): void
}

// ---------------------------------------------------------------------------
// tasks/: servico de dominio (unico escritor)
// ---------------------------------------------------------------------------

export interface SaveRoleInput {
  projectId: ProjectId
  roleId?: RoleId | undefined
  name: string
  description: string
  provider: Provider
  model: string | null
  promptTemplate: string
  isLead: boolean
}

/** Tarefa ja com worktree resolvida (o TeamCoordinator cria a worktree antes). */
export interface CreateTaskRecord {
  projectId: ProjectId
  title: string
  kind: TaskKind
  worktreePath: string | null
  branch: string | null
  baseBranch: string | null
  leadRoleId: RoleId | null
  soloProvider: Provider | null
}

export interface CreateSubtaskRecord {
  taskId: TaskId
  roleId: RoleId
  title: string
  instructions: string
  /** Precisam ser subtarefas da mesma tarefa. */
  referenceTaskIds: SubtaskId[]
}

export interface TransitionSubtaskPatch {
  statusMessage?: string | null
  failureCode?: SubtaskFailureCode | null
}

export interface OpenSessionRecord {
  taskId: TaskId
  subtaskId: SubtaskId | null
  roleId: RoleId | null
  kind: SessionKind
  provider: Provider
  model: string | null
  cwd: string
  providerSessionId: string | null
}

export interface StartTurnRecord {
  sessionId: SessionId
  subtaskId: SubtaskId
  /** Quem mandou o prompt: 'leader' no criar/responder, 'user' na resposta de "Precisa de voce". */
  author: Extract<MessageAuthor, 'leader' | 'user'>
  parts: Part[]
}

/** Resultado de aplicar um fim de turno. */
export interface FinishTurnOutcome {
  turn: Turn
  subtask: Subtask
  /** Entrega "sem formato" gravada agora, se houve. */
  fallbackArtifact: Artifact | null
  /** false quando a subtarefa ja era final (ex: cancelada antes do turno acabar). */
  transitioned: boolean
}

/**
 * Unico escritor do estado duravel. Metodos sincronos: cada um e uma transacao
 * SQLite e, so depois do commit, emite os eventos aos assinantes.
 *
 * Invariantes que cada implementacao garante (e testa):
 *   - transitionSubtask recusa estado final -> qualquer ('final_state') e
 *     transicoes fora de SUBTASK_TRANSITIONS ('invalid_transition').
 *   - openSession recusa um segundo 'leader-pty' nao encerrado na mesma tarefa ('conflict').
 *   - recordDelivery so aceita sessao 'member-acp' com turno ativo.
 *   - Tarefa arquivada nao aceita subtarefa nova nem sessao nova.
 */
export interface TaskService {
  subscribe(listener: (envelope: DomainEventEnvelope) => void): Unsubscribe

  listProjects(): Project[]
  getProject(id: ProjectId): Project
  addProject(input: { rootPath: string; name?: string | undefined }): Project
  removeProject(id: ProjectId): void
  /**
   * Contadores de cada projeto, na ordem de listProjects: tarefas nao arquivadas e
   * perguntas abertas (mesma regra de listOpenQuestions).
   */
  summarizeProjects(): ProjectSummary[]
  /** Limites de agentes configurados na tela; null = sem limite. */
  getAgentLimitSettings(): AgentLimitSettings
  getAgentLimits(): AgentLimits
  saveAgentLimitSettings(settings: AgentLimitSettings): AgentLimitSettings

  listRoles(projectId: ProjectId): Role[]
  getRole(id: RoleId): Role
  /** Busca por nome sem diferenciar maiusculas/acentos. null se nao existe. */
  findRoleByName(projectId: ProjectId, name: string): Role | null
  saveRole(input: SaveRoleInput): Role
  deleteRole(id: RoleId): void

  listTasks(projectId: ProjectId, options: { includeArchived: boolean }): Task[]
  getTask(id: TaskId): Task
  createTask(record: CreateTaskRecord): Task
  /** Arquiva e marca 'lancado' (W3). */
  markTaskArchived(id: TaskId): Task
  /**
   * Muda o status de trabalho a pedido de alguem. 'agent' nunca escreve pronto_lancar
   * nem lancado ('forbidden') e nao tira de lancado. 'user' escolhe qualquer um:
   * lancado arquiva (mesma regra do markTaskArchived) e sair de lancado desarquiva.
   */
  setTaskWorkflowStatus(id: TaskId, to: TaskWorkflowStatus, actor: TaskWorkflowActor): Task
  /** Lider ou membro comecou a trabalhar: a_fazer | em_revisao -> em_andamento. */
  markTaskWorkStarted(id: TaskId): Task
  /**
   * Lider declarou a tarefa terminada (tarefa_concluir): -> em_revisao. Recusa com
   * pergunta aberta ('conflict') ou tarefa ja lancada ('invalid_transition').
   */
  concludeTask(id: TaskId): Task

  listSubtasks(taskId: TaskId): Subtask[]
  getSubtask(id: SubtaskId): Subtask
  getSubtaskDetail(id: SubtaskId): SubtaskDetail
  createSubtask(record: CreateSubtaskRecord): Subtask
  transitionSubtask(id: SubtaskId, to: SubtaskState, patch?: TransitionSubtaskPatch): Subtask
  attachSubtaskSession(id: SubtaskId, sessionId: SessionId): Subtask

  addMessage(input: Omit<Message, 'id' | 'createdAt'>): Message

  getSession(id: SessionId): Session
  listSessions(taskId: TaskId): Session[]
  listOpenSessions(): Session[]
  /** Leader-pty vivo (status != 'exited') da tarefa, ou null. */
  getLiveLeaderSession(taskId: TaskId): Session | null
  openSession(record: OpenSessionRecord): Session
  updateSession(
    id: SessionId,
    patch: Partial<Pick<Session, 'providerSessionId' | 'pid' | 'status'>>,
  ): Session
  endSession(id: SessionId, end: { reason: SessionEndReason; exitCode: number | null }): Session

  /** Abre um turno: grava Turn, Message do prompt, atividade 'prompt' e session.activeTurnId. */
  startTurn(record: StartTurnRecord): Turn
  /** Grava a entrega do 'entregar' no turno ativo da sessao do membro. */
  recordDelivery(sessionId: SessionId, delivery: Delivery, parts?: Part[]): Artifact
  /** Entregas gravadas num turno (usado pelo MemberRuntime para montar o TurnResult). */
  listTurnDeliveries(turnId: TurnId): Artifact[]
  /**
   * Fecha o turno com resolveTurn (subtaskRules.ts): grava Turn, entrega "sem formato"
   * se preciso, Message do membro, transicao da subtarefa e limpa activeTurnId.
   * Idempotente por turnId.
   */
  finishTurn(result: TurnResult): FinishTurnOutcome

  appendActivity(drafts: ActivityEventDraft[]): ActivityEvent[]
  listActivity(subtaskId: SubtaskId, afterSeq: number | null, limit: number): ActivityPage

  listOpenQuestions(projectId: ProjectId): UserQuestion[]
  createQuestion(input: {
    taskId: TaskId
    subtaskId: SubtaskId | null
    items: QuestionItem[]
  }): UserQuestion
  answerQuestion(id: QuestionId, answers: QuestionAnswer[]): UserQuestion
  dismissQuestion(id: QuestionId): UserQuestion
  /**
   * O usuario apertou Enter no terminal do Lider da tarefa: toda pergunta 'open' dela
   * vira 'answered_in_terminal'. Devolve as que fechou (vazio se nao havia nenhuma).
   */
  closeQuestionsAnsweredInTerminal(taskId: TaskId): UserQuestion[]
}

// ---------------------------------------------------------------------------
// tasks/: avisos ao Lider (fila duravel)
// ---------------------------------------------------------------------------

/** Linha [eclipse] que espera ser colada no terminal do Lider da tarefa. */
export interface LeaderNotice {
  id: number
  taskId: TaskId
  text: string
  createdAt: EpochMs
  /** Subtarefa a que o aviso se refere; null para aviso sem subtarefa (resposta do usuario). */
  subtaskId: SubtaskId | null
}

/**
 * Fila duravel de avisos ao Lider (SQLite). O aviso so sai da fila quando o relay
 * confirma a entrega; sobrevive a Lider ocupado, Lider morto e reinicio do app.
 */
export interface LeaderNoticeStore {
  enqueueLeaderNotice(taskId: TaskId, text: string, subtaskId?: SubtaskId): LeaderNotice
  /**
   * O Lider ja viu estas subtarefas (subtarefas_esperar / subtarefas_ver): descarta os avisos
   * pendentes delas. Marca delivered_at = -2 (-1 e o descarte pelo teto); nunca sao coladas.
   */
  discardPendingLeaderNoticesForSubtasks(taskId: TaskId, subtaskIds: readonly SubtaskId[]): void
  /** Pendentes da tarefa, do mais antigo ao mais novo. */
  listPendingLeaderNotices(taskId: TaskId): LeaderNotice[]
  markLeaderNoticeDelivered(id: number): void
  /** Tarefas abertas com aviso pendente. */
  listTasksWithPendingLeaderNotices(): TaskId[]
}

// ---------------------------------------------------------------------------
// tasks/: orquestracao do time
// ---------------------------------------------------------------------------

export interface AgentLimits {
  /** Membros vivos por tarefa. So conta sessoes vivas no runtime/pty host. */
  maxLiveMembersPerTask: number
  /** Agentes vivos no app inteiro (Lideres + membros). */
  maxLiveAgents: number
}

/** AgentLimits na fronteira (IPC e banco): null = sem limite (Infinity nao passa por JSON). */
export interface AgentLimitSettings {
  maxLiveMembersPerTask: number | null
  maxLiveAgents: number | null
}

/**
 * Liga TaskService, MemberRuntime, LeaderLauncher, LeaderRelay, WorktreeService e
 * McpBridge. Implementa as ferramentas MCP (via McpToolHandler) e os comandos
 * da tela que tem efeito colateral. Nao grava nada direto: tudo passa pelo TaskService.
 *
 * Fluxo de uma subtarefa:
 *   createSubtask -> TaskService.createSubtask (submitted) -> MemberRuntime.startSession
 *   -> transition working -> startTurn -> MemberRuntime.prompt -> finishTurn
 *   -> LeaderRelay.deliver (aviso com id e resumo) -> se completed/failed/canceled: close.
 */
export interface TeamCoordinator extends McpToolHandler {
  createTask(input: {
    projectId: ProjectId
    title: string
    kind: TaskKind
    leadRoleId?: RoleId | undefined
    soloProvider?: Provider | undefined
    baseBranch?: string | undefined
    useWorktree: boolean
  }): Promise<Task>
  archiveTask(taskId: TaskId, options: { removeWorktree: boolean }): Promise<Task>
  /** Lider vivo da tarefa: devolve o atual, retoma com resume ou abre novo. */
  ensureLeader(taskId: TaskId): Promise<Session>
  answerUserQuestion(questionId: QuestionId, answers: QuestionAnswer[]): Promise<UserQuestion>
  /**
   * Na partida: retoma Lideres com --resume/resume; subtarefas cujo membro nao volta ficam
   * paradas em input_required ("parada: o app reiniciou") e o Lider recebe um aviso.
   * Sessoes encerradas nao contam no limite.
   */
  recoverOnStartup(): Promise<void>
  /** Encerra membros e Lideres de forma ordenada ao fechar o app. */
  shutdown(): Promise<void>
}

// ---------------------------------------------------------------------------
// terminal/: hospedeiro de pty
// ---------------------------------------------------------------------------

export interface PtySpawnOptions {
  command: string
  args: string[]
  cwd: string
  /** Ambiente completo do processo (o chamador ja mesclou process.env). */
  env: Record<string, string>
  cols: number
  rows: number
  /** Rotulo para logs e diagnostico. */
  label?: string
}

export interface PtyProcessInfo {
  ptyId: string
  pid: number
}

export interface PtyExit {
  exitCode: number | null
  signal: string | null
}

/**
 * Hospedeiro dos terminais (copiado de platform/process/ptyHost do app antigo, sem
 * worker remoto). Guarda um ring buffer de saida por pty para repintar a tela.
 * liveCount conta so processos realmente vivos: e a fonte do limite de agentes.
 */
export interface PtyHost {
  spawn(options: PtySpawnOptions): Promise<PtyProcessInfo>
  write(ptyId: string, data: string): void
  resize(ptyId: string, cols: number, rows: number): void
  kill(ptyId: string, signal?: 'SIGTERM' | 'SIGKILL' | 'SIGHUP' | 'SIGINT'): void
  onData(listener: (ptyId: string, data: string) => void): Unsubscribe
  onExit(listener: (ptyId: string, exit: PtyExit) => void): Unsubscribe
  /** Saida recente do pty (limite fixo de bytes). '' se desconhecido. */
  scrollback(ptyId: string): string
  size(ptyId: string): { cols: number; rows: number } | null
  isAlive(ptyId: string): boolean
  liveCount(): number
  /** Mata tudo e libera recursos. */
  dispose(): Promise<void>
}

// ---------------------------------------------------------------------------
// leader/: abrir o Lider e falar com ele
// ---------------------------------------------------------------------------

/** Como abrir o servidor MCP do app como processo stdio dentro de um agente. */
export interface McpServerLaunch {
  name: string
  command: string
  args: string[]
  env: Record<string, string>
}

export interface LeaderLaunchRequest {
  sessionId: SessionId
  taskId: TaskId
  provider: Provider
  model: string | null
  cwd: string
  /** Prompt do papel ja renderizado. Ignorado ao retomar. */
  initialPrompt: string | null
  /** Id do provedor para `claude --resume <id>` / `codex resume <id>`. null abre nova. */
  resumeProviderSessionId: string | null
  mcpServer: McpServerLaunch
  /** Variaveis extras (o launcher mescla com process.env e ENV.marker). */
  env: Record<string, string>
  cols: number
  rows: number
}

export interface LeaderCommand {
  command: string
  args: string[]
  env: Record<string, string>
}

export interface LeaderLaunchResult extends PtyProcessInfo {
  resumed: boolean
  command: LeaderCommand
}

export interface LeaderLauncher {
  /** Monta o comando sem efeito colateral (testavel). */
  buildCommand(request: LeaderLaunchRequest): LeaderCommand
  /** Abre no PtyHost. Rejeita com DomainError('unavailable') se o CLI nao existe. */
  launch(request: LeaderLaunchRequest): Promise<LeaderLaunchResult>
  /**
   * Descobre o id de sessao do provedor criado depois de `startedAt` em `cwd`
   * (AgentSessionLocator do app antigo). null se nao achar dentro do prazo.
   */
  locateProviderSessionId(input: {
    provider: Provider
    cwd: string
    startedAt: EpochMs
    timeoutMs: number
  }): Promise<string | null>
}

/**
 * Entrega texto ao terminal do Lider (substitui o TeamTurnRelay). Espera o Lider
 * ficar ocioso, cola o texto e envia. Tenta de novo enquanto ocupado.
 */
export interface LeaderRelay {
  deliver(sessionId: SessionId, text: string): Promise<{ delivered: boolean; attempts: number }>
}

// ---------------------------------------------------------------------------
// acp/: membros pelo ACP
// ---------------------------------------------------------------------------

export interface MemberSessionStart {
  sessionId: SessionId
  taskId: TaskId
  subtaskId: SubtaskId
  provider: Provider
  model: string | null
  cwd: string
  /** Prompt do papel renderizado; vira prompt de sistema/instrucoes da sessao. */
  systemPrompt: string
  mcpServer: McpServerLaunch
  env: Record<string, string>
  /** Retoma com session/load quando nao e null. */
  resumeProviderSessionId: string | null
}

export interface MemberSessionHandle {
  sessionId: SessionId
  providerSessionId: string
  pid: number | null
}

export interface MemberTurnTimeouts {
  /** Tempo maximo de um turno. Estourou: cancela e devolve erro 'turn_timeout'. */
  turnTimeoutMs: number
  /** Sem evento ACP por este tempo: cancela e devolve erro 'silent_timeout'. */
  silenceTimeoutMs: number
}

/**
 * Runtime ACP dos membros (claude-agent-acp e codex-acp sobre @agentclientprotocol/sdk).
 *
 * Contrato do prompt:
 *   - Um turno por sessao de cada vez; segundo prompt simultaneo rejeita com 'conflict'.
 *   - A promessa SEMPRE resolve com TurnResult: stopReason do session/prompt, ou erro
 *     se o processo morrer, o vigia de silencio disparar ou o tempo maximo estourar.
 *   - finalText e montado com assembleFinalText sobre a atividade do turno.
 *   - deliveries vem de MemberRuntimeDeps.deliveries.forTurn(turnId) no fim do turno.
 *   - Cada evento ACP vira ActivityEventDraft em onActivity antes do turno resolver.
 */
export interface MemberRuntime {
  startSession(request: MemberSessionStart): Promise<MemberSessionHandle>
  prompt(sessionId: SessionId, input: { turnId: TurnId; text: string }): Promise<TurnResult>
  /** session/cancel. O turno em curso resolve com stopReason 'cancelled'. */
  cancel(sessionId: SessionId): Promise<void>
  /** Fecha a sessao e mata o processo. Turno em curso resolve com erro 'session_closed'. */
  close(sessionId: SessionId): Promise<void>
  isAlive(sessionId: SessionId): boolean
  liveCount(): number
  onActivity(listener: (draft: ActivityEventDraft) => void): Unsubscribe
  /** Processo do membro saiu (dentro ou fora de turno). */
  onSessionExit(listener: (sessionId: SessionId, exit: PtyExit) => void): Unsubscribe
  dispose(): Promise<void>
}

export interface MemberRuntimeDeps {
  clock: Clock
  timeouts: MemberTurnTimeouts
  deliveries: { forTurn(turnId: TurnId): Artifact[] }
}

// ---------------------------------------------------------------------------
// worktree/: uma worktree por tarefa
// ---------------------------------------------------------------------------

export interface WorktreeInfo {
  path: string
  branch: string | null
  head: string | null
}

export interface CreateWorktreeRequest {
  projectRoot: string
  /** Pasta onde as worktrees do projeto ficam (AppPaths.worktrees/<projeto>). */
  worktreesRoot: string
  /** Base para o nome da pasta e da branch (slug do titulo da tarefa). */
  name: string
  /** Branch nova. Se omitida, derivada de name com prefixo 'feat/'. */
  branch?: string | undefined
  /** De onde sair. Se omitida, a branch padrao do repositorio. */
  baseBranch?: string | undefined
}

export interface WorktreeService {
  isGitRepository(path: string): Promise<boolean>
  getDefaultBranch(projectRoot: string): Promise<string | null>
  /**
   * Cria worktree + branch. Nome em conflito ganha sufixo. Respeita symlinks
   * (correcao do app antigo: compara caminhos reais).
   */
  create(request: CreateWorktreeRequest): Promise<WorktreeInfo & { baseBranch: string }>
  remove(request: {
    projectRoot: string
    worktreePath: string
    branch: string | null
    deleteBranch: boolean
    force: boolean
  }): Promise<void>
  list(projectRoot: string): Promise<WorktreeInfo[]>
}

// ---------------------------------------------------------------------------
// mcp/: ponte entre o servidor MCP (processo filho) e o main
// ---------------------------------------------------------------------------

export interface McpTokenGrant {
  role: McpCallerRole
  sessionId: SessionId
  taskId: TaskId
  subtaskId: SubtaskId | null
}

/** Executa ferramentas MCP com a identidade resolvida pelo main. */
export interface McpToolHandler {
  /**
   * `args` chega cru; o handler valida com mcpToolInputSchemas e confere
   * MCP_TOOL_ROLES contra caller.role ('forbidden' se nao puder).
   */
  callTool(caller: McpCaller, name: McpToolName, args: unknown): Promise<McpToolResult>
}

/**
 * Lado main da ponte: socket unix em AppPaths.runtime (permissao 0600), protocolo
 * NDJSON de mcp.ts. Tokens sao aleatorios (>= 32 bytes), so em memoria, um por sessao,
 * e revogados quando a sessao termina. Reiniciar o app invalida todos.
 */
export interface McpBridgeServer {
  start(handler: McpToolHandler): Promise<{ socketPath: string }>
  stop(): Promise<void>
  issueToken(grant: McpTokenGrant): string
  revokeSession(sessionId: SessionId): void
  resolve(token: string): McpCaller | null
  /** Comando para abrir o servidor MCP stdio desta sessao (vai no LeaderLaunchRequest/MemberSessionStart). */
  launchSpec(token: string): McpServerLaunch
}

/** Lado do servidor MCP stdio: fala com o main pelo socket. */
export interface McpBridgeClient {
  hello(): Promise<McpHelloResult>
  callTool(name: McpToolName, args: unknown): Promise<McpToolResult>
  close(): void
}
