/**
 * Contrato IPC entre a tela (renderer) e o main.
 *
 * - Comandos: tela -> main, por ipcRenderer.invoke(IPC_INVOKE_CHANNEL, { channel, input }).
 *   O main valida `input` com o schema do comando ANTES de chamar o handler e sempre
 *   responde um IpcResult (nunca rejeita a promessa).
 * - Eventos: main -> tela, por webContents.send(IPC_EVENT_CHANNEL, { channel, payload }).
 *   Eventos de dominio sao emitidos so depois do commit no SQLite.
 *
 * A tela so le e pede operacoes. Quem escreve tarefas, subtarefas e entregas e o main.
 */
import { z } from 'zod'
import type {
  ActivityEvent,
  Artifact,
  DomainErrorPayload,
  DomainEventEnvelope,
  Message,
  Project,
  Role,
  Session,
  Subtask,
  Task,
  Turn,
  UserQuestion,
} from './domain'
import {
  absolutePathSchema,
  idSchema,
  providerSchema,
  questionAnswerSchema,
  taskKindSchema,
  taskWorkflowStatusSchema,
  titleSchema,
  textSchema,
} from './schemas'

// ---------------------------------------------------------------------------
// Transporte
// ---------------------------------------------------------------------------

/** Unico canal ipcMain.handle. O nome do comando vai no corpo. */
export const IPC_INVOKE_CHANNEL = 'eclipse:invoke'
/** Unico canal de eventos main -> tela. */
export const IPC_EVENT_CHANNEL = 'eclipse:event'

export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: DomainErrorPayload }

/**
 * Define um comando: o tipo da saida (so tipo) e o schema zod da entrada.
 * Uso: command<Task>()(z.object({...})). A entrada tipada sai do proprio schema.
 */
function command<TOutput>() {
  return <TInput extends z.ZodType>(input: TInput) => ({
    input,
    output: undefined as unknown as TOutput,
  })
}

const emptyInput = z.object({}).strict()

// ---------------------------------------------------------------------------
// Visoes de leitura
// ---------------------------------------------------------------------------

/** Pasta escolhida no explorador do sistema. Cancelar devolve null. */
export interface PickedFolder {
  path: string
  /** Nome sugerido: o nome da pasta. */
  name: string
  /** A pasta tem .git (tarefas precisam de repositorio para criar worktree). */
  isGitRepo: boolean
  /** Ja existe projeto com essa pasta. */
  alreadyAdded: boolean
}

/** Contadores de um projeto para o seletor do topo. */
export interface ProjectSummary {
  projectId: string
  /** Tarefas nao arquivadas. */
  openTasks: number
  /** Perguntas abertas ("precisa de voce"). */
  needsYou: number
}

/** Resposta de projects.summary: contadores de cada projeto e a home do usuario. */
export interface ProjectsSummary {
  /** Pasta home do usuario no main, para a tela encurtar caminhos com ~. */
  homeDir: string
  projects: ProjectSummary[]
}

export interface AppInfo {
  version: string
  appId: string
  userDataPath: string
  platform: string
  electron: string
}

/** Tudo que a tela de entrega precisa de uma subtarefa. */
export interface SubtaskDetail {
  subtask: Subtask
  messages: Message[]
  artifacts: Artifact[]
  turns: Turn[]
  session: Session | null
}

/** Estado do terminal de uma sessao do Lider ao conectar a tela. */
export interface TerminalAttachResult {
  sessionId: string
  alive: boolean
  cols: number
  rows: number
  /** Saida recente (ring buffer do main) para repintar o xterm antes dos eventos novos. */
  scrollback: string
}

export interface ActivityPage {
  events: ActivityEvent[]
  /** seq do ultimo evento devolvido; use em afterSeq na proxima pagina. null se vazio. */
  lastSeq: number | null
  hasMore: boolean
}

// ---------------------------------------------------------------------------
// Comandos (tela -> main)
// ---------------------------------------------------------------------------

