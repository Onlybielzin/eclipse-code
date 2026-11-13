/**
 * MemberRuntime sobre o Agent Client Protocol (@agentclientprotocol/sdk).
 *
 * Um processo de adaptador ACP (claude-agent-acp ou codex-acp) por sessao de membro, com
 * cwd na worktree da tarefa. Conversa por NDJSON no stdin/stdout do processo.
 *
 * Ciclo de um turno:
 *   prompt() -> evento 'prompt' -> session/prompt
 *     cada session/update -> ActivityEventDraft (onActivity) e zera o vigia de silencio
 *     resposta do session/prompt (stopReason) -> fim do turno
 *     processo morreu        -> erro 'process_exited'
 *     sem session/update     -> erro 'silent_timeout' (session/cancel em seguida)
 *     tempo maximo estourou  -> erro 'turn_timeout'   (session/cancel em seguida)
 *     close()                -> erro 'session_closed'
 *   Sempre termina com um evento 'turn_end' e a promessa sempre resolve.
 *
 * Invariantes:
 *   I1. No maximo um turno ativo por sessao; o segundo prompt simultaneo rejeita 'conflict'.
 *   I2. Cada turno resolve exatamente uma vez (o primeiro fim vence; os outros sao ignorados).
 *   I3. Depois de um cancelamento (pedido ou por vigia), se o agente nao responder em
 *       `cancelGraceMs`, o processo e morto: nunca fica um agente rodando sem dono.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type Client,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from '@agentclientprotocol/sdk'
import { ENV } from '@shared/app'
import {
  DomainError,
  STOP_REASONS,
  type ActivityEventDraft,
  type SessionId,
  type StopReason,
  type TurnError,
  type TurnErrorCode,
  type TurnId,
  type TurnOutcome,
  type TurnResult,
} from '@shared/domain'
import type {
  MemberRuntime,
  MemberRuntimeDeps,
  MemberSessionHandle,
  MemberSessionStart,
  PtyExit,
  Unsubscribe,
} from '@shared/ports'
import {
  buildAgentCommand,
  buildSessionMeta,
  toAcpMcpServer,
  type AgentCommand,
} from './agentCommand'
import { PARENT_AGENT_SESSION_ENV_KEYS } from '../terminal/spawnEnv'
import { decidePermission } from './permissionPolicy'
import { TurnActivity } from './turnActivity'

export interface AcpRuntimeLogger {
  info(message: string, meta?: Record<string, unknown>): void
  warn(message: string, meta?: Record<string, unknown>): void
}

export interface AcpMemberRuntimeOptions {
  /** Troca o comando do agente (testes usam o agente falso). */
  resolveCommand?: (request: MemberSessionStart) => AgentCommand
  /** initialize + session/new|load. Padrao 90 s. */
  startTimeoutMs?: number
  /** Espera pela resposta ao session/cancel antes de matar o processo. Padrao 5 s. */
  cancelGraceMs?: number
  /** SIGTERM -> SIGKILL. Padrao 3 s. */
  killGraceMs?: number
  /** Fecha um bloco de texto este tempo depois do primeiro pedaco. Padrao 400 ms. */
  textFlushMs?: number
  /** Raizes alem da worktree onde o membro pode mexer sem perguntar. */
  extraAllowedRoots?: readonly string[]
  logger?: AcpRuntimeLogger
}

interface ActiveTurn {
  turnId: TurnId
  startedAt: number
  activity: TurnActivity
  settled: boolean
  cancelRequested: boolean
  turnTimer: ReturnType<typeof setTimeout> | null
  silenceTimer: ReturnType<typeof setTimeout> | null
  finish(outcome: TurnOutcome): void
}

interface MemberSession {
  id: SessionId
  request: MemberSessionStart
  child: ChildProcess
  connection: ClientSideConnection
  providerSessionId: string | null
  alive: boolean
  closing: boolean
  exit: PtyExit | null
  exited: Promise<PtyExit>
  stderrTail: string
  active: ActiveTurn | null
  /** Pedido session/prompt ainda sem resposta (inclusive de turno ja encerrado por vigia). */
  inflight: Promise<unknown> | null
}

const STDERR_TAIL_CHARS = 4_000
const noopLogger: AcpRuntimeLogger = { info: () => {}, warn: () => {} }

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object' && 'message' in error) return String(error.message)
  return String(error)
}

