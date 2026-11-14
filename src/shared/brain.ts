/**
 * Contrato do plugin Cerebro: tipos da API do second-brain SaaS (nomes iguais aos da API)
 * e os schemas zod que o main usa para validar as RESPOSTAS (fronteira de confianca).
 * Campos extras passam; formato errado vira erro.
 */
import { z } from 'zod'

export interface ApiNode {
  id: string
  label: string
  type: string
  scope: string
  name?: string
  importance: number
  created: string
}

export interface ApiEdge {
  source: string
  target: string
  kind: 'link' | 'supersedes'
}

export interface MemoryDetail {
  id: string
  type: string
  scope: string
  name?: string
  importance: number
  created: string
  body: string
  links: { name: string; id: string }[]
  supersedes?: string
  backlinks: { id: string; label: string; type: string; scope: string }[]
}

export interface ActivityEvent {
  seq: number
  ts: string
  kind: 'search' | 'entity' | 'get' | 'save' | 'link'
  query: string
  project?: string
  hits: { id: string; score?: number }[]
  /** Token que consultou (rotulo da origem MCP: o nome do token). */
  origin?: { id: string; label: string; kind: string }
}

export interface BrainGraph {
  nodes: ApiNode[]
  edges: ApiEdge[]
}

/** Estado para a tela. A chave inteira nunca sai do main. */
export interface BrainStatus {
  hasKey: boolean
  /** Ultimos 4 caracteres da chave, para exibir "Chave salva (...abcd)". */
  keyLast4: string | null
  /** O SSE de atividade esta aberto agora. */
  connected: boolean
  lastError: string | null
}

/** Chave sbk_ aceita pelo brain.setKey. */
export const brainKeySchema = z.string().startsWith('sbk_').max(200)

const nodeSchema = z.looseObject({
  id: z.string(),
  label: z.string(),
  type: z.string(),
  scope: z.string(),
  name: z.string().optional(),
  importance: z.number(),
  created: z.string(),
})

const edgeSchema = z.looseObject({
  source: z.string(),
  target: z.string(),
  kind: z.enum(['link', 'supersedes']),
})

export const brainGraphSchema = z.looseObject({
  nodes: z.array(nodeSchema),
  edges: z.array(edgeSchema),
})

export const memoryDetailSchema = z.looseObject({
  id: z.string(),
  type: z.string(),
  scope: z.string(),
  name: z.string().optional(),
  importance: z.number(),
  created: z.string(),
  body: z.string(),
  links: z.array(z.looseObject({ name: z.string(), id: z.string() })),
  supersedes: z.string().optional(),
  backlinks: z.array(
    z.looseObject({ id: z.string(), label: z.string(), type: z.string(), scope: z.string() }),
  ),
})

export const activityEventSchema = z.looseObject({
  seq: z.number(),
  ts: z.string(),
  kind: z.enum(['search', 'entity', 'get', 'save', 'link']),
  query: z.string(),
  project: z.string().optional(),
  hits: z.array(z.looseObject({ id: z.string(), score: z.number().optional() })),
  origin: z.looseObject({ id: z.string(), label: z.string(), kind: z.string() }).optional(),
})
export const activityHistorySchema = z.array(activityEventSchema)
