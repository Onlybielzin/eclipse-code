/**
 * Monta o comando do Lider (Claude ou Codex), sem efeito colateral.
 *
 * Origem: agent/infrastructure/cli/AgentCommandFactory.ts e
 * providers/claude-code/ClaudeCodeAgentProviderContribution.ts do app antigo.
 */
import { createHash } from 'node:crypto'
import { ENV } from '@shared/app'
import { MCP_WAIT_MAX_SECONDS } from '@shared/mcp'
import type { LeaderCommand, LeaderLaunchRequest, McpServerLaunch } from '@shared/ports'
import { sanitizeInheritedEnv } from '../terminal/spawnEnv'

/** Liga as ferramentas de lista de tarefas do Claude (TaskCreate/TaskUpdate), como o app antigo. */
export const LEADER_CLAUDE_ENV = { CLAUDE_CODE_ENABLE_TODO_TOOLS: '1' } as const

/**
 * Prazo das ferramentas MCP do app no cliente. subtarefas_esperar segura a chamada ate
 * MCP_WAIT_MAX_SECONDS; o padrao do Codex (60 s) e do Claude Code cortariam antes.
 */
export const MCP_TOOL_TIMEOUT_SECONDS = MCP_WAIT_MAX_SECONDS + 60

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

/**
 * Variaveis do servidor MCP que nunca vao na linha de comando: /proc/<pid>/cmdline e `ps`
 * mostram o argv a qualquer processo, e um membro com o token do Lider viraria Lider na
 * ponte. Vao no ambiente do processo do Lider; o servidor MCP filho herda de la.
 */
export const MCP_SECRET_ENV_KEYS: readonly string[] = [ENV.mcpToken]

/** Separa o env do servidor MCP em publico (pode ir no argv) e secreto (so no ambiente). */
export function splitMcpServerEnv(server: McpServerLaunch): {
  publicEnv: Record<string, string>
  secretEnv: Record<string, string>
} {
  const publicEnv: Record<string, string> = {}
  const secretEnv: Record<string, string> = {}
  for (const [key, value] of Object.entries(server.env)) {
    if (MCP_SECRET_ENV_KEYS.includes(key)) secretEnv[key] = value
    else publicEnv[key] = value
  }
  return { publicEnv, secretEnv }
}

/**
 * Valor de `claude --mcp-config <json>` com o servidor MCP do app. Sem o token: o Claude
 * Code abre o servidor stdio com o proprio ambiente somado ao `env` da config, e o token
 * esta no ambiente do processo do Lider (composeLeaderEnv).
 */
export function buildClaudeMcpConfigArg(server: McpServerLaunch): string {
  const { publicEnv } = splitMcpServerEnv(server)
  return JSON.stringify({
    mcpServers: {
      [server.name]: { type: 'stdio', command: server.command, args: server.args, env: publicEnv },
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

/**
 * Overrides `-c` do Codex que registram o servidor MCP do app. O Codex abre o servidor
 * stdio com um ambiente minimo; o token passa pelo nome em `env_vars` (copiado do ambiente
 * do processo do Lider), nunca pelo valor no argv.
 */
export function buildCodexMcpConfigArgs(server: McpServerLaunch): string[] {
  const prefix = `mcp_servers.${codexMcpServerKey(server.name)}`
  const args = ['-c', `${prefix}.command=${tomlString(server.command)}`]
  args.push('-c', `${prefix}.args=[${server.args.map(tomlString).join(',')}]`)
  const { publicEnv, secretEnv } = splitMcpServerEnv(server)
  const envEntries = Object.entries(publicEnv)
  if (envEntries.length > 0) {
    const table = envEntries
      .map(([key, value]) => `${tomlString(key)}=${tomlString(value)}`)
      .join(',')
    args.push('-c', `${prefix}.env={${table}}`)
  }
  const secretNames = Object.keys(secretEnv)
  if (secretNames.length > 0) {
    args.push('-c', `${prefix}.env_vars=[${secretNames.map(tomlString).join(',')}]`)
  }
  args.push('-c', `${prefix}.tool_timeout_sec=${MCP_TOOL_TIMEOUT_SECONDS}`)
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
  // Sem as variaveis de sessao do app antigo nem o token MCP de um agente pai.
  const env = sanitizeInheritedEnv(options.baseEnv)
  Object.assign(env, request.env)
  // Token do servidor MCP: so no ambiente (ver MCP_SECRET_ENV_KEYS).
  Object.assign(env, splitMcpServerEnv(request.mcpServer).secretEnv)
  env[ENV.marker] = '1'
  if (request.provider === 'claude') {
    Object.assign(env, LEADER_CLAUDE_ENV)
    // Prazo de ferramenta MCP do Claude Code, em ms (ver MCP_TOOL_TIMEOUT_SECONDS).
    env['MCP_TOOL_TIMEOUT'] ??= String(MCP_TOOL_TIMEOUT_SECONDS * 1000)
  }
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
