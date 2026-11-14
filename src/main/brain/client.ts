/** Cliente HTTP do second-brain SaaS. Toda resposta e validada com zod antes de sair daqui. */
import type { z } from 'zod'
import {
  activityEventSchema,
  activityHistorySchema,
  brainGraphSchema,
  memoryDetailSchema,
  type ActivityEvent,
  type BrainGraph,
  type MemoryDetail,
} from '@shared/brain'
import { createSseParser } from './sse'

export const BRAIN_BASE_URL = 'https://secondbrain.vings.app'

export class BrainHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'BrainHttpError'
  }
  /** Chave recusada pelo servidor: nao adianta tentar de novo. */
  get rejected(): boolean {
    return this.status === 401 || this.status === 403
  }
}

export interface BrainClientOptions {
  baseUrl?: string
  fetch?: typeof fetch
}

function httpError(status: number): BrainHttpError {
  return new BrainHttpError(
    status,
    status === 401 || status === 403
      ? 'Chave recusada pelo Second Brain.'
      : `O Second Brain respondeu com erro ${status}.`,
  )
}

export function createBrainClient(options: BrainClientOptions = {}) {
  const base = options.baseUrl ?? BRAIN_BASE_URL
  const doFetch = options.fetch ?? fetch

  async function getJson<S extends z.ZodType>(path: string, key: string, schema: S) {
    const res = await doFetch(base + path, { headers: { Authorization: `Bearer ${key}` } })
    if (!res.ok) throw httpError(res.status)
    const parsed = schema.safeParse(await res.json().catch(() => undefined))
    if (!parsed.success) throw new Error(`Resposta inesperada do Second Brain em ${path}.`)
    return parsed.data as z.output<S>
  }

  return {
    graph: (key: string): Promise<BrainGraph> => getJson('/api/graph', key, brainGraphSchema),
    memory: (key: string, id: string): Promise<MemoryDetail> =>
      getJson(`/api/memory?id=${encodeURIComponent(id)}`, key, memoryDetailSchema),

    /**
     * Abre o SSE e le ate o fim ou ate o abort. Eventos de formato errado sao descartados.
     * Lanca BrainHttpError se o servidor recusar.
     */
    async streamActivity(
      key: string,
      handlers: {
        onOpen(): void
        /** Chegou qualquer dado (evento ou ping): a conexao esta viva de verdade. */
        onData?(): void
        onHistory(events: ActivityEvent[]): void
        onActivity(event: ActivityEvent): void
      },
      signal: AbortSignal,
    ): Promise<void> {
      const res = await doFetch(`${base}/api/activity`, {
        headers: { Authorization: `Bearer ${key}`, Accept: 'text/event-stream' },
        signal,
      })
      if (!res.ok) throw httpError(res.status)
      if (!res.body) throw new Error('O Second Brain não enviou o fluxo de atividade.')
      handlers.onOpen()
      const parser = createSseParser(({ event, data }) => {
        let json: unknown
        try {
          json = JSON.parse(data)
        } catch {
          return
        }
        if (event === 'history') {
          const parsed = activityHistorySchema.safeParse(json)
          if (parsed.success) handlers.onHistory(parsed.data)
        } else if (event === 'activity') {
          const parsed = activityEventSchema.safeParse(json)
          if (parsed.success) handlers.onActivity(parsed.data)
        }
      })
      const decoder = new TextDecoder()
      const reader = res.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return
        handlers.onData?.()
        parser.feed(decoder.decode(value, { stream: true }))
      }
    },
  }
}
export type BrainClient = ReturnType<typeof createBrainClient>
