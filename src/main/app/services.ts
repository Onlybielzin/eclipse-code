/**
 * Composition root sem Electron: abre o SQLite, o PtyHost, o Lider, o runtime ACP, as
 * worktrees e a ponte MCP, liga tudo no TeamCoordinator e recupera as sessoes da partida
 * anterior. O src/main/index.ts so acrescenta janela e IPC; os testes usam isto direto.
 *
 * Ordem da partida (importa):
 *   1. SQLite e TaskService.
 *   2. TeamTurnRelay assina os eventos ANTES da recuperacao, para que o fim de turno das
 *      subtarefas perdidas vire aviso quando o Lider voltar. A fila de avisos e duravel
 *      (leader_notices): o que nao saiu antes de fechar o app sai na proxima partida.
 *   3. Ponte MCP escutando antes de qualquer agente abrir.
 *   4. recoverOnStartup: fecha o que nao voltou e reabre os Lideres com --resume.
 */
import { mkdirSync } from 'node:fs'
import type { AppPaths } from '@shared/app'
import type { IpcEventMessage } from '@shared/ipc'
import type { AgentLimits, Clock, MemberTurnTimeouts, Unsubscribe } from '@shared/ports'
import {
  AcpMemberRuntime,
  DEFAULT_MEMBER_TURN_TIMEOUTS,
  type AcpMemberRuntimeOptions,
} from '../acp'
import { createBrainService, type BrainCipher, type BrainService } from '../brain'
import { createLeaderModule, type LeaderModule, type LeaderModuleOptions } from '../leader'
import { createMcpBridgeServer, startTeamTurnRelay, type TeamTurnRelay } from '../mcp'
import {
  createTaskService,
  openSqliteTaskStore,
  importLegacyProjects,
  importLegacyTasks,
  readLegacyProjects,
  readLegacyTasks,
  systemClock,
  type RecoveryReport,
  type SqliteTaskService,
} from '../tasks'
import { createPtyHost, TaskProcesses, type PtyHostOptions } from '../terminal'
import { createWorktreeService } from '../worktree'
import { AppTeamCoordinator, silentLogger, type AppLogger } from './teamCoordinator'
import type { McpBridgeServer, PtyHost } from '@shared/ports'

export interface AppServicesOptions {
  paths: Pick<AppPaths, 'database' | 'runtime' | 'worktrees' | 'userData'>
  /**
   * Bancos do app antigo (com canvas) lidos SOMENTE LEITURA na primeira partida:
   * se o app novo ainda nao tem projeto, importa projetos e papeis deles, em ordem.
   * Ausente ou vazio: nao importa.
   */
  legacyDatabases?: readonly string[]
  /** Script do servidor MCP stdio (out/main/mcp-server.js; dentro do asar no app empacotado). */
  mcpServerScript: string
  /** Executavel que roda o script com ELECTRON_RUN_AS_NODE=1. Padrao: process.execPath. */
  nodeCommand?: string
  limits?: AgentLimits
  memberTimeouts?: MemberTurnTimeouts
  acp?: AcpMemberRuntimeOptions
  leader?: Omit<LeaderModuleOptions, 'ptyHost' | 'hooksRoot'> & { hooksRoot?: string | null }
  ptyHost?: PtyHostOptions
  clock?: Clock
  terminalSize?: { cols: number; rows: number }
  leaderEnv?: Record<string, string>
  memberEnv?: Record<string, string>
  /** Intervalo da tentativa periodica de entregar avisos parados ao Lider (0 desliga). */
  noticeRetryIntervalMs?: number
  log?: AppLogger
  /** Cifra da chave do Cerebro (safeStorage no app). Sem ela, o main recusa salvar a chave. */
  brainCipher?: BrainCipher
}

