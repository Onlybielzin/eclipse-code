import { describe, expect, it, vi } from 'vitest'
import type { ActivityEvent } from '@shared/brain'
import { ipcCommands } from '@shared/ipc'
import { createBrainService, type BrainCipher, type BrainEmit } from './brainService'

const KEY = 'sbk_abcdefghijklmnop1234'

const fakeCipher = (available = true): BrainCipher => ({
  isEncryptionAvailable: () => available,
  encryptString: (s) => Buffer.from(`cifrado:${[...s].reverse().join('')}`),
  decryptString: (b) => [...b.toString().replace('cifrado:', '')].reverse().join(''),
})

function memorySettings() {
  const map = new Map<string, string>()
  return {
    map,
    getSetting: (k: string) => map.get(k) ?? null,
    setSetting: (k: string, v: string) => void map.set(k, v),
  }
}

const EVENT: ActivityEvent = { seq: 1, ts: 't', kind: 'search', query: 'q', hits: [] }
const NODE = { id: 'a', label: 'A', type: 'note', scope: 'global', importance: 5, created: 'x' }

function sseResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/event-stream' } })
}

function make(fetchFake: typeof fetch, cipher = fakeCipher()) {
  const settings = memorySettings()
  const emitted: unknown[] = []
  const waits: number[] = []
  const service = createBrainService({
    settings,
    cipher,
    emit: ((m: unknown) => emitted.push(m)) as BrainEmit,
    client: { fetch: fetchFake, baseUrl: 'https://brain.test' },
    sleep: async (ms) => {
      waits.push(ms)
      // Cede a vez para o teste observar o estado entre as tentativas.
      await new Promise((r) => setTimeout(r, 0))
    },
  })
  return { service, settings, emitted, waits }
}

const never = (async () => {
  throw new Error('sem rede')
}) as unknown as typeof fetch

describe('chave sbk_', () => {
  it('salva cifrada, devolve só o final e apaga', () => {
    const { service, settings } = make(never)
    const status = service.setKey(KEY)
    expect(status).toMatchObject({ hasKey: true, keyLast4: '1234' })
    expect(JSON.stringify(status)).not.toContain(KEY)
    expect(settings.map.get('brainApiKey')).not.toContain('sbk_')
    expect(service.status()).toMatchObject({ hasKey: true, keyLast4: '1234' })
    expect(service.setKey(null)).toMatchObject({ hasKey: false, keyLast4: null })
  })

  it('recusa salvar em texto puro quando o sistema não tem cofre', () => {
    const { service, settings } = make(never, fakeCipher(false))
    expect(() => service.setKey(KEY)).toThrow(/cofre de senhas/)
    expect(settings.map.size).toBe(0)
  })

  it('o IPC recusa chave sem sbk_, longa demais e campo extra; aceita null', () => {
    const schema = ipcCommands['brain.setKey'].input
    expect(schema.safeParse({ key: KEY }).success).toBe(true)
    expect(schema.safeParse({ key: null }).success).toBe(true)
    expect(schema.safeParse({ key: 'abc' }).success).toBe(false)
    expect(schema.safeParse({ key: 'sbk_' + 'a'.repeat(200) }).success).toBe(false)
    expect(schema.safeParse({ key: KEY, extra: 1 }).success).toBe(false)
  })
})

