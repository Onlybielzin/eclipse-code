/**
 * Modelo de dados do Eclipse Code novo.
 *
 * Segue o vocabulario do A2A v1.0 (Task, TaskState, Message, Part, Artifact,
 * referenceTaskIds), so por dentro do app: nao ha servidor A2A nem rede entre agentes.
 *
 * Mapa A2A -> app:
 *   contextId           -> Task (a tarefa do usuario, com worktree e Lider)
 *   Task + TaskState    -> Subtask (o trabalho de um membro)
 *   Message + Part      -> Message (historico da subtarefa)
 *   Artifact + Part     -> Artifact (a entrega do membro)
 *   AgentCard + skills  -> Role (papel do time)
 *
 * Invariantes (garantidas pelo TaskService no main, unico dono da escrita):
 *   I1. Estado final (completed | failed | canceled) nunca muda. Correcao vira
 *       subtarefa nova com referenceTaskIds apontando para a anterior.
 *   I2. Cada sessao pertence a uma tarefa. Cada tarefa tem no maximo um Lider vivo.
 *   I3. Toda escrita vai ao SQLite antes de qualquer evento para a tela.
 *
 * Tipos aqui sao dados puros e serializaveis (IPC, SQLite, MCP). Nada de classes,
 * exceto DomainError, que so atravessa fronteiras como DomainErrorPayload.
 */

// ---------------------------------------------------------------------------
// Primitivos
// ---------------------------------------------------------------------------

/** Milissegundos desde a epoca Unix (Date.now()). Todo horario do dominio usa isto. */
export type EpochMs = number

export type ProjectId = string
export type RoleId = string
export type TaskId = string
export type SubtaskId = string
export type MessageId = string
export type ArtifactId = string
export type SessionId = string
export type TurnId = string
export type QuestionId = string

/** Objeto JSON serializavel. */
export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }

/** Agentes suportados. So Claude e Codex. */
export const PROVIDERS = ['claude', 'codex'] as const
export type Provider = (typeof PROVIDERS)[number]

export const PROVIDER_LABELS: Record<Provider, string> = {
  claude: 'Claude',
  codex: 'Codex',
}

// ---------------------------------------------------------------------------
// Project e Role
// ---------------------------------------------------------------------------

export interface Project {
  id: ProjectId
  name: string
  /** Pasta absoluta do repositorio git. Unica entre projetos. */
  rootPath: string
  createdAt: EpochMs
  updatedAt: EpochMs
}

/** Papel do time (AgentCard + skills no A2A). */
export interface Role {
  id: RoleId
  projectId: ProjectId
  /** Nome curto exibido na lista ("Revisor", "Frontend"). Unico por projeto. */
  name: string
  description: string
  provider: Provider
  /** Id do modelo passado ao CLI/ACP ("opus", "haiku", "gpt-5.5"). null = padrao do provedor. */
  model: string | null
  /**
   * Prompt do papel. Para membros vira o prompt de sistema da sessao ACP; para o
   * Lider vira o prompt inicial do terminal. Pode conter {{tarefa}}, {{subtarefa}},
   * {{instrucoes}}, {{worktree}}, {{branch}} (ver PROMPT_TEMPLATE_VARIABLES).
   */
  promptTemplate: string
  /** true para o papel de Lider. No maximo um por projeto. */
  isLead: boolean
  createdAt: EpochMs
  updatedAt: EpochMs
}

export const PROMPT_TEMPLATE_VARIABLES = [
  'tarefa',
  'subtarefa',
  'instrucoes',
  'worktree',
  'branch',
] as const
export type PromptTemplateVariable = (typeof PROMPT_TEMPLATE_VARIABLES)[number]

// ---------------------------------------------------------------------------
// Task (contextId no A2A)
// ---------------------------------------------------------------------------

/** 'team': Lider + subtarefas. 'solo': secao "Avulsos", tarefa de um item, so o terminal. */
export const TASK_KINDS = ['team', 'solo'] as const
export type TaskKind = (typeof TASK_KINDS)[number]

export const TASK_STATUSES = ['open', 'archived'] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]

