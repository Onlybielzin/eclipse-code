/**
 * PtyHost sobre node-pty, no proprio processo main.
 *
 * Origem: platform/process/ptyHost do app antigo, sem worker remoto, sem utilityProcess,
 * sem a parte de Windows. O que ficou: spawn com ambiente limpo, ring buffer de saida,
 * encerramento do grupo de processos (SIGHUP -> SIGKILL apos prazo) e contagem de vivos.
 *
 * Invariantes:
 *   - liveCount() conta so pty cujo processo ainda nao saiu (fonte do limite de agentes).
 *   - onExit dispara uma unica vez por pty, depois de isAlive() ja ser false.
 *   - scrollback() continua legivel depois da saida (ate o pty ser podado).
 */
import { randomUUID } from 'node:crypto'
import { constants as osConstants } from 'node:os'
import * as nodePty from 'node-pty'
import { DomainError } from '@shared/domain'
import type { PtyExit, PtyHost, PtyProcessInfo, PtySpawnOptions, Unsubscribe } from '@shared/ports'
import { ScrollbackBuffer, DEFAULT_SCROLLBACK_CHARS } from './scrollback'
import { resolvePtySpawnEnv } from './spawnEnv'
import { ensureNodePtySpawnHelperExecutable } from './spawnHelperPermissions'

type KillSignal = 'SIGTERM' | 'SIGKILL' | 'SIGHUP' | 'SIGINT'

/** Subconjunto de IPty que o host usa (permite pty falso nos testes). */
export interface PtyProcessLike {
  readonly pid: number
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
  onData(listener: (data: string) => void): { dispose(): void }
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void }
}

export type SpawnPty = (
  file: string,
  args: string[],
  options: {
    name: string
    cwd: string
    env: Record<string, string>
    cols: number
    rows: number
  },
) => PtyProcessLike

export interface PtyHostOptions {
  spawnPty?: SpawnPty
  scrollbackChars?: number
  /** Depois do kill, quanto esperar antes de mandar SIGKILL ao grupo. */
  killGraceMs?: number
  /** Prazo total do dispose antes de desistir de esperar as saidas. */
  disposeTimeoutMs?: number
  /** Quantos pty ja encerrados manter para scrollback/size. */
  retainExited?: number
  newId?: () => string
  /** Sinal ao grupo de processos (-pid). Injetavel para teste. */
  signalGroup?: (pid: number, signal: KillSignal) => boolean
  log?: (message: string) => void
  /** Injetavel para teste. Padrao: process.platform. */
  platform?: NodeJS.Platform
}

interface Entry {
  ptyId: string
  pid: number
  label: string | null
  pty: PtyProcessLike
  scrollback: ScrollbackBuffer
  cols: number
  rows: number
  alive: boolean
  exit: PtyExit | null
  exited: Promise<void>
  markExited: () => void
  escalation: NodeJS.Timeout | null
  disposers: Array<{ dispose(): void }>
}

const DEFAULT_KILL_GRACE_MS = 3000
const DEFAULT_DISPOSE_TIMEOUT_MS = 5000
const DEFAULT_RETAIN_EXITED = 64

function defaultSignalGroup(pid: number, signal: KillSignal): boolean {
  if (process.platform === 'win32' || pid <= 0) return false
  try {
    // node-pty abre o filho com setsid: pid == id do grupo. Assim o MCP stdio e os
    // netos do agente tambem recebem o sinal.
    process.kill(-pid, signal)
    return true
  } catch {
    return false
  }
}

const SIGNAL_NAMES = new Map<number, string>(
  Object.entries(osConstants.signals).map(([name, value]) => [value, name]),
)

export function toPtyExit(event: { exitCode: number; signal?: number }): PtyExit {
  if (typeof event.signal === 'number' && event.signal > 0) {
    return { exitCode: null, signal: SIGNAL_NAMES.get(event.signal) ?? `SIG${event.signal}` }
  }
  return { exitCode: Number.isFinite(event.exitCode) ? event.exitCode : null, signal: null }
}

function clampDimension(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(Math.max(Math.floor(value), 1), 2000)
}

