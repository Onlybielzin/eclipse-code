/**
 * Plugin Cerebro no main: guarda a chave sbk_ cifrada (app_settings), serve grafo e memoria
 * e mantem o SSE de atividade aberto so enquanto a tela tiver assinantes.
 */
import { DomainError } from '@shared/domain'
import type { ActivityEvent, BrainGraph, BrainStatus, MemoryDetail } from '@shared/brain'
import { BrainHttpError, createBrainClient, type BrainClientOptions } from './client'

/** Cifra do sistema. O safeStorage do Electron cumpre esta interface; os testes injetam uma falsa. */
export interface BrainCipher {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(encrypted: Buffer): string
}

/** Fatia do TaskStore que guarda a chave (base64 do texto cifrado, como JSON). */
export interface BrainSettingsStore {
  getSetting(key: string): string | null
  setSetting(key: string, valueJson: string): void
}

export interface BrainEmit {
  (message: { channel: 'brain.activity'; payload: ActivityEvent }): void
  (message: { channel: 'brain.history'; payload: ActivityEvent[] }): void
}

export interface BrainServiceOptions {
  settings: BrainSettingsStore
  cipher: BrainCipher
  emit: BrainEmit
  client?: BrainClientOptions
  /** Espera entre tentativas; os testes trocam por uma versao instantanea. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}

const KEY_SETTING = 'brainApiKey'
const MAX_DELAY_MS = 30_000

function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
    function done() {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
  })
}

export function createBrainService(options: BrainServiceOptions) {
  const { settings, cipher, emit } = options
  const client = createBrainClient(options.client)
  const sleep = options.sleep ?? sleepAbortable

  // Ids dos webContents que assinam: uma janela conta uma vez, e recarregar nao deixa lixo.
  const subscribers = new Set<number>()
  let connected = false
  let lastError: string | null = null
  let abort: AbortController | null = null

  function readKey(): string | null {
    const raw = settings.getSetting(KEY_SETTING)
    if (raw === null) return null
    try {
      const stored: unknown = JSON.parse(raw)
      if (typeof stored !== 'string') return null
      return cipher.decryptString(Buffer.from(stored, 'base64'))
    } catch {
      return null
    }
  }

  function requireKey(): string {
    const key = readKey()
    if (!key) throw new DomainError('unavailable', 'Salve a chave do Second Brain nas Configurações.')
    return key
  }

  function stop(): void {
    abort?.abort()
    abort = null
    connected = false
  }

  async function run(key: string, controller: AbortController): Promise<void> {
    const { signal } = controller
    let attempt = 0
    while (!signal.aborted) {
      try {
        await client.streamActivity(
          key,
          {
            onOpen: () => {
              if (abort !== controller) return
              connected = true
              lastError = null
            },
            // So o primeiro dado zera a espera: servidor que abre e fecha logo nao vira laco de 1 s.
            onData: () => {
              if (abort === controller) attempt = 0
            },
            onHistory: (events) => emit({ channel: 'brain.history', payload: events }),
            onActivity: (event) => emit({ channel: 'brain.activity', payload: event }),
          },
          signal,
        )
        if (abort !== controller) return
        lastError = 'O Second Brain encerrou a conexão.'
      } catch (error) {
        if (signal.aborted) break
        if (error instanceof BrainHttpError && error.rejected) {
          connected = false
          lastError = 'Chave recusada.'
          // Para de tentar; um novo brain.setKey ou uma nova assinatura reabre.
          if (abort === controller) abort = null
          return
        }
        lastError = error instanceof Error ? error.message : String(error)
      }
      connected = false
      await sleep(Math.min(1_000 * 2 ** attempt, MAX_DELAY_MS), signal)
      attempt += 1
    }
  }

  /** Abre a conexao se ha assinante e chave e ela ainda nao existe. */
  function ensure(): void {
    if (abort || subscribers.size === 0) return
    const key = readKey()
    if (!key) return
    const controller = new AbortController()
    abort = controller
    void run(key, controller)
  }

  function status(): BrainStatus {
    const key = readKey()
    return {
      hasKey: key !== null,
      keyLast4: key ? key.slice(-4) : null,
      connected,
      lastError,
    }
  }

  return {
    status,

    setKey(key: string | null): BrainStatus {
      if (key !== null) {
        if (!cipher.isEncryptionAvailable()) {
          throw new DomainError(
            'unavailable',
            'O sistema não tem cofre de senhas disponível para guardar a chave com segurança. A chave não foi salva.',
          )
        }
        settings.setSetting(
          KEY_SETTING,
          JSON.stringify(cipher.encryptString(key).toString('base64')),
        )
      } else {
        settings.setSetting(KEY_SETTING, 'null')
      }
      stop()
      lastError = null
      ensure()
      return status()
    },

    graph: async (): Promise<BrainGraph> => client.graph(requireKey()),
    memory: async (id: string): Promise<MemoryDetail> => client.memory(requireKey(), id),

    /** Idempotente por janela (senderId = webContents.id). */
    subscribe(senderId: number): void {
      subscribers.add(senderId)
      ensure()
    },
    /** Tambem chamado quando a janela recarrega ou e destruida. */
    unsubscribe(senderId: number): void {
      if (subscribers.delete(senderId) && subscribers.size === 0) stop()
    },
    dispose(): void {
      subscribers.clear()
      stop()
    },
  }
}
export type BrainService = ReturnType<typeof createBrainService>
