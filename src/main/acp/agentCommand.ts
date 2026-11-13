/**
 * Monta o comando e os parametros de sessao de cada agente ACP, sem efeito colateral.
 *
 * Claude (claude-agent-acp 0.73):
 *   - O adaptador ja chama o Claude Agent SDK com settingSources ["user", "project", "local"],
 *     entao ~/.claude/settings.json, os MCPs do usuario (~/.claude.json), ganchos e skills
 *     entram sozinhos. Mandamos o mesmo valor em _meta.claudeCode.options para fixar o
 *     contrato caso o padrao mude numa versao futura (e o equivalente ao
 *     ACPX_CLAUDE_INCLUDE_USER_SETTINGS do Paperclip).
 *   - Prompt do papel: _meta.systemPrompt = { append }, que mantem o preset claude_code.
 *   - Modelo: ANTHROPIC_MODEL na partida (como o Paperclip), porque set_config_option
 *     recusa ids que nao estao na lista anunciada.
 *   - CLI: CLAUDE_CODE_EXECUTABLE aponta para o primeiro `claude` do PATH (o wrapper de
 *     rodizio de contas, quando existe). Sem isso o adaptador usaria o binario embutido no
 *     claude-agent-sdk e pularia o rodizio. Valor ja definido pelo usuario e mantido.
 *
 * Codex (codex-acp 1.6.2):
 *   - Le ~/.codex/config.toml sozinho (MCPs e preferencias do usuario).
 *   - CLI: CODEX_PATH aponta para o primeiro `codex` do PATH, como o Lider usa.
 *   - CODEX_CONFIG (JSON) sobrepoe chaves: model e developer_instructions (prompt do papel).
 *   - Modo padrao "agent": sandbox workspace-write e aprovacao on-request, que chega aqui
 *     como session/request_permission e passa pela politica da worktree.
 */
import { createRequire } from 'node:module'
import type { McpServer } from '@agentclientprotocol/sdk'
import type { Provider } from '@shared/domain'
import type { McpServerLaunch, MemberSessionStart } from '@shared/ports'
import { resolveExecutableOnPath } from '../leader/executable'

export interface AgentCommand {
  command: string
  args: string[]
  /** Variaveis extras; o runtime mescla com process.env e MemberSessionStart.env. */
  env: Record<string, string>
}

/** Fontes de configuracao do usuario que o Claude deve carregar. */
export const CLAUDE_SETTING_SOURCES = ['user', 'project', 'local'] as const

const ACP_PACKAGE_BIN: Record<Provider, string> = {
  claude: '@agentclientprotocol/claude-agent-acp/dist/index.js',
  codex: '@agentclientprotocol/codex-acp/dist/index.js',
}

const localRequire = createRequire(import.meta.url)

/** Caminho do script do adaptador ACP instalado em node_modules. */
export function resolveAcpAgentScript(provider: Provider): string {
  return localRequire.resolve(ACP_PACKAGE_BIN[provider])
}

/**
 * Roda o adaptador com o Node embutido no Electron (ELECTRON_RUN_AS_NODE=1), para nao
 * depender de um `node` no PATH do usuario.
 */
export function buildAgentCommand(
  request: Pick<MemberSessionStart, 'provider' | 'model' | 'systemPrompt'>,
  options: {
    nodeBinary?: string
    scriptPath?: string
    baseEnv?: Record<string, string | undefined>
  } = {},
): AgentCommand {
  const nodeBinary = options.nodeBinary ?? process.execPath
  const scriptPath = options.scriptPath ?? resolveAcpAgentScript(request.provider)
  const baseEnv = options.baseEnv ?? process.env
  const env: Record<string, string> = { ELECTRON_RUN_AS_NODE: '1' }
  const cliVariable = request.provider === 'claude' ? 'CLAUDE_CODE_EXECUTABLE' : 'CODEX_PATH'
  if (!baseEnv[cliVariable]) {
    const cli = resolveExecutableOnPath(request.provider, baseEnv.PATH)
    if (cli) env[cliVariable] = cli
  }
  if (request.provider === 'claude') {
    if (request.model) env.ANTHROPIC_MODEL = request.model
  } else {
    const existing = parseJsonObject(baseEnv.CODEX_CONFIG)
    const config: Record<string, unknown> = { ...existing }
    if (request.model) config.model = request.model
    if (request.systemPrompt.trim()) config.developer_instructions = request.systemPrompt
    if (Object.keys(config).length > 0) env.CODEX_CONFIG = JSON.stringify(config)
  }
  return { command: nodeBinary, args: [scriptPath], env }
}

/** _meta do session/new e session/load. */
export function buildSessionMeta(
  request: Pick<MemberSessionStart, 'provider' | 'systemPrompt'>,
): Record<string, unknown> | undefined {
  if (request.provider !== 'claude') return undefined
  const meta: Record<string, unknown> = {
    claudeCode: { options: { settingSources: [...CLAUDE_SETTING_SOURCES] } },
  }
  if (request.systemPrompt.trim()) meta.systemPrompt = { append: request.systemPrompt }
  return meta
}

/** Servidor MCP do app no formato stdio do ACP. */
export function toAcpMcpServer(launch: McpServerLaunch): McpServer {
  return {
    name: launch.name,
    command: launch.command,
    args: [...launch.args],
    env: Object.entries(launch.env).map(([name, value]) => ({ name, value })),
  }
}

function parseJsonObject(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}
