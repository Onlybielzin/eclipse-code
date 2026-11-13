/**
 * Monta o comando do Lider (Claude ou Codex), sem efeito colateral.
 *
 * Origem: agent/infrastructure/cli/AgentCommandFactory.ts e
 * providers/claude-code/ClaudeCodeAgentProviderContribution.ts do app antigo.
 */
import { createHash } from 'node:crypto'
import { ENV } from '@shared/app'
import type { LeaderCommand, LeaderLaunchRequest, McpServerLaunch } from '@shared/ports'

/** Liga as ferramentas de lista de tarefas do Claude (TaskCreate/TaskUpdate), como o app antigo. */
export const LEADER_CLAUDE_ENV = { CLAUDE_CODE_ENABLE_TODO_TOOLS: '1' } as const

export const PROVIDER_COMMANDS = { claude: 'claude', codex: 'codex' } as const

export interface LeaderCommandOptions {
  /** Ambiente base (normalmente process.env). */
  baseEnv: Record<string, string | undefined>
  /** Sem pedir permissao (padrao do app antigo). */
  fullAccess: boolean
  /** Caminho do settings.json com os ganchos do Claude, ou null sem ganchos. */
  claudeHookSettingsPath: string | null
}

/**
 * Id de sessao do Claude derivado do id da nossa sessao: `claude --session-id <uuid>`.
 * Deterministico, para buildCommand ficar puro e para o app saber o id sem procurar.
 */
export function claudeSessionIdFor(sessionId: string): string {
  const bytes = createHash('sha256')
    .update(`eclipse-next-leader:${sessionId}`)
    .digest()
    .subarray(0, 16)
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Valor de `claude --mcp-config <json>` com o servidor MCP do app. */
export function buildClaudeMcpConfigArg(server: McpServerLaunch): string {
  return JSON.stringify({
    mcpServers: {
      [server.name]: { type: 'stdio', command: server.command, args: server.args, env: server.env },
    },
  })
}

/** Nome seguro para chave TOML sem aspas (o `-c` do Codex separa a chave por '.'). */
export function codexMcpServerKey(name: string): string {
  const key = name.replace(/[^A-Za-z0-9_-]/g, '_')
  return key.length > 0 ? key : 'eclipse'
}

/** String TOML basica. JSON.stringify gera escapes que o TOML aceita (\", \\, \n, \uXXXX). */
function tomlString(value: string): string {
  return JSON.stringify(value)
}

/** Overrides `-c` do Codex que registram o servidor MCP do app. */
export function buildCodexMcpConfigArgs(server: McpServerLaunch): string[] {
  const prefix = `mcp_servers.${codexMcpServerKey(server.name)}`
  const args = ['-c', `${prefix}.command=${tomlString(server.command)}`]
  args.push('-c', `${prefix}.args=[${server.args.map(tomlString).join(',')}]`)
  const envEntries = Object.entries(server.env)
  if (envEntries.length > 0) {
    const table = envEntries
      .map(([key, value]) => `${tomlString(key)}=${tomlString(value)}`)
      .join(',')
    args.push('-c', `${prefix}.env={${table}}`)
  }
  return args
}

function normalizeOptional(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

export function composeLeaderEnv(
  request: LeaderLaunchRequest,
  options: LeaderCommandOptions,
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(options.baseEnv)) {
    if (typeof value === 'string') env[key] = value
  }
  Object.assign(env, request.env)
  env[ENV.marker] = '1'
  if (request.provider === 'claude') Object.assign(env, LEADER_CLAUDE_ENV)
  return env
}

export function buildLeaderCommand(
  request: LeaderLaunchRequest,
  options: LeaderCommandOptions,
): LeaderCommand {
  const model = normalizeOptional(request.model)
  const resumeId = normalizeOptional(request.resumeProviderSessionId)
  const prompt = resumeId ? '' : (request.initialPrompt ?? '').trim()
  const env = composeLeaderEnv(request, options)

  if (request.provider === 'claude') {
    const args: string[] = []
    if (options.fullAccess) args.push('--dangerously-skip-permissions')
    if (model) args.push('--model', model)
    // --mcp-config e variadico: vem antes de outra opcao, nunca logo antes do prompt.
    args.push('--mcp-config', buildClaudeMcpConfigArg(request.mcpServer))
    if (options.claudeHookSettingsPath) args.push('--settings', options.claudeHookSettingsPath)
    if (resumeId) {
      args.push('--resume', resumeId)
    } else {
      args.push('--session-id', claudeSessionIdFor(request.sessionId))
      if (prompt.length > 0) {
        if (prompt.startsWith('-')) args.push('--')
        args.push(prompt)
      }
    }
    return { command: PROVIDER_COMMANDS.claude, args, env }
  }

  const args: string[] = []
  if (options.fullAccess) {
    args.push('--dangerously-bypass-approvals-and-sandbox')
  } else {
    args.push('--sandbox', 'workspace-write', '--ask-for-approval', 'on-request')
  }
  args.push(...buildCodexMcpConfigArgs(request.mcpServer))
  if (resumeId) {
    args.push('resume', resumeId)
    if (model) args.push('--model', model)
    return { command: PROVIDER_COMMANDS.codex, args, env }
  }
  if (model) args.push('--model', model)
  if (prompt.length > 0) args.push('--', prompt)
  return { command: PROVIDER_COMMANDS.codex, args, env }
}