export interface AppServices {
  brain: BrainService
  tasks: SqliteTaskService
  coordinator: AppTeamCoordinator
  ptyHost: PtyHost
  taskProcesses: TaskProcesses
  leader: LeaderModule
  members: AcpMemberRuntime
  turnRelay: TeamTurnRelay
  /** Ponte MCP: o modo --smoke emite um token de teste para provar o servidor empacotado. */
  bridge: McpBridgeServer
  recovery: RecoveryReport
  socketPath: string
  /** Eventos para a tela: dominio (depois do commit) e terminal do Lider. */
  onUiEvent(listener: (message: IpcEventMessage) => void): Unsubscribe
  /** Espera agentes abrindo, turnos e avisos em curso. */
  idle(): Promise<void>
  dispose(): Promise<void>
}

const unavailableCipher: BrainCipher = {
  isEncryptionAvailable: () => false,
  encryptString: () => {
    throw new Error('cifra indisponível')
  },
  decryptString: () => {
    throw new Error('cifra indisponível')
  },
}

export async function startAppServices(options: AppServicesOptions): Promise<AppServices> {
  const log = options.log ?? silentLogger
  const clock = options.clock ?? systemClock
  mkdirSync(options.paths.userData, { recursive: true })
  mkdirSync(options.paths.runtime, { recursive: true, mode: 0o700 })

  const store = openSqliteTaskStore({ filename: options.paths.database })
  const tasks = createTaskService({
    store,
    clock,
    onListenerError: (error) =>
      log.error('assinante de evento falhou', {
        error: error instanceof Error ? error.message : String(error),
      }),
  })
  const ptyHost = createPtyHost(options.ptyHost)
  const leader = createLeaderModule({
    ...options.leader,
    ptyHost,
    hooksRoot:
      options.leader?.hooksRoot === undefined ? options.paths.runtime : options.leader.hooksRoot,
  })
  const members = new AcpMemberRuntime(
    {
      clock,
      timeouts: options.memberTimeouts ?? DEFAULT_MEMBER_TURN_TIMEOUTS,
      deliveries: { forTurn: (turnId) => tasks.listTurnDeliveries(turnId) },
    },
    {
      logger: { info: log.info.bind(log), warn: log.warn.bind(log) },
      ...options.acp,
    },
  )
  const bridge = createMcpBridgeServer({
    runtimeDir: options.paths.runtime,
    serverScriptPath: options.mcpServerScript,
    ...(options.nodeCommand ? { nodeCommand: options.nodeCommand } : {}),
  })
  // Fila duravel de avisos ao Lider (SQLite): fim de turno, resposta do usuario, membro que
  // parou. Lider ocioso e a tentativa periodica destravam aviso que esgotou o relay.
  const turnRelay = startTeamTurnRelay({
    tasks,
    relay: leader.relay,
    notices: tasks,
    now: () => clock.now(),
    leaderEvents: leader.sessions,
    ...(options.noticeRetryIntervalMs !== undefined
      ? { retryIntervalMs: options.noticeRetryIntervalMs }
      : {}),
    onError: (error) =>
      log.warn('aviso ao Líder falhou', {
        error: error instanceof Error ? error.message : String(error),
      }),
  })
  const taskProcesses = new TaskProcesses({
    ptyHost,
    tasks,
    ...(options.terminalSize ? { size: options.terminalSize } : {}),
  })
  const coordinator = new AppTeamCoordinator({
    tasks,
    ptyHost,
    taskProcesses,
    leader,
    members,
    worktrees: createWorktreeService(),
    bridge,
    worktreesRoot: options.paths.worktrees,
    leaderNotices: turnRelay,
    limits: options.limits ?? (() => tasks.getAgentLimits()),
    ...(options.terminalSize ? { terminalSize: options.terminalSize } : {}),
    ...(options.leaderEnv ? { leaderEnv: options.leaderEnv } : {}),
    ...(options.memberEnv ? { memberEnv: options.memberEnv } : {}),
    log,
  })

  let socketPath: string
  try {
    socketPath = (await bridge.start(coordinator)).socketPath
  } catch (error) {
    turnRelay.stop()
    await leader.dispose()
    await ptyHost.dispose()
    store.close()
    throw error
  }
  importLegacyOnFirstRun(tasks, options.legacyDatabases ?? [], log)
  // Tarefas do app antigo: toda partida, idempotente (pula worktree ja importada). Antes da
  // recuperacao, para os Lideres importados voltarem com --resume nesta mesma partida.
  importLegacyTasksEachRun(tasks, options.legacyDatabases ?? [], log)
  const recovery = await coordinator.recover()
  log.info('recuperação da partida', {
    lostSessions: recovery.lostSessions.length,
    pausedSubtasks: recovery.pausedSubtasks.length,
    leadersToResume: recovery.leadersToResume.length,
  })

  const uiListeners = new Set<(message: IpcEventMessage) => void>()
  const emitUi = (message: IpcEventMessage) => {
    for (const listener of uiListeners) {
      try {
        listener(message)
      } catch (error) {
        log.warn('ouvinte da tela falhou', {
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }
  const offs: Unsubscribe[] = [
    tasks.subscribe((envelope) => emitUi({ channel: 'domain.event', payload: envelope })),
    ptyHost.onData((ptyId, data) => {
      // Processo de aba nao tem Session: o ptyId faz de sessionId.
      const sessionId =
        coordinator.sessionForPty(ptyId) ?? (taskProcesses.owns(ptyId) ? ptyId : null)
      if (sessionId) emitUi({ channel: 'terminal.data', payload: { sessionId, data } })
    }),
    taskProcesses.onExit((ptyId, exit) =>
      emitUi({
        channel: 'terminal.exit',
        payload: { sessionId: ptyId, exitCode: exit.exitCode, signal: exit.signal },
      }),
    ),
    coordinator.onLeaderTerminalExit((payload) => emitUi({ channel: 'terminal.exit', payload })),
  ]

  const brain = createBrainService({
    settings: store,
    cipher: options.brainCipher ?? unavailableCipher,
    emit: emitUi,
  })

  let disposed: Promise<void> | null = null
  return {
    brain,
    tasks,
    coordinator,
    ptyHost,
    taskProcesses,
    leader,
    members,
    turnRelay,
    bridge,
    recovery,
    socketPath,
    onUiEvent(listener) {
      uiListeners.add(listener)
      return () => uiListeners.delete(listener)
    },
    async idle() {
      for (let i = 0; i < 3; i++) {
        await coordinator.idle()
        await turnRelay.idle()
      }
    },
    dispose() {
      disposed ??= (async () => {
        brain.dispose()
        await coordinator.shutdown()
        turnRelay.stop()
        for (const off of offs.splice(0)) off()
        taskProcesses.dispose()
        uiListeners.clear()
        await bridge.stop()
        await leader.dispose()
        await ptyHost.dispose()
        await members.dispose()
        store.close()
      })()
      return disposed
    },
  }
}

/** Primeira partida: sem nenhum projeto, traz projetos e times do app antigo. */
export function importLegacyOnFirstRun(
  tasks: SqliteTaskService,
  databases: readonly string[],
  log: AppLogger,
): void {
  if (databases.length === 0 || tasks.listProjects().length > 0) return
  for (const database of databases) {
    try {
      const report = importLegacyProjects(tasks, readLegacyProjects(database))
      log.info('importação do app antigo', {
        database,
        projectsCreated: report.projectsCreated.map((p) => p.name),
        rolesCreated: report.rolesCreated.length,
        rolesSkipped: report.rolesSkipped.length,
      })
    } catch (error) {
      log.warn('importação do app antigo falhou', {
        database,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}

/** Traz as tarefas do app antigo que ainda nao estao aqui. Banco antigo so leitura. */
export function importLegacyTasksEachRun(
  tasks: SqliteTaskService,
  databases: readonly string[],
  log: AppLogger,
): void {
  for (const database of databases) {
    try {
      const report = importLegacyTasks(tasks, readLegacyTasks(database))
      if (report.imported.length === 0) continue
      log.info('tarefas do app antigo importadas', {
        database,
        imported: report.imported.map((i) => ({
          title: i.task.title,
          resumes: i.resumes,
          questions: i.questions,
        })),
        skipped: report.skipped.filter((s) => s.reason !== 'já importada'),
      })
    } catch (error) {
      log.warn('importação de tarefas do app antigo falhou', {
        database,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}
