/**
 * Auto-update pelo GitHub Releases e "Novidades da versão". O app baixa sozinho e avisa;
 * nunca reinicia sozinho (reiniciar mata os agentes). Sem clique, instala ao fechar.
 * O autoUpdater e a leitura do CHANGELOG entram por parametro para teste.
 */
import { DomainError } from '@shared/domain'
import { changelogSection } from '@shared/changelog'
import type { IpcEventMessage, UpdateState, WhatsNew } from '@shared/ipc'
import type { AppLogger } from './teamCoordinator'

const CHECK_EVERY_MS = 4 * 60 * 60 * 1000

/** O pedaco do autoUpdater de electron-updater que usamos. */
export interface UpdaterLike {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  autoRunAppAfterInstall: boolean
  on(event: 'update-available' | 'update-downloaded', l: (info: { version: string }) => void): this
  on(event: 'error', l: (error: Error) => void): this
  checkForUpdates(): Promise<unknown>
  quitAndInstall(): void
}

export interface UpdaterOptions {
  autoUpdater: UpdaterLike
  /** app.isPackaged e fora de teste/smoke. Desligado, nao faz nada. */
  enabled: boolean
  emit: (message: IpcEventMessage) => void
  log: AppLogger
}

export function createUpdater({ autoUpdater, enabled, emit, log }: UpdaterOptions) {
  let state: UpdateState = { status: 'idle', version: null }
  let timer: ReturnType<typeof setInterval> | null = null
  const set = (next: UpdateState) => {
    state = next
    emit({ channel: 'update.state', payload: state })
  }
  const check = () =>
    autoUpdater.checkForUpdates().catch((error: unknown) => {
      log.warn('atualização: falha ao procurar versão nova', { error: String(error) })
    })
  return {
    state: (): UpdateState => state,
    start(): void {
      if (!enabled) return
      autoUpdater.autoDownload = true
      autoUpdater.autoInstallOnAppQuit = true
      // No AppImage o app novo abriria antes do antigo sair e esbarraria no lock de instância única.
      autoUpdater.autoRunAppAfterInstall = false
      autoUpdater.on('update-available', (info) =>
        set({ status: 'downloading', version: info.version }),
      )
      autoUpdater.on('update-downloaded', (info) => set({ status: 'ready', version: info.version }))
      autoUpdater.on('error', (error) => {
        log.warn('atualização: erro', { error: error.message })
        // Download que falha não pode deixar o topo em "Baixando" para sempre; o próximo ciclo tenta de novo.
        if (state.status === 'downloading') set({ status: 'idle', version: null })
      })
      void check()
      timer = setInterval(() => void check(), CHECK_EVERY_MS)
    },
    install(): void {
      if (state.status !== 'ready') {
        throw new DomainError('unavailable', 'Não há atualização pronta para instalar.')
      }
      autoUpdater.quitAndInstall()
    },
    dispose(): void {
      if (timer) clearInterval(timer)
      timer = null
    },
  }
}

export interface WhatsNewOptions {
  version: () => string
  /** Texto do CHANGELOG.md, ou null se o arquivo nao existe. */
  readChangelog: () => string | null
  getSeen: () => string | null
  setSeen: (version: string) => void
}

export function createWhatsNew({ version, readChangelog, getSeen, setSeen }: WhatsNewOptions) {
  return {
    get(): WhatsNew | null {
      const current = version()
      if (getSeen() === current) return null
      const text = readChangelog()
      const notes = text === null ? null : changelogSection(text, current)
      return notes === null ? null : { version: current, notes }
    },
    markSeen: (): void => setSeen(version()),
  }
}
