import type { IpcEventMessage } from '@shared/ipc'
import { DomainError } from '@shared/domain'
import type { RemoteSaveInput, RemoteStatus } from '@shared/remote'
import type { AppLogger } from '../app/teamCoordinator'
import { createNtfy, type NtfyDeps } from './ntfy'
import { createRemoteServer, type RemoteServerOptions } from './remoteServer'
import {
  loadRemoteSettings,
  newRemoteToken,
  saveRemoteSettings,
  type SettingsStorage,
} from './remoteSettings'

export interface RemoteController {
  get(): RemoteStatus
  save(input: RemoteSaveInput): Promise<RemoteStatus>
  rotateToken(): RemoteStatus
  /** Manda um aviso de teste ao ntfy; rejeita com a mensagem legivel. */
  testNotify(): Promise<void>
  emit(message: IpcEventMessage): void
  /** Sobe o servidor se estiver ligado nas configuracoes (chamar na partida). */
  init(): Promise<void>
  dispose(): Promise<void>
}

/** Junta configuracoes (SQLite) e servidor; ligar e desligar vale na hora, sem reiniciar o app. */
export function createRemoteController(options: {
  storage: SettingsStorage
  route: RemoteServerOptions['route']
  rendererDir: string | null
  /** fetch do aviso por ntfy. null (teste e smoke) = nunca manda nada. Padrao: o fetch global. */
  ntfyFetch?: NtfyDeps['fetch']
  lookup?: NtfyDeps['lookup']
  log?: AppLogger
}): RemoteController {
  let settings = loadRemoteSettings(options.storage)
  let running = false
  let error: string | null = null
  const server = createRemoteServer({
    route: options.route,
    rendererDir: options.rendererDir,
    getToken: () => settings.token,
  })

  const noop = () => {}
  const ntfy = createNtfy({
    getSettings: () => settings,
    fetch: options.ntfyFetch === undefined ? fetch : options.ntfyFetch,
    lookup: options.lookup ?? (() => ({ taskName: 'Tarefa', projectName: 'Eclipse Code' })),
    log: options.log ?? { info: noop, warn: noop, error: noop },
  })

  const status = (): RemoteStatus => ({
    enabled: settings.enabled,
    port: settings.port,
    token: settings.token,
    pairUrlPath: `/pair?token=${settings.token}`,
    running,
    error,
    ntfyEnabled: settings.ntfyEnabled,
    ntfyServer: settings.ntfyServer,
    ntfyTopic: settings.ntfyTopic,
    ntfyTokenSet: settings.ntfyToken !== null,
    publicUrl: settings.publicUrl,
  })

  // Serializa apply: dois save seguidos nao correm entre o stop de um e o start do outro.
  let queue: Promise<void> = Promise.resolve()
  const apply = () => (queue = queue.then(applyNow, applyNow))

  async function applyNow() {
    await server.stop()
    running = false
    error = null
    if (!settings.enabled) return
    try {
      await server.start(settings.port)
      running = true
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      error =
        code === 'EADDRINUSE'
          ? `A porta ${settings.port} já está em uso.`
          : `Não foi possível abrir a porta ${settings.port}.`
    }
  }

  return {
    get: status,
    async save(input) {
      const { ntfyToken, removeNtfyToken, ...rest } = input
      const patch = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined))
      settings = saveRemoteSettings(options.storage, {
        ...settings,
        ...patch,
        ntfyToken: removeNtfyToken ? null : (ntfyToken ?? settings.ntfyToken),
      })
      await apply()
      return status()
    },
    rotateToken() {
      settings = saveRemoteSettings(options.storage, { ...settings, token: newRemoteToken() })
      server.closeClients()
      return status()
    },
    async testNotify() {
      try {
        await ntfy.test()
      } catch (e) {
        throw new DomainError(
          'unavailable',
          e instanceof Error ? e.message : 'O aviso de teste falhou.',
        )
      }
    },
    emit(message) {
      server.emit(message)
      void ntfy.handle(message)
    },
    init: apply,
    dispose: () => server.stop(),
  }
}
