import type { SessionId } from '@shared/domain'
import type { Clock, LeaderRelay, PtyHost, Unsubscribe } from '@shared/ports'

const BRACKETED_ON = '\x1b[?2004h'
const BRACKETED_OFF = '\x1b[?2004l'
const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'

export interface PtyLeaderRelayOptions {
  pty: PtyHost
  /** pty vivo do Lider desta sessao, ou null se o Lider nao esta aberto. */
  resolvePty(sessionId: SessionId): string | null
  clock?: Clock
  sleep?: (ms: number) => Promise<void>
  /** Sem saida nem digitacao por este tempo = Lider ocioso. */
  quietMs?: number
  /** Pausa entre colar e apertar Enter (o TUI precisa processar a colagem). */
  submitDelayMs?: number
  /** Intervalo entre conferencias enquanto o Lider esta ocupado. */
  pollMs?: number
  /** Desiste depois deste tempo esperando o Lider ficar ocioso. */
  maxWaitMs?: number
}

export interface PtyLeaderRelay extends LeaderRelay {
  /** A tela digitou no terminal: conta como atividade (nao colar por cima do usuario). */
  noteInput(ptyId: string): void
  dispose(): void
}

/** Ultimo modo de colagem visto num trecho de saida, ou null se nao apareceu. */
export function lastBracketedPasteMode(output: string): boolean | null {
  const on = output.lastIndexOf(BRACKETED_ON)
  const off = output.lastIndexOf(BRACKETED_OFF)
  if (on === -1 && off === -1) return null
  return on > off
}

/**
 * Escreve no terminal do Lider de forma segura, como o PromptDeliveryService do app
 * antigo, sem os ganchos: so cola quando o Lider esta ocioso (sem saida e sem
 * digitacao por quietMs) e com colagem entre colchetes ligada; cola o texto, espera
 * submitDelayMs, confere de novo e so entao manda Enter. Um envio por sessao de cada vez.
 */
export function createPtyLeaderRelay(options: PtyLeaderRelayOptions): PtyLeaderRelay {
  const clock = options.clock ?? { now: () => Date.now() }
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const quietMs = options.quietMs ?? 1_500
  const submitDelayMs = options.submitDelayMs ?? 150
  const pollMs = options.pollMs ?? 500
  const maxWaitMs = options.maxWaitMs ?? 10 * 60_000
  const createdAt = clock.now()

  const lastActivity = new Map<string, number>()
  const bracketed = new Map<string, boolean>()
  const tails = new Map<string, string>()
  const chains = new Map<SessionId, Promise<unknown>>()
  let disposed = false

  const stopData: Unsubscribe = options.pty.onData((ptyId, data) => {
    lastActivity.set(ptyId, clock.now())
    // Junta o fim do pedaco anterior: a sequencia pode vir partida entre dois eventos.
    const joined = (tails.get(ptyId) ?? '') + data
    const mode = lastBracketedPasteMode(joined)
    if (mode !== null) bracketed.set(ptyId, mode)
    tails.set(ptyId, joined.slice(-(BRACKETED_ON.length - 1)))
  })
  const stopExit: Unsubscribe = options.pty.onExit((ptyId) => {
    lastActivity.delete(ptyId)
    bracketed.delete(ptyId)
    tails.delete(ptyId)
  })

  const pasteMode = (ptyId: string): boolean => {
    const known = bracketed.get(ptyId)
    if (known !== undefined) return known
    const fromScrollback = lastBracketedPasteMode(options.pty.scrollback(ptyId))
    if (fromScrollback !== null) bracketed.set(ptyId, fromScrollback)
    return fromScrollback ?? false
  }

  const isIdle = (ptyId: string): boolean =>
    clock.now() - (lastActivity.get(ptyId) ?? createdAt) >= quietMs && pasteMode(ptyId)

  const attempt = async (
    sessionId: SessionId,
    text: string,
  ): Promise<{ delivered: boolean; attempts: number }> => {
    const deadline = clock.now() + maxWaitMs
    let attempts = 0
    for (;;) {
      if (disposed) return { delivered: false, attempts }
      const ptyId = options.resolvePty(sessionId)
      if (!ptyId || !options.pty.isAlive(ptyId)) return { delivered: false, attempts }
      attempts++
      if (isIdle(ptyId)) {
        options.pty.write(ptyId, `${PASTE_START}${text}${PASTE_END}`)
        await sleep(submitDelayMs)
        // Conferir de novo antes do Enter: o processo pode ter saido ou trocado.
        if (disposed || options.resolvePty(sessionId) !== ptyId || !options.pty.isAlive(ptyId)) {
          return { delivered: false, attempts }
        }
        options.pty.write(ptyId, '\r')
        lastActivity.set(ptyId, clock.now())
        return { delivered: true, attempts }
      }
      if (clock.now() >= deadline) return { delivered: false, attempts }
      await sleep(pollMs)
    }
  }

  return {
    deliver(sessionId, text) {
      // Um envio de cada vez por sessao: dois avisos nunca se misturam na mesma colagem.
      const previous = chains.get(sessionId) ?? Promise.resolve()
      const next = previous.catch(() => undefined).then(() => attempt(sessionId, text))
      chains.set(sessionId, next)
      void next.finally(() => {
        if (chains.get(sessionId) === next) chains.delete(sessionId)
      })
      return next
    },
    noteInput(ptyId) {
      lastActivity.set(ptyId, clock.now())
    },
    dispose() {
      disposed = true
      stopData()
      stopExit()
    },
  }
}
