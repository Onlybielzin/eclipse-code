/**
 * Contrato do servidor MCP do app e da ponte (McpBridge) entre ele e o main.
 *
 * Topologia:
 *   Lider (claude/codex no pty) ou membro (ACP)
 *     -> servidor MCP stdio (processo filho, `out/mcp/server.js`, roda com ELECTRON_RUN_AS_NODE)
 *     -> socket unix local (ENV.mcpSocket), um JSON por linha (NDJSON)
 *     -> main: McpBridgeServer -> McpToolHandler -> TaskService
 *
 * Autoridade: o servidor MCP nao decide nada. Cada pedido leva o token da sessao
 * (ENV.mcpToken). O main resolve token -> McpCaller (papel, tarefa, subtarefa) e
 * aplica as regras: so o Lider cria, responde, cancela e repassa; membro so entrega.
 * O papel nunca vem do cliente.
 */
import { z } from 'zod'
import type { DomainErrorPayload, JsonObject, SessionId, SubtaskId, TaskId } from './domain'
import {
  changedFileSchema,
  idSchema,
  MAX_DESCRIPTION_CHARS,
  questionItemSchema,
  testRunSchema,
  textSchema,
  titleSchema,
} from './schemas'
import { MAX_QUESTION_ITEMS, type Delivery, type DeliveryState } from './domain'

// ---------------------------------------------------------------------------
// Ferramentas
// ---------------------------------------------------------------------------

export const MCP_SERVER_NAME = 'eclipse'

export type McpCallerRole = 'leader' | 'member'

/** Estados que o membro escreve no 'entregar', em portugues, mapeados para DeliveryState. */
export const ENTREGAR_ESTADOS = ['pronto', 'duvida', 'bloqueado'] as const
export type EntregarEstado = (typeof ENTREGAR_ESTADOS)[number]

export const ENTREGAR_ESTADO_TO_DELIVERY_STATE: Record<EntregarEstado, DeliveryState> = {
  pronto: 'completed',
  duvida: 'input_required',
  bloqueado: 'failed',
}

/** Prazo padrao e maximo do subtarefas_esperar. */
export const MCP_WAIT_DEFAULT_SECONDS = 300
export const MCP_WAIT_MAX_SECONDS = 1_800