/**
 * Status de trabalho da tarefa (o que a lista mostra e agrupa), na ordem da tela.
 * Dono: TaskService. Regras automaticas em taskWorkflow.ts.
 *
 *   a_fazer -> em_andamento -> (pergunta <-> em_andamento) -> em_revisao
 *     -> pronto_lancar -> lancado
 *
 * Invariantes:
 *   W1. pronto_lancar e lancado so o usuario escolhe (USER_ONLY_TASK_WORKFLOW_STATUSES).
 *   W2. lancado e final para a automacao: nada automatico tira a tarefa de la.
 *   W3. status 'archived' <=> workflowStatus 'lancado' (lancar arquiva; sair de lancado desarquiva).
 */
export const TASK_WORKFLOW_STATUSES = [
  'a_fazer',
  'em_andamento',
  'pergunta',
  'em_revisao',
  'pronto_lancar',
  'lancado',
] as const
export type TaskWorkflowStatus = (typeof TASK_WORKFLOW_STATUSES)[number]

export const TASK_WORKFLOW_STATUS_LABELS: Record<TaskWorkflowStatus, string> = {
  a_fazer: 'A fazer',
  em_andamento: 'Em andamento',
  pergunta: 'Pergunta para você',
  em_revisao: 'Em revisão',
  pronto_lancar: 'Pronto pra lançar',
  lancado: 'Lançado',
}

/** Status que agente e automacao nunca escrevem (W1). */
export const USER_ONLY_TASK_WORKFLOW_STATUSES = ['pronto_lancar', 'lancado'] as const

/** Quem pede a mudanca de status: o usuario (tela) ou um agente (MCP). */
export type TaskWorkflowActor = 'user' | 'agent'

export function isUserOnlyTaskWorkflowStatus(status: TaskWorkflowStatus): boolean {
  return (USER_ONLY_TASK_WORKFLOW_STATUSES as readonly TaskWorkflowStatus[]).includes(status)
}

export interface Task {
  id: TaskId
  projectId: ProjectId
  /** contextId do A2A. Estavel; agrupa subtarefas, mensagens e entregas da tarefa. */
  contextId: string
  title: string
  kind: TaskKind
  /**
   * Pasta onde o Lider e os membros rodam. null = sem worktree propria, roda na
   * raiz do projeto (permitido so para kind 'solo').
   */
  worktreePath: string | null
  /** Branch da worktree. null quando worktreePath e null. */
  branch: string | null
  /** Branch de onde a worktree saiu. null quando nao ha worktree. */
  baseBranch: string | null
  /** Papel usado para abrir o Lider (ou o agente avulso). */
  leadRoleId: RoleId | null
  /** Provedor do agente avulso quando leadRoleId e null (kind 'solo'). */
  soloProvider: Provider | null
  status: TaskStatus
  /** Status de trabalho mostrado na lista (ver TASK_WORKFLOW_STATUSES). */
  workflowStatus: TaskWorkflowStatus
  createdAt: EpochMs
  updatedAt: EpochMs
  archivedAt: EpochMs | null
}

// ---------------------------------------------------------------------------
// Subtask (Task + TaskState no A2A)
// ---------------------------------------------------------------------------

/**
 * Estados da subtarefa, mesmos nomes do TaskState do A2A.
 *
 *   submitted -> working -> (input_required <-> working) -> completed | failed | canceled
 *
 * completed, failed e canceled sao finais (I1).
 */
export const SUBTASK_STATES = [
  'submitted',
  'working',
  'input_required',
  'completed',
  'failed',
  'canceled',
] as const
export type SubtaskState = (typeof SUBTASK_STATES)[number]

/** Rotulos da tela, em portugues. */
export const SUBTASK_STATE_LABELS: Record<SubtaskState, string> = {
  submitted: 'na fila',
  working: 'trabalhando',
  input_required: 'dúvida',
  completed: 'pronto',
  failed: 'bloqueado',
  canceled: 'cancelada',
}

export const FINAL_SUBTASK_STATES = ['completed', 'failed', 'canceled'] as const
export type FinalSubtaskState = (typeof FINAL_SUBTASK_STATES)[number]