function isStopReason(value: unknown): value is StopReason {
  return typeof value === 'string' && (STOP_REASONS as readonly string[]).includes(value)
}

const ERROR_TEXT: Record<TurnErrorCode, string> = {
  process_exited: 'O processo do membro terminou no meio do turno.',
  silent_timeout: 'O membro ficou sem responder por tempo demais.',
  turn_timeout: 'O turno passou do tempo máximo.',
  session_closed: 'A sessão do membro foi fechada.',
  spawn_failed: 'Não foi possível abrir o membro.',
  protocol_error: 'Erro de protocolo ACP.',
}

export class AcpMemberRuntime implements MemberRuntime {
  private readonly sessions = new Map<SessionId, MemberSession>()
  private readonly activityListeners = new Set<(draft: ActivityEventDraft) => void>()
  private readonly exitListeners = new Set<(sessionId: SessionId, exit: PtyExit) => void>()
  private readonly resolveCommand: (request: MemberSessionStart) => AgentCommand
  private readonly startTimeoutMs: number
  private readonly cancelGraceMs: number
  private readonly killGraceMs: number
  private readonly textFlushMs: number
  private readonly extraAllowedRoots: readonly string[]
  private readonly logger: AcpRuntimeLogger

  constructor(
    private readonly deps: MemberRuntimeDeps,
    options: AcpMemberRuntimeOptions = {},
  ) {
    this.resolveCommand = options.resolveCommand ?? ((request) => buildAgentCommand(request))
    this.startTimeoutMs = options.startTimeoutMs ?? 90_000
    this.cancelGraceMs = options.cancelGraceMs ?? 5_000
    this.killGraceMs = options.killGraceMs ?? 3_000
    this.textFlushMs = options.textFlushMs ?? 400
    this.extraAllowedRoots = options.extraAllowedRoots ?? []
    this.logger = options.logger ?? noopLogger
  }

  // -------------------------------------------------------------------------
  // Sessao
  // -------------------------------------------------------------------------