export const mcpToolInputSchemas = {
  /** Lider: cria subtarefa "na fila" e abre o membro do papel. */
  subtarefa_criar: z
    .object({
      papel: z.string().trim().min(1).max(200).describe('Nome do papel do time (ex: "Revisor").'),
      titulo: titleSchema.describe('Título curto da subtarefa.'),
      instrucoes: textSchema.min(1).describe('O que o membro deve fazer, com critérios de pronto.'),
      origem: z
        .array(idSchema)
        .max(20)
        .optional()
        .describe('Ids de subtarefas anteriores que esta corrige ou continua.'),
    })
    .strict(),

  /** Membro: grava a entrega do turno atual. */
  entregar: z
    .object({
      estado: z.enum(ENTREGAR_ESTADOS).describe('pronto, duvida ou bloqueado.'),
      resumo: textSchema.min(1).describe('O que foi feito, ou a dúvida, ou por que bloqueou.'),
      arquivos: z.array(changedFileSchema).max(500).optional(),
      testes: z.array(testRunSchema).max(100).optional(),
      perguntas: z.array(questionItemSchema).max(MAX_QUESTION_ITEMS).optional(),
    })
    .strict(),

  /** Lider: responde uma subtarefa em duvida (novo session/prompt na mesma sessao). */
  subtarefa_responder: z.object({ subtarefa_id: idSchema, texto: textSchema.min(1) }).strict(),

  /** Lider: cancela uma subtarefa nao final. */
  subtarefa_cancelar: z
    .object({ subtarefa_id: idSchema, motivo: z.string().max(2_000).optional() })
    .strict(),

  /** Lider: lista as subtarefas da tarefa, ou detalha uma. */
  subtarefas_ver: z.object({ subtarefa_id: idSchema.optional() }).strict(),

  /**
   * Lider: espera subtarefas pararem (pronto, duvida, bloqueado ou cancelada) e devolve
   * as entregas de uma vez. Sem ids, espera as que ainda nao pararam. Principio Code
   * Mode: o Lider nao fica consultando em laco; o dado intermediario nao passa pelo modelo.
   */
  subtarefas_esperar: z
    .object({
      subtarefa_ids: z.array(idSchema).min(1).max(50).optional(),
      modo: z
        .enum(['todas', 'qualquer'])
        .optional()
        .describe('todas (padrão): espera todas pararem. qualquer: volta na primeira.'),
      timeout_segundos: z
        .number()
        .int()
        .min(1)
        .max(MCP_WAIT_MAX_SECONDS)
        .optional()
        .describe(`Prazo em segundos. Padrão ${MCP_WAIT_DEFAULT_SECONDS}.`),
    })
    .strict(),

  /** Lider: repassa uma duvida ao usuario ("Precisa de voce"). */
  pergunta_repassar: z
    .object({
      subtarefa_id: idSchema.optional(),
      itens: z.array(questionItemSchema).min(1).max(MAX_QUESTION_ITEMS),
    })
    .strict(),

  /**
   * Lider: declara a tarefa terminada. O status vai para "Em revisão" (revisão do usuário).
   * Pronto pra lançar e Lançado so o usuario marca.
   */
  tarefa_concluir: z
    .object({
      resumo: textSchema.min(1).describe('O que foi entregue na tarefa, para o usuário revisar.'),
    })
    .strict(),
  /** Lider: troca o nome curto da tarefa mostrado na lista. O pedido original (title) nao muda. */
  tarefa_renomear: z
    .object({
      nome: z
        .string()
        .trim()
        .min(1)
        .max(80)
        .describe('Nome curto da tarefa, como aparece na lista.'),
    })
    .strict(),
  /** Lider: cria uma tarefa com Lider e time em outro projeto (ou no mesmo). O Lider dela abre sozinho. */
  tarefa_iniciar: z
    .object({
      projeto: z
        .string()
        .trim()
        .min(1)
        .max(200)
        .describe('Id ou nome do projeto (sem diferenciar maiúsculas).'),
      pedido: titleSchema.describe(
        'Pedido inicial: vira o título da tarefa e o prompt do Líder dela.',
      ),
      descricao: z
        .string()
        .max(MAX_DESCRIPTION_CHARS)
        .optional()
        .describe('Detalhes do pedido (opcional). O Líder dela lê junto com o título.'),
      worktree: z
        .boolean()
        .optional()
        .describe('Cria worktree e branch para a tarefa. Padrão true.'),
    })
    .strict(),
} as const

export type McpToolName = keyof typeof mcpToolInputSchemas
export type McpToolInput<N extends McpToolName> = z.output<(typeof mcpToolInputSchemas)[N]>

export const MCP_TOOL_NAMES = Object.keys(mcpToolInputSchemas) as McpToolName[]

/** Quem pode chamar cada ferramenta. O main confere de novo; isto so filtra a lista. */
export const MCP_TOOL_ROLES: Record<McpToolName, readonly McpCallerRole[]> = {
  subtarefa_criar: ['leader'],
  entregar: ['member'],
  subtarefa_responder: ['leader'],
  subtarefa_cancelar: ['leader'],
  subtarefas_ver: ['leader'],
  subtarefas_esperar: ['leader'],
  pergunta_repassar: ['leader'],
  tarefa_concluir: ['leader'],
  tarefa_renomear: ['leader'],
  tarefa_iniciar: ['leader'],
}