const roleFields = {
  name: titleSchema,
  description: z.string().max(2_000),
  provider: providerSchema,
  model: z.string().trim().min(1).max(120).nullable(),
  promptTemplate: textSchema,
  isLead: z.boolean(),
}

export const ipcCommands = {
  'app.info': command<AppInfo>()(emptyInput),

  'projects.list': command<Project[]>()(emptyInput),
  'projects.pickFolder': command<PickedFolder | null>()(emptyInput),
  'projects.add': command<Project>()(
    z.object({ rootPath: absolutePathSchema, name: titleSchema.optional() }).strict(),
  ),
  'projects.remove': command<void>()(z.object({ projectId: idSchema }).strict()),
  /** Tarefas abertas e perguntas abertas de cada projeto (seletor de projeto do topo). */
  'projects.summary': command<ProjectsSummary>()(emptyInput),

  'roles.list': command<Role[]>()(z.object({ projectId: idSchema }).strict()),
  /** Cria (sem roleId) ou atualiza (com roleId) um papel. */
  'roles.save': command<Role>()(
    z.object({ projectId: idSchema, roleId: idSchema.optional(), ...roleFields }).strict(),
  ),
  'roles.delete': command<void>()(z.object({ roleId: idSchema }).strict()),

  'tasks.list': command<Task[]>()(
    z.object({ projectId: idSchema, includeArchived: z.boolean() }).strict(),
  ),
  /**
   * Cria a tarefa. kind 'team': cria worktree + branch e abre o Lider (leadRoleId ou o
   * papel isLead do projeto). kind 'solo': avulso; useWorktree=false roda na raiz.
   */
  'tasks.create': command<Task>()(
    z
      .object({
        projectId: idSchema,
        title: titleSchema,
        kind: taskKindSchema,
        leadRoleId: idSchema.optional(),
        soloProvider: providerSchema.optional(),
        baseBranch: z.string().trim().min(1).max(255).optional(),
        useWorktree: z.boolean(),
      })
      .strict()
      .refine((v) => v.kind === 'solo' || v.useWorktree, {
        message: 'tarefa de time precisa de worktree',
        path: ['useWorktree'],
      }),
  ),
  /** Arquiva: fecha as sessoes vivas e, se removeWorktree, remove worktree e branch. */
  'tasks.archive': command<Task>()(
    z.object({ taskId: idSchema, removeWorktree: z.boolean() }).strict(),
  ),
  /**
   * Status escolhido pelo usuario no menu da lista. Qualquer um dos 6; 'lancado' arquiva
   * (fecha agentes, mantem a worktree) e sair de 'lancado' reabre a tarefa.
   */
  'tasks.setStatus': command<Task>()(
    z.object({ taskId: idSchema, status: taskWorkflowStatusSchema }).strict(),
  ),

  'subtasks.list': command<Subtask[]>()(z.object({ taskId: idSchema }).strict()),
  'subtasks.detail': command<SubtaskDetail>()(z.object({ subtaskId: idSchema }).strict()),

  'activity.list': command<ActivityPage>()(
    z
      .object({
        subtaskId: idSchema,
        afterSeq: z.number().int().nonnegative().optional(),
        limit: z.number().int().min(1).max(1_000),
      })
      .strict(),
  ),

  'sessions.list': command<Session[]>()(z.object({ taskId: idSchema }).strict()),

  /** Garante o Lider vivo da tarefa: devolve o vivo, retoma com --resume ou abre novo. */
  'leader.ensure': command<Session>()(z.object({ taskId: idSchema }).strict()),

  'terminal.attach': command<TerminalAttachResult>()(z.object({ sessionId: idSchema }).strict()),
  'terminal.write': command<void>()(
    z.object({ sessionId: idSchema, data: z.string().max(1_000_000) }).strict(),
  ),
  'terminal.resize': command<void>()(
    z
      .object({
        sessionId: idSchema,
        cols: z.number().int().min(2).max(1_000),
        rows: z.number().int().min(1).max(1_000),
      })
      .strict(),
  ),

  /** Perguntas abertas de "Precisa de voce" no projeto. */
  'questions.list': command<UserQuestion[]>()(z.object({ projectId: idSchema }).strict()),
  'questions.answer': command<UserQuestion>()(
    z
      .object({ questionId: idSchema, answers: z.array(questionAnswerSchema).min(1).max(4) })
      .strict(),
  ),
  'questions.dismiss': command<UserQuestion>()(z.object({ questionId: idSchema }).strict()),
} as const