  async startSession(request: MemberSessionStart): Promise<MemberSessionHandle> {
    if (this.sessions.has(request.sessionId)) {
      throw new DomainError('conflict', `Sessão ${request.sessionId} já está aberta.`)
    }
    const command = this.resolveCommand(request)
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) env[key] = value
    }
    // Marcas da sessao Claude que abriu o app: o membro nao e sessao aninhada dela.
    for (const key of PARENT_AGENT_SESSION_ENV_KEYS) delete env[key]
    Object.assign(env, command.env, request.env, { [ENV.marker]: '1' })

    let child: ChildProcess
    try {
      child = spawn(command.command, command.args, {
        cwd: request.cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        // Grupo proprio: matar o grupo leva junto o claude/codex que o adaptador abre.
        detached: process.platform !== 'win32',
      })
    } catch (error) {
      throw new DomainError(
        'unavailable',
        `Não foi possível abrir o membro: ${errorMessage(error)}`,
      )
    }

    let resolveExited!: (exit: PtyExit) => void
    const exited = new Promise<PtyExit>((resolve) => {
      resolveExited = resolve
    })
    let spawnError: Error | null = null
    child.on('error', (error) => {
      spawnError = error
      this.logger.warn('acp: erro no processo do membro', {
        sessionId: request.sessionId,
        error: error.message,
      })
      // Sem 'exit' quando o spawn falha (ENOENT): fecha por aqui.
      if (child.pid === undefined) handleExit(null, null)
    })
    // Escrever num processo morto gera EPIPE no stdin; o fim do turno vem pelo 'exit'.
    child.stdin?.on('error', () => {})

    const client: Client = {
      sessionUpdate: (params) => this.onSessionUpdate(session, params),
      requestPermission: (params) => this.onRequestPermission(session, params),
    }
    const stream = ndJsonStream(
      Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
    )
    const connection = new ClientSideConnection(() => client, stream)

    const session: MemberSession = {
      id: request.sessionId,
      request,
      child,
      connection,
      providerSessionId: null,
      alive: true,
      closing: false,
      exit: null,
      exited,
      stderrTail: '',
      active: null,
      inflight: null,
    }
    this.sessions.set(request.sessionId, session)

    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      session.stderrTail = (session.stderrTail + chunk).slice(-STDERR_TAIL_CHARS)
    })

    const handleExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (session.exit) return
      const exit: PtyExit = { exitCode: code, signal }
      session.exit = exit
      session.alive = false
      const turn = session.active
      if (turn) {
        turn.finish({
          kind: 'error',
          error: this.turnError(session, session.closing ? 'session_closed' : 'process_exited'),
        })
      }
      resolveExited(exit)
      for (const listener of this.exitListeners) {
        try {
          listener(session.id, exit)
        } catch (error) {
          this.logger.warn('acp: ouvinte de saída falhou', { error: errorMessage(error) })
        }
      }
    }
    child.once('exit', handleExit)

    try {
      const providerSessionId = await this.raceStart(
        session,
        async () => {
          const init = await connection.initialize({
            protocolVersion: PROTOCOL_VERSION,
            clientCapabilities: {
              fs: { readTextFile: false, writeTextFile: false },
              terminal: false,
            },
            clientInfo: { name: 'eclipse-code-next', version: '0.1.0' },
          })
          const mcpServers = [toAcpMcpServer(request.mcpServer)]
          const meta = buildSessionMeta(request)
          if (request.resumeProviderSessionId) {
            if (!init.agentCapabilities?.loadSession) {
              throw new DomainError(
                'unavailable',
                'Este agente não sabe retomar sessão (session/load).',
              )
            }
            await connection.loadSession({
              sessionId: request.resumeProviderSessionId,
              cwd: request.cwd,
              mcpServers,
              ...(meta ? { _meta: meta } : {}),
            })
            return request.resumeProviderSessionId
          }
          const created = await connection.newSession({
            cwd: request.cwd,
            mcpServers,
            ...(meta ? { _meta: meta } : {}),
          })
          return created.sessionId
        },
        () => spawnError,
      )
      session.providerSessionId = providerSessionId
      this.logger.info('acp: membro aberto', {
        sessionId: session.id,
        provider: request.provider,
        pid: child.pid ?? null,
      })
      return { sessionId: session.id, providerSessionId, pid: child.pid ?? null }
    } catch (error) {
      await this.terminate(session)
      this.sessions.delete(session.id)
      if (error instanceof DomainError) throw error
      throw new DomainError(
        'unavailable',
        `Não foi possível abrir o membro: ${errorMessage(error)}`,
        {
          stderr: session.stderrTail.slice(-1_000),
        },
      )
    }
  }

  private async raceStart<T>(
    session: MemberSession,
    work: () => Promise<T>,
    spawnError: () => Error | null,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | null = null
    try {
      return await Promise.race([
        work(),
        session.exited.then((exit) => {
          const cause = spawnError()
          throw new Error(
            cause
              ? cause.message
              : `o processo saiu na partida (código ${exit.exitCode ?? '-'}, sinal ${exit.signal ?? '-'})`,
          )
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`sem resposta em ${this.startTimeoutMs} ms na partida`)),
            this.startTimeoutMs,
          )
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  // -------------------------------------------------------------------------
  // Turno
  // -------------------------------------------------------------------------

  async prompt(sessionId: SessionId, input: { turnId: TurnId; text: string }): Promise<TurnResult> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new DomainError('not_found', `Sessão ${sessionId} não existe.`)
    if (session.active) {
      throw new DomainError('conflict', `A sessão ${sessionId} já tem um turno em andamento.`)
    }
    const activity = new TurnActivity(
      { sessionId, subtaskId: session.request.subtaskId, turnId: input.turnId },
      this.deps.clock,
      (draft) => this.emitActivity(draft),
      this.textFlushMs,
    )
    const startedAt = this.deps.clock.now()

    return new Promise<TurnResult>((resolve) => {
      const turn: ActiveTurn = {
        turnId: input.turnId,
        startedAt,
        activity,
        settled: false,
        cancelRequested: false,
        turnTimer: null,
        silenceTimer: null,
        finish: (outcome) => {
          if (turn.settled) return
          turn.settled = true
          if (turn.turnTimer) clearTimeout(turn.turnTimer)
          if (turn.silenceTimer) clearTimeout(turn.silenceTimer)
          if (session.active === turn) session.active = null
          const finalText = activity.finalText()
          if (outcome.kind === 'error') {
            activity.record({
              kind: 'error',
              message: outcome.error.message,
              code: outcome.error.code,
            })
          }
          activity.close({
            kind: 'turn_end',
            stopReason: outcome.kind === 'stopped' ? outcome.stopReason : null,
            error: outcome.kind === 'error' ? outcome.error : null,
          })
          let deliveries: TurnResult['deliveries'] = []
          try {
            deliveries = this.deps.deliveries.forTurn(input.turnId)
          } catch (error) {
            this.logger.warn('acp: falha ao ler entregas do turno', {
              turnId: input.turnId,
              error: errorMessage(error),
            })
          }
          resolve({
            turnId: input.turnId,
            sessionId,
            outcome,
            finalText,
            deliveries,
            startedAt,
            endedAt: this.deps.clock.now(),
          })
        },
      }
      session.active = turn
      activity.record({ kind: 'prompt', text: input.text })
      void this.runTurn(session, turn, input.text)
    })
  }

  private async runTurn(session: MemberSession, turn: ActiveTurn, text: string): Promise<void> {
    // Turno anterior cancelado pelo vigia ainda sem resposta: espera ele terminar
    // (ou o processo ser morto pela carencia do cancelamento).
    if (session.inflight) {
      await Promise.race([session.inflight.catch(() => {}), session.exited])
    }
    if (turn.settled) return
    if (!session.alive || !session.providerSessionId) {
      turn.finish({ kind: 'error', error: this.turnError(session, 'process_exited') })
      return
    }

    const { turnTimeoutMs } = this.deps.timeouts
    turn.turnTimer = setTimeout(() => this.abortTurn(session, turn, 'turn_timeout'), turnTimeoutMs)
    this.touch(session, turn)

    const request = session.connection.prompt({
      sessionId: session.providerSessionId,
      prompt: [{ type: 'text', text }],
    })
    session.inflight = request
    const clearInflight = (): void => {
      if (session.inflight === request) session.inflight = null
    }
    try {
      const response = await request
      clearInflight()
      if (isStopReason(response.stopReason)) {
        turn.finish({ kind: 'stopped', stopReason: response.stopReason })
      } else {
        turn.finish({
          kind: 'error',
          error: {
            code: 'protocol_error',
            message: `stopReason desconhecido: ${String(response.stopReason)}`,
          },
        })
      }
    } catch (error) {
      clearInflight()
      if (turn.settled) return
      // A conexao costuma cair um instante antes do 'exit': da um tempo para classificar.
      await Promise.race([session.exited, delay(500)])
      if (turn.settled) return
      if (session.exit) {
        turn.finish({ kind: 'error', error: this.turnError(session, 'process_exited') })
      } else {
        turn.finish({
          kind: 'error',
          error: {
            code: 'protocol_error',
            message: `${ERROR_TEXT.protocol_error} ${errorMessage(error)}`,
          },
        })
      }
    }
  }

  /** Sinal de vida do agente: rearma o vigia de silencio. */
  private touch(session: MemberSession, turn: ActiveTurn): void {
    if (turn.settled) return
    if (turn.silenceTimer) clearTimeout(turn.silenceTimer)
    turn.silenceTimer = setTimeout(
      () => this.abortTurn(session, turn, 'silent_timeout'),
      this.deps.timeouts.silenceTimeoutMs,
    )
  }

  private abortTurn(
    session: MemberSession,
    turn: ActiveTurn,
    code: Extract<TurnErrorCode, 'silent_timeout' | 'turn_timeout'>,
  ): void {
    if (turn.settled) return
    this.logger.warn('acp: turno abortado', { sessionId: session.id, turnId: turn.turnId, code })
    turn.cancelRequested = true
    turn.finish({ kind: 'error', error: this.turnError(session, code) })
    this.sendCancelWithGrace(session)
  }

  private sendCancelWithGrace(session: MemberSession): void {
    const providerSessionId = session.providerSessionId
    if (session.alive && providerSessionId) {
      session.connection.cancel({ sessionId: providerSessionId }).catch(() => {})
    }
    const pending = session.inflight
    if (!pending) return
    const timer = setTimeout(() => {
      if (session.inflight === pending && session.alive) {
        this.logger.warn('acp: agente não respondeu ao cancelamento; encerrando processo', {
          sessionId: session.id,
        })
        void this.terminate(session)
      }
    }, this.cancelGraceMs)
    timer.unref?.()
    pending.then(
      () => clearTimeout(timer),
      () => clearTimeout(timer),
    )
  }

  async cancel(sessionId: SessionId): Promise<void> {
    const session = this.sessions.get(sessionId)
    const turn = session?.active
    if (!session || !turn || turn.settled) return
    turn.cancelRequested = true
    const providerSessionId = session.providerSessionId
    if (session.alive && providerSessionId) {
      await session.connection.cancel({ sessionId: providerSessionId }).catch(() => {})
    }
    const timer = setTimeout(() => {
      if (turn.settled) return
      // O agente nao fechou o turno: fecha como cancelado e mata o processo (I3).
      turn.finish({ kind: 'stopped', stopReason: 'cancelled' })
      void this.terminate(session)
    }, this.cancelGraceMs)
    timer.unref?.()
  }

  // -------------------------------------------------------------------------
  // Eventos do agente
  // -------------------------------------------------------------------------

  private onSessionUpdate(session: MemberSession, params: SessionNotification): void {
    const turn = session.active
    // Fora de turno (ex.: historico repetido pelo session/load) nao vira atividade.
    if (!turn || turn.settled) return
    if (session.providerSessionId && params.sessionId !== session.providerSessionId) return
    this.touch(session, turn)
    try {
      turn.activity.update(params.update)
    } catch (error) {
      this.logger.warn('acp: session/update inválido', { error: errorMessage(error) })
    }
  }

  private onRequestPermission(
    session: MemberSession,
    params: RequestPermissionRequest,
  ): RequestPermissionResponse {
    const turn = session.active
    if (turn) this.touch(session, turn)
    if (!turn || turn.cancelRequested) return { outcome: { outcome: 'cancelled' } }
    const decision = decidePermission(params, {
      cwd: session.request.cwd,
      extraRoots: this.extraAllowedRoots,
    })
    if (!decision.allow) {
      this.logger.warn('acp: permissão recusada', {
        sessionId: session.id,
        tool: params.toolCall.title ?? params.toolCall.toolCallId,
        reason: decision.reason,
      })
    }
    return decision.response
  }

  private emitActivity(draft: ActivityEventDraft): void {
    for (const listener of this.activityListeners) {
      try {
        listener(draft)
      } catch (error) {
        this.logger.warn('acp: ouvinte de atividade falhou', { error: errorMessage(error) })
      }
    }
  }

  private turnError(session: MemberSession, code: TurnErrorCode): TurnError {
    const error: TurnError = { code, message: ERROR_TEXT[code] }
    if (code === 'process_exited') {
      error.exitCode = session.exit?.exitCode ?? null
      error.signal = session.exit?.signal ?? null
      const tail = session.stderrTail.trim().split('\n').slice(-3).join('\n')
      if (tail) error.message = `${error.message}\n${tail}`
    }
    return error
  }

  // -------------------------------------------------------------------------
  // Fim de vida
  // -------------------------------------------------------------------------

  async close(sessionId: SessionId): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.closing = true
    session.active?.finish({ kind: 'error', error: this.turnError(session, 'session_closed') })
    await this.terminate(session)
    this.sessions.delete(sessionId)
  }

  /** SIGTERM no grupo do processo; SIGKILL se nao sair em killGraceMs. */
  private async terminate(session: MemberSession): Promise<void> {
    if (session.exit) return
    session.child.stdin?.end()
    this.signal(session, 'SIGTERM')
    const exited = await Promise.race([
      session.exited.then(() => true),
      delay(this.killGraceMs).then(() => false),
    ])
    if (exited) return
    this.signal(session, 'SIGKILL')
    await Promise.race([session.exited, delay(this.killGraceMs)])
  }

  private signal(session: MemberSession, signal: NodeJS.Signals): void {
    const pid = session.child.pid
    if (pid === undefined) return
    try {
      if (process.platform !== 'win32') process.kill(-pid, signal)
      else session.child.kill(signal)
    } catch {
      try {
        session.child.kill(signal)
      } catch {
        // ja saiu
      }
    }
  }

  isAlive(sessionId: SessionId): boolean {
    const session = this.sessions.get(sessionId)
    return !!session && session.alive && !session.closing
  }

  liveCount(): number {
    let count = 0
    for (const session of this.sessions.values()) if (session.alive && !session.closing) count++
    return count
  }

  onActivity(listener: (draft: ActivityEventDraft) => void): Unsubscribe {
    this.activityListeners.add(listener)
    return () => this.activityListeners.delete(listener)
  }

  onSessionExit(listener: (sessionId: SessionId, exit: PtyExit) => void): Unsubscribe {
    this.exitListeners.add(listener)
    return () => this.exitListeners.delete(listener)
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.close(id)))
  }
}