export const MCP_TOOL_DESCRIPTIONS: Record<McpToolName, string> = {
  subtarefa_criar:
    'Cria uma subtarefa para um papel do time. O app abre o membro e avisa você no fim do turno dele.',
  entregar:
    'Entrega o resultado do seu turno: estado (pronto, duvida, bloqueado), resumo, arquivos e testes.',
  subtarefa_responder:
    'Responde uma subtarefa em dúvida ou parada pelo reinício do app. O membro continua na mesma conversa (se ele parou, o app reabre).',
  subtarefa_cancelar: 'Cancela uma subtarefa que ainda não terminou.',
  subtarefas_ver: 'Lista as subtarefas desta tarefa ou mostra uma com entregas e histórico.',
  subtarefas_esperar:
    'Espera subtarefas pararem (pronto, dúvida, bloqueado ou cancelada) e devolve as entregas. Use em vez de consultar em laço.',
  pergunta_repassar:
    'Repassa uma dúvida ao usuário, com 1 a 4 itens e opções de resposta. Uma pergunta nova substitui as que ainda estavam abertas nesta tarefa.',
  tarefa_concluir:
    'Declara a tarefa terminada, com um resumo do que foi entregue. A tarefa vai para "Em revisão" do usuário. Chame só quando todo o trabalho estiver pronto.',
  tarefa_renomear: 'Troca o nome curto da tarefa mostrado na lista. O pedido original não muda.',
  tarefa_iniciar:
    'Cria uma tarefa com Líder e time no projeto indicado (id ou nome), com pedido e descrição opcional. O Líder dela começa sozinho e roda o pedido, sem esperar o usuário.',
}

export function isMcpToolName(value: unknown): value is McpToolName {
  return (
    typeof value === 'string' && Object.prototype.hasOwnProperty.call(mcpToolInputSchemas, value)
  )
}

export function deliveryFromEntregar(input: McpToolInput<'entregar'>): Delivery {
  return {
    state: ENTREGAR_ESTADO_TO_DELIVERY_STATE[input.estado],
    summary: input.resumo,
    files: input.arquivos ?? [],
    tests: input.testes ?? [],
    questions: input.perguntas ?? [],
  }
}

/** Resultado de uma ferramenta. O servidor MCP converte em content de texto (+ structuredContent). */
export interface McpToolResult {
  text: string
  data?: JsonObject
  isError?: boolean
}

// ---------------------------------------------------------------------------
// Ponte: protocolo do socket unix (NDJSON)
// ---------------------------------------------------------------------------

export const MCP_BRIDGE_PROTOCOL_VERSION = 1 as const
/** Linha maior que isto fecha a conexao. */
export const MCP_BRIDGE_MAX_FRAME_BYTES = 1_048_576

/** Identidade resolvida pelo main a partir do token. Nunca vem do cliente. */
export interface McpCaller {
  role: McpCallerRole
  sessionId: SessionId
  taskId: TaskId
  /** Subtarefa do membro. null para o Lider. */
  subtaskId: SubtaskId | null
}

export const mcpBridgeRequestSchema = z.discriminatedUnion('method', [
  z
    .object({
      v: z.literal(MCP_BRIDGE_PROTOCOL_VERSION),
      id: z.number().int().nonnegative(),
      token: z.string().min(16).max(256),
      method: z.literal('hello'),
    })
    .strict(),
  z
    .object({
      v: z.literal(MCP_BRIDGE_PROTOCOL_VERSION),
      id: z.number().int().nonnegative(),
      token: z.string().min(16).max(256),
      method: z.literal('tool.call'),
      params: z.object({ name: z.string().min(1).max(64), arguments: z.unknown() }).strict(),
    })
    .strict(),
  /** So o token de CLI (cli.token) chama; token de sessao e recusado. */
  z
    .object({
      v: z.literal(MCP_BRIDGE_PROTOCOL_VERSION),
      id: z.number().int().nonnegative(),
      token: z.string().min(16).max(256),
      method: z.literal('task.create'),
      params: z
        .object({
          projeto: z.string().trim().min(1).max(200),
          titulo: titleSchema,
          descricao: z.string().max(MAX_DESCRIPTION_CHARS).optional(),
          worktree: z.boolean(),
        })
        .strict(),
    })
    .strict(),
])

export type McpBridgeRequest = z.output<typeof mcpBridgeRequestSchema>
export type McpCliTaskInput = Extract<McpBridgeRequest, { method: 'task.create' }>['params']

/** Resposta do 'hello': quem e o chamador e quais ferramentas ele ve. */
export interface McpHelloResult {
  caller: McpCaller
  tools: McpToolName[]
}

export type McpBridgeResponse =
  | {
      v: typeof MCP_BRIDGE_PROTOCOL_VERSION
      id: number
      ok: true
      result: McpHelloResult | McpToolResult
    }
  | { v: typeof MCP_BRIDGE_PROTOCOL_VERSION; id: number; ok: false; error: DomainErrorPayload }