export type IpcCommands = typeof ipcCommands
export type IpcCommandChannel = keyof IpcCommands
/** Entrada ja validada, como o handler do main recebe. */
export type IpcCommandInput<C extends IpcCommandChannel> = z.output<IpcCommands[C]['input']>
/** Entrada como a tela manda (antes de defaults/trim do schema). */
export type IpcCommandRequest<C extends IpcCommandChannel> = z.input<IpcCommands[C]['input']>
export type IpcCommandOutput<C extends IpcCommandChannel> = IpcCommands[C]['output']

export interface IpcInvokeRequest {
  channel: string
  input: unknown
}

/** Handlers que o main registra. Erros de dominio: lance DomainError. */
export type IpcCommandHandlers = {
  [C in IpcCommandChannel]: (input: IpcCommandInput<C>) => Promise<IpcCommandOutput<C>>
}

export function isIpcCommandChannel(value: unknown): value is IpcCommandChannel {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(ipcCommands, value)
}

/**
 * Valida o pedido cru vindo do renderer. Devolve o canal e a entrada tipada,
 * ou um erro 'invalid_input' pronto para responder.
 */
export function parseIpcInvokeRequest(
  raw: unknown,
):
  | { ok: true; channel: IpcCommandChannel; input: unknown }
  | { ok: false; error: DomainErrorPayload } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: { code: 'invalid_input', message: 'pedido IPC malformado' } }
  }
  const { channel, input } = raw as Partial<IpcInvokeRequest>
  if (!isIpcCommandChannel(channel)) {
    return {
      ok: false,
      error: { code: 'invalid_input', message: `comando IPC desconhecido: ${String(channel)}` },
    }
  }
  const parsed = ipcCommands[channel].input.safeParse(input ?? {})
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: 'invalid_input',
        message: `entrada inválida para ${channel}: ${z.prettifyError(parsed.error)}`,
      },
    }
  }
  return { ok: true, channel, input: parsed.data }
}

// ---------------------------------------------------------------------------
// Eventos (main -> tela)
// ---------------------------------------------------------------------------

export interface IpcEvents {
  /** Mudanca de dominio, ja gravada no SQLite. */
  'domain.event': DomainEventEnvelope
  /** Saida do terminal do Lider. Volume alto; nao passa pelo SQLite. */
  'terminal.data': { sessionId: string; data: string }
  'terminal.exit': { sessionId: string; exitCode: number | null; signal: string | null }
}

export type IpcEventChannel = keyof IpcEvents

export interface IpcEventMessage<C extends IpcEventChannel = IpcEventChannel> {
  channel: C
  payload: IpcEvents[C]
}

export const IPC_EVENT_CHANNELS = [
  'domain.event',
  'terminal.data',
  'terminal.exit',
] as const satisfies readonly IpcEventChannel[]

// ---------------------------------------------------------------------------
// API exposta pelo preload em window.eclipse
// ---------------------------------------------------------------------------

export interface EclipseApi {
  invoke<C extends IpcCommandChannel>(
    channel: C,
    input: IpcCommandRequest<C>,
  ): Promise<IpcResult<IpcCommandOutput<C>>>
  /** Assina um evento. Devolve a funcao que cancela a assinatura. */
  on<C extends IpcEventChannel>(channel: C, listener: (payload: IpcEvents[C]) => void): () => void
}
