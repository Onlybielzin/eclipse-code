/**
 * leader/: abrir o Lider (Claude/Codex) num pty e falar com ele.
 * Implementa LeaderLauncher e LeaderRelay (src/shared/ports.ts).
 *
 * Origem: agent/infrastructure/{cli,providers,watchers,terminal-activity},
 * AgentSessionLocator e TeamTurnRelay do app antigo (so Claude e Codex).
 *
 * Uso no composition root (app/):
 *   const leader = createLeaderModule({ ptyHost, hooksRoot: paths.runtime })
 *   leader.launcher.launch({ ..., mcpServer: mcpBridge.launchSpec(token) })
 *   leader.sessions.onEvent(e => e.type === 'provider-session-id' && taskService.updateSession(...))
 *   leader.relay.deliver(sessionId, texto)
 */
import type { LeaderLauncher, LeaderRelay, PtyHost } from '@shared/ports'
import { createLeaderLauncher, type LeaderLauncherOptions } from './launcher'
import {
  createLeaderSessionRegistry,
  type LeaderSessionRegistry,
  type LeaderSessionRegistryOptions,
} from './leaderSessions'
import { createLeaderRelay, type LeaderRelayOptions } from './relay'
import { defaultSessionLocatorDirs, type SessionLocatorDirs } from './sessionLocator'

export interface LeaderModuleOptions {
  ptyHost: PtyHost
  /** Pasta dos arquivos de ganchos do Claude (AppPaths.runtime). null desliga os ganchos. */
  hooksRoot: string | null
  dirs?: SessionLocatorDirs
  launcher?: Partial<Omit<LeaderLauncherOptions, 'ptyHost' | 'registry' | 'dirs' | 'hooksRoot'>>
  sessions?: Partial<Omit<LeaderSessionRegistryOptions, 'ptyHost' | 'dirs'>>
  relay?: Partial<Omit<LeaderRelayOptions, 'ptyHost' | 'registry'>>
}

export interface LeaderModule {
  launcher: LeaderLauncher
  relay: LeaderRelay
  sessions: LeaderSessionRegistry
  dispose(): Promise<void>
}

export function createLeaderModule(options: LeaderModuleOptions): LeaderModule {
  const dirs = options.dirs ?? defaultSessionLocatorDirs()
  const sessions = createLeaderSessionRegistry({
    ...options.sessions,
    ptyHost: options.ptyHost,
    dirs,
  })
  const launcher = createLeaderLauncher({
    ...options.launcher,
    ptyHost: options.ptyHost,
    registry: sessions,
    dirs,
    hooksRoot: options.hooksRoot,
  })
  const relay = createLeaderRelay({
    ...options.relay,
    ptyHost: options.ptyHost,
    registry: sessions,
  })
  return { launcher, relay, sessions, dispose: () => sessions.dispose() }
}

export { createLeaderLauncher, type LeaderLauncherOptions } from './launcher'
export { createLeaderRelay, sanitizeRelayText, type LeaderRelayOptions } from './relay'
export {
  createLeaderSessionRegistry,
  type LeaderActivity,
  type LeaderSessionEvent,
  type LeaderSessionRegistry,
  type LeaderSessionRegistryOptions,
  type LeaderSessionSnapshot,
} from './leaderSessions'
export {
  LEADER_CLAUDE_ENV,
  buildClaudeMcpConfigArg,
  buildCodexMcpConfigArgs,
  buildLeaderCommand,
  claudeSessionIdFor,
} from './commands'
export { resolveExecutableOnPath } from './executable'
export {
  defaultSessionLocatorDirs,
  findClaudeTranscript,
  findCodexSessionFile,
  locateProviderSessionId,
  type SessionLocatorDirs,
} from './sessionLocator'
export { CLAUDE_HOOK_EVENTS, claudeHookPaths } from './claudeHooks'