describe('cliente HTTP', () => {
  it('manda Bearer e devolve o grafo com campos extras', async () => {
    const fetchFake = vi.fn(async () =>
      Response.json({ nodes: [{ ...NODE, extra: 1 }], edges: [] }),
    )
    const { service } = make(fetchFake as unknown as typeof fetch)
    service.setKey(KEY)
    const graph = await service.graph()
    expect(graph.nodes[0]).toMatchObject({ id: 'a', extra: 1 })
    const [url, init] = fetchFake.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://brain.test/api/graph')
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`)
  })

  it('resposta com formato errado vira erro; sem chave também', async () => {
    const { service } = make((async () => Response.json({ nodes: 'x' })) as unknown as typeof fetch)
    await expect(service.graph()).rejects.toThrow(/salve a chave/i)
    service.setKey(KEY)
    await expect(service.graph()).rejects.toThrow(/Resposta inesperada/)
    await expect(service.memory('a')).rejects.toThrow(/Resposta inesperada/)
  })
})

describe('SSE de atividade', () => {
  const sse = `event: history\ndata: [${JSON.stringify(EVENT)}]\n\n: ping\n\nevent: activity\ndata: ${JSON.stringify({ ...EVENT, seq: 2 })}\n\nevent: activity\ndata: {"errado":true}\n\n`

  it('só conecta com assinante, emite history e activity válidos e fecha sem assinantes', async () => {
    const signals: AbortSignal[] = []
    const fetchFake = vi.fn(async (_url: string, init?: RequestInit) => {
      signals.push(init!.signal!)
      // Conexão que fica aberta depois do último evento, como o SSE real.
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode(sse))
          init!.signal!.addEventListener('abort', () => c.error(new Error('abortado')))
        },
      })
      return new Response(body)
    })
    const { service, emitted } = make(fetchFake as unknown as typeof fetch)
    service.setKey(KEY)
    expect(fetchFake).not.toHaveBeenCalled()
    service.subscribe(1)
    await vi.waitFor(() => expect(emitted).toHaveLength(2))
    expect(emitted).toEqual([
      { channel: 'brain.history', payload: [EVENT] },
      { channel: 'brain.activity', payload: { ...EVENT, seq: 2 } },
    ])
    const init = fetchFake.mock.calls[0] as unknown as [string, RequestInit]
    expect((init[1].headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`)
    service.unsubscribe(1)
    expect(signals[0]!.aborted).toBe(true)
    expect(service.status().connected).toBe(false)
  })

  it('reconecta com espera crescente e para ao apagar a chave', async () => {
    const fetchFake = vi.fn(async () => {
      throw new Error('sem rede')
    })
    const { service, waits } = make(fetchFake as unknown as typeof fetch)
    service.setKey(KEY)
    service.subscribe(1)
    await vi.waitFor(() => expect(waits.length).toBeGreaterThanOrEqual(6))
    expect(waits.slice(0, 6)).toEqual([1000, 2000, 4000, 8000, 16000, 30000])
    service.setKey(null)
    const calls = fetchFake.mock.calls.length
    await new Promise((r) => setTimeout(r, 20))
    expect(fetchFake.mock.calls.length).toBe(calls)
    service.dispose()
  })

  it('401 para de tentar e informa chave recusada', async () => {
    const fetchFake = vi.fn(async () => sseResponse('', 401))
    const { service, waits } = make(fetchFake as unknown as typeof fetch)
    service.setKey(KEY)
    service.subscribe(1)
    await vi.waitFor(() => expect(service.status().lastError).toBe('Chave recusada.'))
    await new Promise((r) => setTimeout(r, 20))
    expect(fetchFake).toHaveBeenCalledTimes(1)
    expect(waits).toEqual([])
    expect(service.status().connected).toBe(false)
  })
})

describe('assinantes por janela', () => {
  /** SSE que fica aberto; guarda o signal de cada conexao. */
  function openFetch() {
    const signals: AbortSignal[] = []
    const fetchFake = vi.fn(async (_url: string, init?: RequestInit) => {
      signals.push(init!.signal!)
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode(': ping\n\n'))
          init!.signal!.addEventListener('abort', () => c.error(new Error('abortado')))
        },
      })
      return new Response(body)
    })
    return { signals, fetchFake }
  }

  it('recarga: a mesma janela assina 2 vezes e a navegação solta, fechando o SSE', async () => {
    const { signals, fetchFake } = openFetch()
    const { service } = make(fetchFake as unknown as typeof fetch)
    service.setKey(KEY)
    service.subscribe(7)
    service.subscribe(7)
    await vi.waitFor(() => expect(signals).toHaveLength(1))
    service.unsubscribe(7) // o que o main faz em did-start-navigation
    expect(signals[0]!.aborted).toBe(true)
    // A tela nova assina de novo e abre uma conexão nova.
    service.subscribe(7)
    await vi.waitFor(() => expect(signals).toHaveLength(2))
    expect(signals[1]!.aborted).toBe(false)
    service.dispose()
  })

  it('duas janelas: uma sai e o SSE segue; a última fecha', async () => {
    const { signals, fetchFake } = openFetch()
    const { service } = make(fetchFake as unknown as typeof fetch)
    service.setKey(KEY)
    service.subscribe(1)
    service.subscribe(2)
    await vi.waitFor(() => expect(signals).toHaveLength(1))
    service.unsubscribe(1)
    expect(signals[0]!.aborted).toBe(false)
    service.unsubscribe(1) // repetido não derruba a outra janela
    expect(signals[0]!.aborted).toBe(false)
    service.unsubscribe(2)
    expect(signals[0]!.aborted).toBe(true)
  })

  it('servidor que abre e fecha logo faz a espera crescer', async () => {
    const fetchFake = vi.fn(async () => new Response(new ReadableStream({ start: (c) => c.close() })))
    const { service, waits } = make(fetchFake as unknown as typeof fetch)
    service.setKey(KEY)
    service.subscribe(1)
    await vi.waitFor(() => expect(waits.length).toBeGreaterThanOrEqual(4))
    expect(waits.slice(0, 4)).toEqual([1000, 2000, 4000, 8000])
    service.dispose()
  })
})
