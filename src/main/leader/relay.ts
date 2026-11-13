/**
 * LeaderRelay: entrega texto ao terminal do Lider (substitui o TeamTurnRelay).
 *
 * Espera o Lider ficar pronto (LeaderSessionRegistry.isReadyForInput), cola o texto com
 * bracketed paste, espera `submitDelayMs` e manda Enter. Entregas da mesma sessao saem
 * em fila, uma por vez. Enquanto o Lider esta ocupado, tenta de novo a cada `retryDelayMs`
 * ate `maxAttempts`. Sessao desconhecida ou encerrada: { delivered: false }.
 */
import type { SessionId } from '@shared/domain'
import type { LeaderRelay, PtyHost } from '@shared/ports'
import type { LeaderSessionRegistry } from './leaderSessions'

export interface LeaderRelayOptions {
  ptyHost: PtyHost
  registry: LeaderSessionRegistry
  sleep?: (ms: number) => Promise<void>
  /** Intervalo entre verificacoes enquanto o Lider esta ocupado. */
  retryDelayMs?: number
  /** Quantas verificacoes antes de desistir (padrao: 10 min com 1 s). */
  maxAttempts?: number
  /** Pausa entre colar e o Enter (300 ms no app antigo, Claude e Codex). */
  submitDelayMs?: number
}

/** Tira o que poderia sair do bracketed paste ou virar tecla de controle no TUI. */
export function sanitizeRelayText(text: string): string {
  return (
    text
      .replace(/\r\n?/g, '\n')
      // ESC e outros controles (menos \n e \t) nunca entram: o fim do paste e ESC[201~.
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
      .trimEnd()
  )
}

export function createLeaderRelay(options: LeaderRelayOptions): LeaderRelay {
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const retryDelayMs = options.retryDelayMs ?? 1000
  const maxAttempts = options.maxAttempts ?? 600
  const submitDelayMs = options.submitDelayMs ?? 300
  const queues = new Map<SessionId, Promise<unknown>>()

  const alive = (sessionId: SessionId): string | null => {
    const session = options.registry.get(sessionId)
    if (!session || session.activity === 'exited' || !options.ptyHost.isAlive(session.ptyId))
      return null
    return session.ptyId
  }

  const deliverNow = async (
    sessionId: SessionId,
    text: string,
  ): Promise<{ delivered: boolean; attempts: number }> => {
    const clean = sanitizeRelayText(text)
    if (clean.length === 0) return { delivered: false, attempts: 0 }
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const ptyId = alive(sessionId)
      if (!ptyId) return { delivered: false, attempts: attempt - 1 }
      if (options.registry.isReadyForInput(sessionId)) {
        options.ptyHost.write(ptyId, `\x1b[200~${clean}\x1b[201~`)
        options.registry.markPromptSent(sessionId)
        await sleep(submitDelayMs)
        if (!alive(sessionId)) return { delivered: false, attempts: attempt }
        options.ptyHost.write(ptyId, '\r')
        return { delivered: true, attempts: attempt }
      }
      if (attempt < maxAttempts) await sleep(retryDelayMs)
    }
    return { delivered: false, attempts: maxAttempts }
  }

  return {
    deliver(sessionId, text) {
      const previous = queues.get(sessionId) ?? Promise.resolve()
      const next = previous.catch(() => undefined).then(() => deliverNow(sessionId, text))
      queues.set(sessionId, next)
      void next.finally(() => {
        if (queues.get(sessionId) === next) queues.delete(sessionId)
      })
      return next
    },
  }
}