export function isFinalSubtaskState(state: SubtaskState): state is FinalSubtaskState {
  return (FINAL_SUBTASK_STATES as readonly SubtaskState[]).includes(state)
}

/** Transicoes permitidas. Tudo que nao esta aqui e recusado com 'invalid_transition'. */
export const SUBTASK_TRANSITIONS: Readonly<Record<SubtaskState, readonly SubtaskState[]>> = {
  // failed: o membro nem abriu (spawn_failed) ou a sessao foi perdida antes do turno.
  submitted: ['working', 'failed', 'canceled'],
  working: ['input_required', 'completed', 'failed', 'canceled'],
  // working: o Lider respondeu (novo session/prompt). failed: sessao perdida ao reiniciar.
  input_required: ['working', 'failed', 'canceled'],
  completed: [],
  failed: [],
  canceled: [],
}

export function canTransitionSubtask(from: SubtaskState, to: SubtaskState): boolean {
  return SUBTASK_TRANSITIONS[from].includes(to)
}

/**
 * Motivo estruturado de uma subtarefa 'failed' (bloqueado) ou de um turno com erro.
 * O texto para a tela fica em Subtask.statusMessage.
 */
export const SUBTASK_FAILURE_CODES = [
  /** O membro chamou entregar com estado bloqueado. */
  'member_blocked',
  /** O processo do membro morreu no meio do turno ("bloqueado: processo morreu"). */
  'process_exited',
  /** Vigia de silencio: sem saida por tempo demais ("bloqueado: sem resposta"). */
  'silent_timeout',
  /** Tempo maximo por turno estourou. */
  'turn_timeout',
  /** Sessao nao voltou depois de reiniciar o app ("bloqueado: sessao perdida"). */
  'session_lost',
  /** Nao foi possivel abrir o processo do membro. */
  'spawn_failed',
  /** stopReason 'refusal' sem entrega. */
  'refusal',
  /** stopReason 'max_tokens' ou 'max_turn_requests' sem entrega. */
  'limit_reached',
  /** Erro de protocolo ACP ou erro inesperado. */
  'error',
] as const
export type SubtaskFailureCode = (typeof SUBTASK_FAILURE_CODES)[number]

export interface Subtask {
  id: SubtaskId
  taskId: TaskId
  roleId: RoleId
  title: string
  /** Instrucoes do Lider no subtarefa_criar. Imutavel. */
  instructions: string
  state: SubtaskState
  /** Ultima mensagem de estado (A2A TaskStatus.message, resumida em texto). */
  statusMessage: string | null
  /** Preenchido quando state = 'failed'. */
  failureCode: SubtaskFailureCode | null
  /** Subtarefas de origem (A2A referenceTaskIds). Correcao aponta para a anterior. */
  referenceTaskIds: SubtaskId[]
  /** Sessao ACP do membro. null enquanto 'submitted' sem processo. */
  sessionId: SessionId | null
  createdAt: EpochMs
  updatedAt: EpochMs
  /** Quando entrou num estado final. null enquanto nao e final. */
  finishedAt: EpochMs | null
}

// ---------------------------------------------------------------------------
// Part, Message, Artifact
// ---------------------------------------------------------------------------

/** Part do A2A v1.0: texto, arquivo ou dados estruturados. */
export type Part =
  | { kind: 'text'; text: string; metadata?: JsonObject }
  | {
      kind: 'file'
      /** Caminho relativo a worktree, caminho absoluto ou URI file://. */
      uri: string
      name?: string
      mediaType?: string
      metadata?: JsonObject
    }
  | { kind: 'data'; data: JsonObject; metadata?: JsonObject }

/** Quem falou. 'leader' e 'user' falam com o membro; 'member' responde; 'system' e o app. */
export const MESSAGE_AUTHORS = ['leader', 'member', 'user', 'system'] as const
export type MessageAuthor = (typeof MESSAGE_AUTHORS)[number]

