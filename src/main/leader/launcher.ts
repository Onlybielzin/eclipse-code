/**
 * LeaderLauncher: abre o Lider (Claude ou Codex) no PtyHost e registra a sessao.
 *
 * Retomar: `claude --resume <id>` / `codex resume <id>` quando o pedido traz
 * resumeProviderSessionId. Claude novo nasce com `--session-id` derivado do id da sessao,
 * entao o app sabe o id sem procurar; o gancho SessionStart confirma.
 */
import { DomainError, type EpochMs, type Provider } from '@shared/domain'
import type {
  LeaderCommand,
  LeaderLaunchRequest,
  LeaderLaunchResult,
  LeaderLauncher,
  PtyHost,
} from '@shared/ports'
import {
  claudeHookPaths,
  removeClaudeHookFiles,
  writeClaudeHookFiles,
  type ClaudeHookPaths,
} from './claudeHooks'
import { buildLeaderCommand, claudeSessionIdFor } from './commands'
import { resolveExecutableOnPath } from './executable'
import type { LeaderSessionRegistry } from './leaderSessions'
import { locateProviderSessionId, type SessionLocatorDirs } from './sessionLocator'

export interface LeaderLauncherOptions {
  ptyHost: PtyHost
  registry: LeaderSessionRegistry
  dirs: SessionLocatorDirs
  /** Pasta para os arquivos de ganchos do Claude (ex: AppPaths.runtime). null desliga os ganchos. */
  hooksRoot: string | null
  /** Binario que roda o script do gancho com ELECTRON_RUN_AS_NODE=1 (process.execPath). */
  runtimeExecutable?: string
  baseEnv?: Record<string, string | undefined>
  /** Sem pedir permissao (padrao true, como o app antigo). */
  fullAccess?: boolean
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  resolveExecutable?: (command: string, pathValue: string | undefined) => string | null
}

export function createLeaderLauncher(options: LeaderLauncherOptions): LeaderLauncher {
  const now = options.now ?? Date.now
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const runtimeExecutable = options.runtimeExecutable ?? process.execPath
  const resolveExecutable = options.resolveExecutable ?? resolveExecutableOnPath
  const fullAccess = options.fullAccess ?? true

  const hookPathsFor = (request: LeaderLaunchRequest): ClaudeHookPaths | null =>
    request.provider === 'claude' && options.hooksRoot
      ? claudeHookPaths(options.hooksRoot, request.sessionId)
      : null

  const buildCommand = (request: LeaderLaunchRequest): LeaderCommand =>
    buildLeaderCommand(request, {
      baseEnv: options.baseEnv ?? process.env,
      fullAccess,
      claudeHookSettingsPath: hookPathsFor(request)?.settings ?? null,
    })

  return {
    buildCommand,

    async launch(request: LeaderLaunchRequest): Promise<LeaderLaunchResult> {
      const command = buildCommand(request)
      const executable = resolveExecutable(command.command, command.env['PATH'])
      if (!executable) {
        throw new DomainError(
          'unavailable',
          `O comando ${command.command} não foi encontrado no PATH.`,
          {
            command: command.command,
            provider: request.provider,
          },
        )
      }
      const hooks = hookPathsFor(request)
      if (hooks) {
        try {
          await writeClaudeHookFiles(hooks, runtimeExecutable)
        } catch (error) {
          throw new DomainError(
            'unavailable',
            `Não foi possível preparar os ganchos do Claude: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
      const startedAt: EpochMs = now()
      let spawned
      try {
        spawned = await options.ptyHost.spawn({
          command: executable,
          args: command.args,
          cwd: request.cwd,
          env: command.env,
          cols: request.cols,
          rows: request.rows,
          label: `lider ${request.provider} ${request.sessionId}`,
        })
      } catch (error) {
        if (hooks) await removeClaudeHookFiles(hooks).catch(() => undefined)
        throw error
      }
      const resumeId = request.resumeProviderSessionId?.trim() || null
      const knownProviderSessionId =
        resumeId ?? (request.provider === 'claude' ? claudeSessionIdFor(request.sessionId) : null)
      options.registry.register({
        sessionId: request.sessionId,
        ptyId: spawned.ptyId,
        pid: spawned.pid,
        provider: request.provider,
        cwd: request.cwd,
        startedAt,
        providerSessionId: knownProviderSessionId,
        resumed: resumeId !== null,
        claudeHooks: hooks,
      })
      return {
        ...spawned,
        resumed: resumeId !== null,
        command: { ...command, command: executable },
      }
    },

    locateProviderSessionId(input: {
      provider: Provider
      cwd: string
      startedAt: EpochMs
      timeoutMs: number
    }) {
      return locateProviderSessionId(input, { dirs: options.dirs, now, sleep })
    },
  }
}
