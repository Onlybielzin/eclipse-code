/**
 * Avisos rapidos ao usuario (ferramenta avisar e tarefa_concluir). O main monta o aviso,
 * guarda os ultimos em memoria e publica ao renderer; sem foco na janela, mostra tambem a
 * notificacao do sistema (porta SystemNotifier, o Electron entra so no index.ts).
 */
import { randomUUID } from 'node:crypto'
import type { IpcEventMessage, UserNotice } from '@shared/ipc'

// shortcut: so os ultimos 20 avisos, em memoria (somem ao fechar o app); sobe para SQLite se o vings quiser historico.
const MAX_RECENT_NOTICES = 20

export interface SystemNotifier {
  isSupported(): boolean
  isWindowFocused(): boolean
  focusWindow(): void
  /** Mostra a notificacao; onClick roda quando o usuario clica nela. */
  show(title: string, body: string, onClick: () => void): void
}

export interface UserAlertsDeps {
  /** Tarefa e projeto do aviso. Lanca se a tarefa nao existe. */
  lookup(taskId: string): Omit<UserNotice, 'id' | 'text' | 'createdAt'>
  emit(message: IpcEventMessage): void
  notifier: SystemNotifier
  now?: () => number
  newId?: () => string
}

export interface UserAlerts {
  publish(taskId: string, text: string): void
  recent(): UserNotice[]
}

export function createUserAlerts(deps: UserAlertsDeps): UserAlerts {
  const recent: UserNotice[] = []
  const now = deps.now ?? Date.now
  const newId = deps.newId ?? randomUUID
  return {
    publish(taskId, text) {
      // O aviso e acessorio: falhar aqui nunca derruba a ferramenta que o chamou.
      try {
        const notice: UserNotice = {
          ...deps.lookup(taskId),
          id: newId(),
          text,
          createdAt: now(),
        }
        recent.push(notice)
        if (recent.length > MAX_RECENT_NOTICES) recent.shift()
        deps.emit({ channel: 'notice.created', payload: notice })
        const { notifier } = deps
        if (notifier.isSupported() && !notifier.isWindowFocused()) {
          notifier.show(`${notice.projectName}: ${notice.taskName}`, text, () => {
            notifier.focusWindow()
            deps.emit({
              channel: 'notice.open',
              payload: { taskId: notice.taskId, projectId: notice.projectId },
            })
          })
        }
      } catch {
        // tarefa removida ou notificacao recusada pelo sistema
      }
    },
    recent: () => [...recent],
  }
}