/** Historico da subtarefa (Message do A2A). */
export interface Message {
  id: MessageId
  taskId: TaskId
  subtaskId: SubtaskId
  author: MessageAuthor
  parts: Part[]
  /** Turno que a mensagem abriu (leader/user) ou fechou (member). null para 'system'. */
  turnId: TurnId | null
  createdAt: EpochMs
}

/** Estado que o membro informa ao entregar: pronto, duvida ou bloqueado. */
export const DELIVERY_STATES = ['completed', 'input_required', 'failed'] as const
export type DeliveryState = (typeof DELIVERY_STATES)[number]

export const DELIVERY_STATE_LABELS: Record<DeliveryState, string> = {
  completed: 'pronto',
  input_required: 'dúvida',
  failed: 'bloqueado',
}

export interface ChangedFile {
  /** Caminho relativo a worktree da tarefa. */
  path: string
  change: 'added' | 'modified' | 'deleted' | 'renamed'
  note?: string
}

export interface TestRun {
  /** Comando rodado, ex: "pnpm test src/x.test.ts". */
  command: string
  /** Resultado real, ex: "12 passed". */
  result: string
  passed: boolean | null
}

export const MAX_QUESTION_ITEMS = 4
export const MAX_QUESTION_OPTIONS = 6

export interface QuestionOption {
  id: string
  label: string
  description?: string
}

/** Um item de pergunta (o card de pergunta do app antigo). */
export interface QuestionItem {
  id: string
  prompt: string
  /** 0 opcoes = so texto livre. */
  options: QuestionOption[]
  multiSelect: boolean
  allowFreeText: boolean
}

export interface QuestionAnswer {
  itemId: string
  optionIds: string[]
  text: string | null
}

/**
 * O que o membro entrega. Vem da ferramenta MCP 'entregar' (format 'structured')
 * ou e montado pelo app a partir do texto do turno (format 'unformatted').
 */
export interface Delivery {
  state: DeliveryState
  summary: string
  files: ChangedFile[]
  tests: TestRun[]
  /** Duvidas do membro (1 a MAX_QUESTION_ITEMS) quando state = 'input_required'. */
  questions: QuestionItem[]
}

/** 'structured': veio do entregar. 'unformatted': montado do texto final ("sem formato"). */
export const ARTIFACT_FORMATS = ['structured', 'unformatted'] as const
export type ArtifactFormat = (typeof ARTIFACT_FORMATS)[number]

/** Entrega gravada (Artifact do A2A). Imutavel depois de gravada. */
export interface Artifact {
  id: ArtifactId
  taskId: TaskId
  subtaskId: SubtaskId
  sessionId: SessionId
  turnId: TurnId
  format: ArtifactFormat
  delivery: Delivery
  /** Conteudo extra em partes A2A (anexos, dados). Pode ser vazio. */
  parts: Part[]
  createdAt: EpochMs
}

// ---------------------------------------------------------------------------
// Session e Turn
// ---------------------------------------------------------------------------

/**
 * 'leader-pty': Lider (ou avulso) num terminal interativo, retomavel com --resume.
 * 'member-acp': membro rodando pelo ACP, sem terminal.
 */
export const SESSION_KINDS = ['leader-pty', 'member-acp'] as const
export type SessionKind = (typeof SESSION_KINDS)[number]

export const SESSION_STATUSES = ['starting', 'running', 'exited'] as const
export type SessionStatus = (typeof SESSION_STATUSES)[number]

export const SESSION_END_REASONS = [
  /** O processo saiu sozinho. */
  'exited',
  /** O app encerrou de proposito (pronto, cancelar, arquivar, fechar). */
  'closed',
  /** O processo morreu de forma inesperada (sinal, crash). */
  'process_died',
  /** Nao voltou ao reiniciar o app. */
  'lost_on_restart',
  /** Nao chegou a abrir. */
  'spawn_failed',
] as const
export type SessionEndReason = (typeof SESSION_END_REASONS)[number]

