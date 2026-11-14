/**
 * Registro dos Lideres vivos: liga sessionId -> pty e acompanha se o Lider esta
 * trabalhando ou ocioso. E o que o LeaderRelay consulta antes de colar texto.
 *
 * Fontes de estado, da mais forte para a mais fraca:
 *   1. Claude: ganchos (claudeHooks.ts) -> UserPromptSubmit/PreToolUse = trabalhando,
 *      Stop/SessionStart = ocioso. SessionStart tambem confirma o id da sessao.
 *   2. Codex: transcript rollout (~/.codex/sessions), task_started/task_complete.
 *   3. Sem nenhuma das duas: silencio na saida do pty por `quietMs`.
 * Em todos os casos o terminal precisa ter ligado o bracketed paste (ESC[?2004h),
 * sinal de que a TUI esta pronta para receber texto colado.
 *
 * Origem: watchers/SessionTurnStateWatcher.ts e terminal-activity do app antigo, reescrito
 * em escala menor (so o Lider, sem worker).
 */
import type { EpochMs, Provider, SessionId } from '@shared/domain'
import type { PtyExit, PtyHost, Unsubscribe } from '@shared/ports'
import { parseNoticesDelivered, removeClaudeHookFiles, type ClaudeHookPaths } from './claudeHooks'
import { JsonlTail } from './jsonlTail'
import {
  findCodexSessionFile,
  locateProviderSessionId,
  type SessionLocatorDirs,
} from './sessionLocator'
import {
  detectTranscriptTurnState,
  parseClaudeHookRecord,
  stateFromClaudeHook,
  type LeaderTurnSignal,
} from './turnState'

export type LeaderActivity = 'starting' | 'working' | 'idle' | 'exited'

export interface LeaderSessionSnapshot {
  sessionId: SessionId
  ptyId: string
  pid: number
  provider: Provider
  cwd: string
  startedAt: EpochMs
  providerSessionId: string | null
  activity: LeaderActivity
  /** Alguma fonte forte (gancho/transcript) ja informou estado. */
  hasTurnSignal: boolean
  bracketedPaste: boolean
  lastOutputAt: EpochMs
  exit: PtyExit | null
  /** Pasta do gancho (caixa de avisos); null no Codex. */
  claudeHooks: ClaudeHookPaths | null
}

export type LeaderSessionEvent =
  | { type: 'provider-session-id'; sessionId: SessionId; providerSessionId: string }
  | { type: 'activity'; sessionId: SessionId; activity: LeaderActivity }
  | { type: 'exit'; sessionId: SessionId; ptyId: string; exit: PtyExit }
  /** O gancho entregou estes avisos (ids da fila duravel) ao Claude. */
  | { type: 'notices-delivered'; sessionId: SessionId; ids: number[] }

export interface RegisterLeaderInput {
  sessionId: SessionId
  ptyId: string
  pid: number
  provider: Provider
  cwd: string
  startedAt: EpochMs
  /** Id conhecido na abertura (Claude novo: --session-id; retomada: o id retomado). */
  providerSessionId: string | null
  resumed: boolean
  claudeHooks: ClaudeHookPaths | null
}

export interface LeaderSessionRegistry {
  register(input: RegisterLeaderInput): void
  get(sessionId: SessionId): LeaderSessionSnapshot | null
  findByPty(ptyId: string): LeaderSessionSnapshot | null
  /** Pode colar texto agora? (vivo, bracketed paste ligado, ocioso e saida assentada). */
  isReadyForInput(sessionId: SessionId): boolean
  /** O relay acabou de mandar um prompt: considera trabalhando ate a fonte dizer o contrario. */
  markPromptSent(sessionId: SessionId): void
  /** Digitacao do usuario no terminal do Lider: texto sem Enter segura o relay (rascunho). */
  noteUserInput(sessionId: SessionId, data: string): void
  onEvent(listener: (event: LeaderSessionEvent) => void): Unsubscribe
  dispose(): Promise<void>
}

export interface LeaderSessionRegistryOptions {
  ptyHost: PtyHost
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  dirs: SessionLocatorDirs
  /** Sem fonte forte: silencio minimo para considerar ocioso. */
  quietMs?: number
  /** Com fonte forte: silencio minimo depois do sinal ocioso (a TUI termina de desenhar). */
  settleMs?: number
  /** Prompt mandado e nenhuma fonte reagiu neste prazo: volta ao estado anterior. */
  promptAckTimeoutMs?: number
  /** Prazo para achar o rollout de um Codex novo. */
  codexLocateTimeoutMs?: number
  tailPollMs?: number
  requireBracketedPaste?: boolean
  keepHookFiles?: boolean
  log?: (message: string) => void
}

interface Entry {
  input: RegisterLeaderInput
  providerSessionId: string | null
  signal: LeaderTurnSignal | null
  signalSeen: boolean
  lastSignalAt: number
  promptSentAt: number | null
  signalBeforePrompt: LeaderTurnSignal | null
  bracketedPaste: boolean
  escapeTail: string
  lastOutputAt: number
  alive: boolean
  exit: PtyExit | null
  tails: JsonlTail[]
  lastActivity: LeaderActivity
  disposed: boolean
  /** Hora da ultima tecla sem Enter; null sem rascunho. */
  draftAt: number | null
}