export function createPtyHost(options: PtyHostOptions = {}): PtyHost {
  const spawnPty: SpawnPty =
    options.spawnPty ?? ((file, args, opts) => nodePty.spawn(file, args, opts))
  const scrollbackChars = options.scrollbackChars ?? DEFAULT_SCROLLBACK_CHARS
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS
  const disposeTimeoutMs = options.disposeTimeoutMs ?? DEFAULT_DISPOSE_TIMEOUT_MS
  const retainExited = options.retainExited ?? DEFAULT_RETAIN_EXITED
  const newId = options.newId ?? (() => randomUUID())
  const signalGroup = options.signalGroup ?? defaultSignalGroup
  const log = options.log ?? (() => undefined)
  const isWindows = (options.platform ?? process.platform) === 'win32'

  const entries = new Map<string, Entry>()
  const exitedOrder: string[] = []
  const dataListeners = new Set<(ptyId: string, data: string) => void>()
  const exitListeners = new Set<(ptyId: string, exit: PtyExit) => void>()
  let helperChecked = false
  let disposed = false

  const emitData = (ptyId: string, data: string): void => {
    for (const listener of dataListeners) {
      try {
        listener(ptyId, data)
      } catch (error) {
        log(`[pty] listener de dados falhou: ${String(error)}`)
      }
    }
  }

  const emitExit = (ptyId: string, exit: PtyExit): void => {
    for (const listener of exitListeners) {
      try {
        listener(ptyId, exit)
      } catch (error) {
        log(`[pty] listener de saida falhou: ${String(error)}`)
      }
    }
  }

  const pruneExited = (): void => {
    while (exitedOrder.length > retainExited) {
      const oldest = exitedOrder.shift()
      if (oldest) entries.delete(oldest)
    }
  }

  const sendSignal = (entry: Entry, signal: KillSignal): void => {
    if (!entry.alive) return
    if (!signalGroup(entry.pid, signal)) {
      try {
        // node-pty no Windows lanca 'Signals not supported' se kill() recebe sinal.
        if (isWindows) entry.pty.kill()
        else entry.pty.kill(signal)
      } catch (error) {
        log(`[pty] kill ${signal} falhou em ${entry.ptyId}: ${String(error)}`)
      }
    }
  }

  const host: PtyHost = {
    async spawn(spawnOptions: PtySpawnOptions): Promise<PtyProcessInfo> {
      if (disposed)
        throw new DomainError('unavailable', 'O hospedeiro de terminais já foi encerrado.')
      if (!helperChecked && !options.spawnPty) {
        helperChecked = true
        ensureNodePtySpawnHelperExecutable()
      }
      const cols = clampDimension(spawnOptions.cols, 80)
      const rows = clampDimension(spawnOptions.rows, 24)
      let pty: PtyProcessLike
      try {
        pty = spawnPty(spawnOptions.command, spawnOptions.args, {
          name: 'xterm-256color',
          cwd: spawnOptions.cwd,
          env: resolvePtySpawnEnv(spawnOptions.env),
          cols,
          rows,
        })
      } catch (error) {
        throw new DomainError(
          'unavailable',
          `Não foi possível abrir o terminal (${spawnOptions.command}): ${error instanceof Error ? error.message : String(error)}`,
          { command: spawnOptions.command, cwd: spawnOptions.cwd },
        )
      }
      const ptyId = newId()
      let markExited: () => void = () => undefined
      const exited = new Promise<void>((resolve) => {
        markExited = resolve
      })
      const entry: Entry = {
        ptyId,
        pid: pty.pid,
        label: spawnOptions.label ?? null,
        pty,
        scrollback: new ScrollbackBuffer(scrollbackChars),
        cols,
        rows,
        alive: true,
        exit: null,
        exited,
        markExited,
        escalation: null,
        disposers: [],
      }
      entries.set(ptyId, entry)
      entry.disposers.push(
        pty.onData((data) => {
          entry.scrollback.append(data)
          emitData(ptyId, data)
        }),
      )
      entry.disposers.push(
        pty.onExit((event) => {
          if (!entry.alive) return
          entry.alive = false
          entry.exit = toPtyExit(event)
          // A escalada de um kill() continua: netos do grupo que ignoram o sinal ainda
          // precisam do SIGKILL, mesmo com o processo principal ja encerrado.
          exitedOrder.push(ptyId)
          entry.markExited()
          emitExit(ptyId, entry.exit)
          // Os disposers do node-pty sao liberados depois do evento, fora da pilha dele.
          setImmediate(() => {
            for (const disposer of entry.disposers) {
              try {
                disposer.dispose()
              } catch {
                // nada a fazer
              }
            }
            entry.disposers = []
          })
          pruneExited()
        }),
      )
      log(`[pty] aberto ${ptyId} pid=${pty.pid} ${entry.label ?? spawnOptions.command}`)
      return { ptyId, pid: pty.pid }
    },

    write(ptyId, data) {
      const entry = entries.get(ptyId)
      if (!entry || !entry.alive || data.length === 0) return
      entry.pty.write(data)
    },

    resize(ptyId, cols, rows) {
      const entry = entries.get(ptyId)
      if (!entry || !entry.alive) return
      const nextCols = clampDimension(cols, entry.cols)
      const nextRows = clampDimension(rows, entry.rows)
      if (nextCols === entry.cols && nextRows === entry.rows) return
      try {
        entry.pty.resize(nextCols, nextRows)
        entry.cols = nextCols
        entry.rows = nextRows
      } catch (error) {
        log(`[pty] resize falhou em ${ptyId}: ${String(error)}`)
      }
    },

    kill(ptyId, signal = 'SIGHUP') {
      const entry = entries.get(ptyId)
      if (!entry || !entry.alive) return
      sendSignal(entry, signal)
      if (signal !== 'SIGKILL' && !entry.escalation) {
        entry.escalation = setTimeout(() => {
          entry.escalation = null
          // Sempre no grupo, vivo ou nao o processo principal (ESRCH com grupo vazio).
          if (entry.alive) sendSignal(entry, 'SIGKILL')
          else signalGroup(entry.pid, 'SIGKILL')
        }, killGraceMs)
        entry.escalation.unref?.()
      }
    },

    onData(listener) {
      dataListeners.add(listener)
      return () => {
        dataListeners.delete(listener)
      }
    },

    onExit(listener) {
      exitListeners.add(listener)
      return () => {
        exitListeners.delete(listener)
      }
    },

    scrollback(ptyId) {
      return entries.get(ptyId)?.scrollback.toString() ?? ''
    },

    size(ptyId) {
      const entry = entries.get(ptyId)
      return entry ? { cols: entry.cols, rows: entry.rows } : null
    },

    isAlive(ptyId) {
      return entries.get(ptyId)?.alive === true
    },

    liveCount() {
      let count = 0
      for (const entry of entries.values()) if (entry.alive) count += 1
      return count
    },

    async dispose() {
      if (disposed) return
      disposed = true
      const alive = [...entries.values()].filter((entry) => entry.alive)
      for (const entry of alive) host.kill(entry.ptyId, 'SIGHUP')
      const allExited = Promise.all(alive.map((entry) => entry.exited))
      const timedOut = await Promise.race([
        allExited.then(() => false),
        new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(true), disposeTimeoutMs)
          timer.unref?.()
        }),
      ])
      if (timedOut) {
        for (const entry of alive) sendSignal(entry, 'SIGKILL')
      }
      for (const entry of entries.values()) {
        if (!entry.escalation) continue
        clearTimeout(entry.escalation)
        entry.escalation = null
        // O app vai fechar: quem sobrou no grupo de um pty encerrado nao espera o prazo.
        if (!entry.alive) signalGroup(entry.pid, 'SIGKILL')
      }
      dataListeners.clear()
      exitListeners.clear()
    },
  }
  return host
}

/** Exposto para quem precisa esperar uma saida especifica (testes, shutdown). */
export function waitForPtyExit(
  host: PtyHost,
  ptyId: string,
  timeoutMs: number,
): Promise<PtyExit | null> {
  return new Promise((resolve) => {
    if (!host.isAlive(ptyId)) {
      resolve(null)
      return
    }
    const timer = setTimeout(() => {
      stop()
      resolve(null)
    }, timeoutMs)
    const stop: Unsubscribe = host.onExit((id, exit) => {
      if (id !== ptyId) return
      clearTimeout(timer)
      stop()
      resolve(exit)
    })
  })
}