export interface Session {
  id: SessionId
  taskId: TaskId
  /** Subtarefa do membro. null para o Lider. */
  subtaskId: SubtaskId | null
  roleId: RoleId | null
  kind: SessionKind
  provider: Provider
  model: string | null
  cwd: string
  /**
   * Id da sessao no provedor, usado para retomar: `claude --resume <id>`,
   * `codex resume <id>`, ou session/load no ACP. null ate ser descoberto.
   */
  providerSessionId: string | null
  /** pid do processo raiz. Apenas diagnostico; nao e verdade duravel. */
  pid: number | null
  status: SessionStatus
  /** Turno em andamento (membro). null fora de turno ou para o Lider. */
  activeTurnId: TurnId | null
  startedAt: EpochMs
  endedAt: EpochMs | null
  endReason: SessionEndReason | null
  exitCode: number | null
}

/** Motivo de fim de turno do ACP (session/prompt response.stopReason). */
export const STOP_REASONS = [
  'end_turn',
  'max_tokens',
  'max_turn_requests',
  'refusal',
  'cancelled',
] as const
export type StopReason = (typeof STOP_REASONS)[number]

/** Erro que encerra um turno sem stopReason. Nunca silencio: todo turno termina com um destes ou com stopReason. */
export const TURN_ERROR_CODES = [
  'process_exited',
  'silent_timeout',
  'turn_timeout',
  'session_closed',
  'spawn_failed',
  'protocol_error',
] as const
export type TurnErrorCode = (typeof TURN_ERROR_CODES)[number]

export interface TurnError {
  code: TurnErrorCode
  message: string
  exitCode?: number | null
  signal?: string | null
}

/** Um session/prompt de um membro. */
export interface Turn {
  id: TurnId
  sessionId: SessionId
  subtaskId: SubtaskId
  startedAt: EpochMs
  endedAt: EpochMs | null
  stopReason: StopReason | null
  error: TurnError | null
  /** Texto final montado do turno (ultimo trecho de texto depois da ultima ferramenta). */
  finalText: string | null
}

/** Como um turno terminou. Exatamente um dos dois; nunca "nada". */
export type TurnOutcome =
  { kind: 'stopped'; stopReason: StopReason } | { kind: 'error'; error: TurnError }

/**
 * Resultado de MemberRuntime.prompt. A promessa sempre resolve (nunca fica pendente):
 * processo morto, vigia de silencio e tempo maximo viram outcome.kind = 'error'.
 */
export interface TurnResult {
  turnId: TurnId
  sessionId: SessionId
  outcome: TurnOutcome
  /** Texto final montado do turno (ver assembleFinalText). Pode ser ''. */
  finalText: string
  /** Entregas gravadas pelo 'entregar' durante este turno, em ordem. */
  deliveries: Artifact[]
  startedAt: EpochMs
  endedAt: EpochMs
}

// ---------------------------------------------------------------------------
// ActivityEvent (aba "Atividade" do membro)
// ---------------------------------------------------------------------------

export const TOOL_CALL_STATUSES = ['pending', 'in_progress', 'completed', 'failed'] as const
export type ToolCallStatus = (typeof TOOL_CALL_STATUSES)[number]

/** Payload por tipo. Textos longos ja chegam cortados pelo runtime (MAX_ACTIVITY_TEXT_CHARS). */
export type ActivityPayload =
  /** O prompt que o app mandou neste turno. */
  | { kind: 'prompt'; text: string }
  /** Texto do agente. O runtime junta pedacos do mesmo bloco antes de gravar. */
  | { kind: 'text'; text: string }
  /** Raciocinio exibivel do agente, quando o provedor manda. */
  | { kind: 'thought'; text: string }
  | {
      kind: 'tool_call'
      toolCallId: string
      title: string
      /** Tipo ACP (read, edit, execute, search, fetch, think, other...). */
      toolKind: string | null
      status: ToolCallStatus
      input: JsonValue | null
    }
  | {
      kind: 'tool_result'
      toolCallId: string
      status: Extract<ToolCallStatus, 'completed' | 'failed'>
      output: string | null
    }
  | { kind: 'error'; message: string; code: TurnErrorCode | null }
  | { kind: 'turn_end'; stopReason: StopReason | null; error: TurnError | null }

export type ActivityKind = ActivityPayload['kind']

