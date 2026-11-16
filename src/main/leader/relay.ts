/**
 * LeaderRelay: entrega texto ao terminal do Lider (substitui o TeamTurnRelay).
 *
 * Espera o Lider ficar pronto (LeaderSessionRegistry.isReadyForInput), cola o texto com
 * bracketed paste, espera `submitDelayMs` e manda Enter. Entregas da mesma sessao saem
 * em fila, uma por vez. `offer` entrega ao Lider Claude so pela caixa do gancho (inbox.ts),
 * em qualquer atividade; `wake` cola so uma linha para acordar o Lider ocioso; so o Codex (sem gancho) recebe colagem. Ver LeaderRelay em
 * src/shared/ports.ts. Enquanto o Lider esta ocupado, tenta de novo a cada `retryDelayMs`
 * ate `maxAttempts`. Sessao desconhecida ou encerrada: { delivered: false }.
 */
import type { SessionId } from '@shared/domain'
import type { LeaderRelay, PtyHost } from '@shared/ports'
import { claimInbox, fitInbox, writeInbox, type InboxNotice } from './inbox'
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
  now?: () => number
  /** Aviso na caixa que ninguem confirmou neste prazo volta a ser oferecido (gancho morto no meio). */
  inFlightTtlMs?: number
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

/** Linha que acorda o Lider Claude ocioso; o gancho UserPromptSubmit leva o conteudo da caixa. */
export const WAKE_TEXT = '[eclipse] Chegou aviso novo.'

export function createLeaderRelay(options: LeaderRelayOptions): LeaderRelay {
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const retryDelayMs = options.retryDelayMs ?? 1000
  const maxAttempts = options.maxAttempts ?? 600
  const submitDelayMs = options.submitDelayMs ?? 300
  const now = options.now ?? Date.now
  const inFlightTtlMs = options.inFlightTtlMs ?? 60_000
  const queues = new Map<SessionId, Promise<unknown>>()
  // Avisos ja gravados na caixa (ou levados pelo gancho) sem notices-delivered: id -> hora.
  const inFlight = new Map<SessionId, Map<number, number>>()

  options.registry.onEvent((event) => {
    if (event.type !== 'notices-delivered') return
    for (const id of event.ids) inFlight.get(event.sessionId)?.delete(id)
  })

  const offerNow = async (
    sessionId: SessionId,
    notices: readonly InboxNotice[],
  ): Promise<InboxNotice[]> => {
    const session = options.registry.get(sessionId)
    const hooks = session?.claudeHooks
    if (!session || !hooks) return [...notices]
    const flying = inFlight.get(sessionId) ?? new Map<number, number>()
    inFlight.set(sessionId, flying)
    const boxed = await claimInbox(hooks)
    // Aviso descartado enquanto estava na caixa (subtarefa ja vista) nao vale mais.
    const pendingIds = new Set(notices.map((n) => n.id))
    const stale = boxed.filter((n) => !pendingIds.has(n.id))
    for (const n of stale) flying.delete(n.id)
    boxed.splice(0, boxed.length, ...boxed.filter((n) => pendingIds.has(n.id)))
    const boxedIds = new Set(boxed.map((n) => n.id))
    for (const [id, at] of flying) {
      if (!boxedIds.has(id) && now() - at >= inFlightTtlMs) flying.delete(id)
    }
    const fresh = notices.filter((n) => !boxedIds.has(n.id) && !flying.has(n.id))
    if (session.activity !== 'exited') {
      const next = fitInbox([...boxed, ...fresh])
      try {
        await writeInbox(hooks, next)
      } catch (error) {
        // Caixa nao gravada: o que foi reivindicado volta a ser oferecido na proxima rodada.
        for (const n of boxed) flying.delete(n.id)
        throw error
      }
      for (const n of next) flying.set(n.id, flying.get(n.id) ?? now())
      return []
    }
    // Sessao encerrada: nada a gravar; o que estava na caixa volta a ser oferecido na proxima abertura.
    for (const n of boxed) flying.delete(n.id)
    return notices.filter((n) => !flying.has(n.id))
  }

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

  const wakeNow = async (sessionId: SessionId): Promise<boolean> => {
    const ptyId = alive(sessionId)
    if (!ptyId || !options.registry.get(sessionId)?.claudeHooks) return false
    if (!options.registry.isReadyForInput(sessionId)) return false
    options.ptyHost.write(ptyId, `\x1b[200~${WAKE_TEXT}\x1b[201~`)
    options.registry.markPromptSent(sessionId)
    await sleep(submitDelayMs)
    if (!alive(sessionId)) return false
    options.ptyHost.write(ptyId, '\r')
    return true
  }

  return {
    wake(sessionId) {
      const previous = queues.get(sessionId) ?? Promise.resolve()
      const next = previous.catch(() => undefined).then(() => wakeNow(sessionId))
      queues.set(sessionId, next)
      void next.finally(() => {
        if (queues.get(sessionId) === next) queues.delete(sessionId)
      })
      return next
    },
    // Sem fila propria: o TeamTurnRelay chama uma vez por vez por tarefa.
    offer: offerNow,
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