/** Rascunho do usuario segura o aviso por este tempo. */
export const USER_DRAFT_HOLD_MS = 20_000

const BRACKETED_ON = '\x1b[?2004h'
const BRACKETED_OFF = '\x1b[?2004l'

export function createLeaderSessionRegistry(
  options: LeaderSessionRegistryOptions,
): LeaderSessionRegistry {
  const now = options.now ?? Date.now
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const quietMs = options.quietMs ?? 1500
  const settleMs = options.settleMs ?? 400
  const promptAckTimeoutMs = options.promptAckTimeoutMs ?? 15_000
  const codexLocateTimeoutMs = options.codexLocateTimeoutMs ?? 60_000
  const tailPollMs = options.tailPollMs ?? 250
  const requireBracketedPaste = options.requireBracketedPaste ?? true
  const log = options.log ?? (() => undefined)

  const bySession = new Map<SessionId, Entry>()
  const byPty = new Map<string, SessionId>()
  const listeners = new Set<(event: LeaderSessionEvent) => void>()

  const emit = (event: LeaderSessionEvent): void => {
    for (const listener of listeners) {
      try {
        listener(event)
      } catch (error) {
        log(`[leader] listener falhou: ${String(error)}`)
      }
    }
  }

  const activityOf = (entry: Entry): LeaderActivity => {
    if (!entry.alive) return 'exited'
    if (entry.signal === null) return 'starting'
    return entry.signal
  }

  const refreshActivity = (entry: Entry): void => {
    const activity = activityOf(entry)
    if (activity === entry.lastActivity) return
    entry.lastActivity = activity
    emit({ type: 'activity', sessionId: entry.input.sessionId, activity })
  }

  const setProviderSessionId = (entry: Entry, id: string): void => {
    if (entry.providerSessionId === id) return
    entry.providerSessionId = id
    emit({ type: 'provider-session-id', sessionId: entry.input.sessionId, providerSessionId: id })
  }

  const applySignal = (entry: Entry, signal: LeaderTurnSignal): void => {
    entry.signal = signal
    entry.signalSeen = true
    entry.lastSignalAt = now()
    entry.promptSentAt = null
    refreshActivity(entry)
  }

  const startTail = (
    entry: Entry,
    filePath: string,
    fromStart: boolean,
    onRecord: (record: unknown) => void,
  ): void => {
    if (entry.disposed || !entry.alive) return
    const tail = new JsonlTail(filePath, onRecord, { pollMs: tailPollMs, fromStart })
    entry.tails.push(tail)
    tail.start()
  }

  const watchClaudeHooks = (entry: Entry, paths: ClaudeHookPaths): void => {
    startTail(entry, paths.events, true, (raw) => {
      const delivered = parseNoticesDelivered(raw)
      if (delivered) {
        emit({ type: 'notices-delivered', sessionId: entry.input.sessionId, ids: delivered })
        return
      }
      const record = parseClaudeHookRecord(raw)
      if (!record) return
      if (record.event === 'SessionStart' && record.sessionId)
        setProviderSessionId(entry, record.sessionId)
      const signal = stateFromClaudeHook(record)
      if (signal) applySignal(entry, signal)
    })
  }

  const watchCodexTranscript = async (entry: Entry): Promise<void> => {
    const input = entry.input
    let id = entry.providerSessionId
    if (!id) {
      id = await locateProviderSessionId(
        {
          provider: 'codex',
          cwd: input.cwd,
          startedAt: input.startedAt,
          timeoutMs: codexLocateTimeoutMs,
        },
        {
          dirs: options.dirs,
          now,
          sleep: (ms) => (entry.alive && !entry.disposed ? sleep(ms) : Promise.resolve()),
        },
      )
      if (!id || !entry.alive || entry.disposed) return
      setProviderSessionId(entry, id)
    }
    const file = await findCodexSessionFile(id, options.dirs)
    if (!file) {
      log(`[leader] rollout do Codex ${id} nao encontrado; usando silencio do terminal`)
      return
    }
    // Retomada: o historico antigo nao diz nada sobre o turno atual.
    startTail(entry, file, !input.resumed, (raw) => {
      const signal = detectTranscriptTurnState('codex', raw)
      if (signal) applySignal(entry, signal)
    })
  }

  const stopEntry = (entry: Entry): void => {
    entry.disposed = true
    for (const tail of entry.tails) tail.stop()
    entry.tails = []
  }

  const unsubscribeData = options.ptyHost.onData((ptyId, data) => {
    const sessionId = byPty.get(ptyId)
    const entry = sessionId ? bySession.get(sessionId) : undefined
    if (!entry || !entry.alive) return
    entry.lastOutputAt = now()
    const scan = entry.escapeTail + data
    const on = scan.lastIndexOf(BRACKETED_ON)
    const off = scan.lastIndexOf(BRACKETED_OFF)
    if (on !== -1 || off !== -1) entry.bracketedPaste = on > off
    entry.escapeTail = scan.slice(-(BRACKETED_ON.length - 1))
  })

  const unsubscribeExit = options.ptyHost.onExit((ptyId, exit) => {
    const sessionId = byPty.get(ptyId)
    const entry = sessionId ? bySession.get(sessionId) : undefined
    if (!entry || !entry.alive) return
    entry.alive = false
    entry.exit = exit
    stopEntry(entry)
    refreshActivity(entry)
    emit({ type: 'exit', sessionId: entry.input.sessionId, ptyId, exit })
    if (entry.input.claudeHooks && !options.keepHookFiles) {
      void removeClaudeHookFiles(entry.input.claudeHooks).catch(() => undefined)
    }
  })

  const snapshot = (entry: Entry): LeaderSessionSnapshot => ({
    sessionId: entry.input.sessionId,
    ptyId: entry.input.ptyId,
    pid: entry.input.pid,
    provider: entry.input.provider,
    cwd: entry.input.cwd,
    startedAt: entry.input.startedAt,
    providerSessionId: entry.providerSessionId,
    activity: activityOf(entry),
    hasTurnSignal: entry.signalSeen,
    bracketedPaste: entry.bracketedPaste,
    lastOutputAt: entry.lastOutputAt,
    exit: entry.exit,
    claudeHooks: entry.input.claudeHooks,
  })

  return {
    register(input) {
      const previous = bySession.get(input.sessionId)
      if (previous) {
        stopEntry(previous)
        byPty.delete(previous.input.ptyId)
      }
      const alive = options.ptyHost.isAlive(input.ptyId)
      const entry: Entry = {
        input,
        providerSessionId: input.providerSessionId,
        signal: null,
        signalSeen: false,
        lastSignalAt: 0,
        promptSentAt: null,
        signalBeforePrompt: null,
        bracketedPaste: false,
        escapeTail: '',
        lastOutputAt: now(),
        alive,
        exit: null,
        tails: [],
        lastActivity: alive ? 'starting' : 'exited',
        disposed: false,
        draftAt: null,
      }
      // A saida que chegou antes do registro tambem conta (bracketed paste ja ligado).
      const early = options.ptyHost.scrollback(input.ptyId)
      if (early) {
        const on = early.lastIndexOf(BRACKETED_ON)
        const off = early.lastIndexOf(BRACKETED_OFF)
        entry.bracketedPaste = on > off
      }
      bySession.set(input.sessionId, entry)
      byPty.set(input.ptyId, input.sessionId)
      if (!alive) return
      if (input.provider === 'claude' && input.claudeHooks)
        watchClaudeHooks(entry, input.claudeHooks)
      if (input.provider === 'codex') {
        void watchCodexTranscript(entry).catch((error) =>
          log(`[leader] transcript do Codex: ${String(error)}`),
        )
      }
    },

    get(sessionId) {
      const entry = bySession.get(sessionId)
      return entry ? snapshot(entry) : null
    },

    findByPty(ptyId) {
      const sessionId = byPty.get(ptyId)
      const entry = sessionId ? bySession.get(sessionId) : undefined
      return entry ? snapshot(entry) : null
    },

    isReadyForInput(sessionId) {
      const entry = bySession.get(sessionId)
      if (!entry || !entry.alive || !options.ptyHost.isAlive(entry.input.ptyId)) return false
      if (requireBracketedPaste && !entry.bracketedPaste) return false
      const current = now()
      // shortcut: rascunho apagado com backspace segura o aviso por até 20 s; texto deixado parado mais que 20 s ainda pode grudar, trocar por leitura da linha de entrada se incomodar
      if (entry.draftAt !== null && current - entry.draftAt < USER_DRAFT_HOLD_MS) return false
      const quiet = current - entry.lastOutputAt
      if (entry.promptSentAt !== null && current - entry.promptSentAt >= promptAckTimeoutMs) {
        // Nenhuma fonte reagiu ao prompt: a TUI provavelmente nao aceitou. Volta ao anterior.
        entry.signal = entry.signalBeforePrompt
        entry.promptSentAt = null
        refreshActivity(entry)
      }
      if (entry.signalSeen) return entry.signal === 'idle' && quiet >= settleMs
      if (entry.promptSentAt !== null) return false
      return quiet >= quietMs
    },

    markPromptSent(sessionId) {
      const entry = bySession.get(sessionId)
      if (!entry || !entry.alive) return
      entry.signalBeforePrompt = entry.signal
      entry.promptSentAt = now()
      entry.lastOutputAt = now()
      if (entry.signalSeen) {
        entry.signal = 'working'
        refreshActivity(entry)
      }
    },

    noteUserInput(sessionId, data) {
      const entry = bySession.get(sessionId)
      if (!entry) return
      if (/[\r\n]/.test(data)) entry.draftAt = null
      else if (data !== '\x1b[I' && data !== '\x1b[O') entry.draftAt = now() // foco do terminal nao e digitacao
    },

    onEvent(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    async dispose() {
      unsubscribeData()
      unsubscribeExit()
      for (const entry of bySession.values()) stopEntry(entry)
      listeners.clear()
    },
  }
}