export const MAX_ACTIVITY_TEXT_CHARS = 16_000

export interface ActivityEvent {
  /** Sequencia crescente por sessao, comecando em 1. Chave de paginacao. */
  seq: number
  sessionId: SessionId
  subtaskId: SubtaskId
  turnId: TurnId
  at: EpochMs
  payload: ActivityPayload
}

/** O que o runtime emite; o TaskService atribui seq e grava. */
export type ActivityEventDraft = Omit<ActivityEvent, 'seq'>

// ---------------------------------------------------------------------------
// Pergunta repassada ao usuario ("Precisa de voce")
// ---------------------------------------------------------------------------

export const USER_QUESTION_STATUSES = ['open', 'answered', 'dismissed'] as const
export type UserQuestionStatus = (typeof USER_QUESTION_STATUSES)[number]

/** Duvida que o Lider repassou ao usuario. Aparece em "Precisa de voce". */
export interface UserQuestion {
  id: QuestionId
  taskId: TaskId
  /** Subtarefa em duvida que originou a pergunta. null se o Lider perguntou por conta propria. */
  subtaskId: SubtaskId | null
  items: QuestionItem[]
  status: UserQuestionStatus
  answers: QuestionAnswer[] | null
  createdAt: EpochMs
  answeredAt: EpochMs | null
}

// ---------------------------------------------------------------------------
// Eventos de dominio (main -> tela)
// ---------------------------------------------------------------------------

/**
 * Emitidos pelo TaskService DEPOIS do commit no SQLite (I3). Carregam a entidade
 * inteira, para a tela substituir sem refazer consulta.
 */
export type DomainEvent =
  | { type: 'project.upserted'; project: Project }
  | { type: 'project.removed'; projectId: ProjectId }
  | { type: 'role.upserted'; role: Role }
  | { type: 'role.deleted'; roleId: RoleId; projectId: ProjectId }
  | { type: 'task.upserted'; task: Task }
  | { type: 'subtask.upserted'; subtask: Subtask }
  | { type: 'message.added'; message: Message }
  | { type: 'artifact.added'; artifact: Artifact }
  | { type: 'session.upserted'; session: Session }
  | { type: 'turn.upserted'; turn: Turn }
  | { type: 'activity.appended'; events: ActivityEvent[] }
  | { type: 'question.upserted'; question: UserQuestion }

export type DomainEventType = DomainEvent['type']

export interface DomainEventEnvelope {
  /** Revisao global crescente, gravada junto com a escrita. A tela descarta revisao menor que a ja vista. */
  revision: number
  at: EpochMs
  event: DomainEvent
}

// ---------------------------------------------------------------------------
// Erros
// ---------------------------------------------------------------------------

export const DOMAIN_ERROR_CODES = [
  'invalid_input',
  'not_found',
  'invalid_transition',
  /** Tentativa de mudar subtarefa em estado final (I1). */
  'final_state',
  /** Quem chamou nao tem permissao (ex: membro tentando criar subtarefa). */
  'forbidden',
  /** Conflito de unicidade ou de dono (ex: segundo Lider vivo na mesma tarefa). */
  'conflict',
  /** Recurso externo indisponivel (git, CLI do provedor, limite de agentes). */
  'unavailable',
  'internal',
] as const
export type DomainErrorCode = (typeof DOMAIN_ERROR_CODES)[number]

export interface DomainErrorPayload {
  code: DomainErrorCode
  message: string
  details?: JsonObject
}

export class DomainError extends Error {
  readonly code: DomainErrorCode
  readonly details: JsonObject | undefined

  constructor(code: DomainErrorCode, message: string, details?: JsonObject) {
    super(message)
    this.name = 'DomainError'
    this.code = code
    this.details = details
  }

  toPayload(): DomainErrorPayload {
    return this.details === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, details: this.details }
  }
}

export function toDomainErrorPayload(error: unknown): DomainErrorPayload {
  if (error instanceof DomainError) return error.toPayload()
  const message = error instanceof Error ? error.message : String(error)
  return { code: 'internal', message }
}
