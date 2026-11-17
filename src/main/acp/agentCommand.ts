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
 *   - O app empacotado NAO leva os binarios embutidos (package.json build.files exclui
 *     claude-agent-sdk-<plataforma> e @openai/codex-<plataforma>, ~700 MB). Sem CLI no PATH
 *     a variavel recebe o nome puro ("claude"/"codex") e a partida falha dizendo que o
 *     comando nao existe, em vez de cair no binario embutido que nao esta no pacote.
 *
 * Codex (codex-acp 1.6.2):
 *   - Le ~/.codex/config.toml sozinho (MCPs e preferencias do usuario).
 *   - CLI: CODEX_PATH aponta para o primeiro `codex` do PATH, como o Lider usa.
 *   - CODEX_CONFIG (JSON) sobrepoe chaves: model e developer_instructions (prompt do papel).
 *   - Acesso do papel: sandbox_mode danger-full-access (read-only no papel read_only) e
 *     approval_policy never no CODEX_CONFIG. Pedido que chegue como session/request_permission
 *     passa por decidePermission (permissionPolicy.ts).
 *
 * Acesso por papel (Role.access): decisao de 2026-11-17, trocou o "libera pra todos" de 2026-11-13.
 * Claude read_only perde as ferramentas de escrita (disallowedTools); o resto da trava esta em
 * decidePermission.
 * shortcut: o Claude read_only ainda escreve arquivo pelo Bash (sed -i, echo >), porque o pedido
 * chega como execute e a politica so barra git de escrita; so o Codex tem sandbox read-only de
 * verdade. Fechar isso exige analisar o comando ou rodar o Claude em sandbox.
 */
import { createRequire } from 'node:module'
import type { McpServer } from '@agentclientprotocol/sdk'
import type { Provider } from '@shared/domain'
import type { McpServerLaunch, MemberSessionStart } from '@shared/ports'
import {
  resolveExecutableOnPath,
  resolveNpmShimScript,
  unsupportedScriptError,
} from '../leader/executable'
import { envValue } from '../terminal/spawnEnv'

export interface AgentCommand {
  command: string
  args: string[]
  /** Variaveis extras; o runtime mescla com process.env e MemberSessionStart.env. */
  env: Record<string, string>
}

/** Ferramentas de escrita que o Claude perde no papel read_only. */
export const READ_ONLY_DISALLOWED_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'] as const

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
  request: Pick<MemberSessionStart, 'provider' | 'model' | 'systemPrompt' | 'access'>,
  options: {
    nodeBinary?: string
    scriptPath?: string
    baseEnv?: Record<string, string | undefined>
    platform?: NodeJS.Platform
  } = {},
): AgentCommand {
  const nodeBinary = options.nodeBinary ?? process.execPath
  const scriptPath = options.scriptPath ?? resolveAcpAgentScript(request.provider)
  const baseEnv = options.baseEnv ?? process.env
  const env: Record<string, string> = { ELECTRON_RUN_AS_NODE: '1' }
  const cliVariable = request.provider === 'claude' ? 'CLAUDE_CODE_EXECUTABLE' : 'CODEX_PATH'
  if (!baseEnv[cliVariable]) {
    const found = resolveExecutableOnPath(request.provider, envValue(baseEnv, 'PATH'), {
      platform: options.platform,
    })
    // O SDK do Claude faz spawn sem shell: nao roda .cmd, mas roda .js (com `node` do PATH) e .exe.
    let shim: string | null = null
    if (
      request.provider === 'claude' &&
      (options.platform ?? process.platform) === 'win32' &&
      found &&
      /\.(cmd|bat)$/i.test(found)
    ) {
      shim = resolveNpmShimScript(found)
      if (!shim) throw unsupportedScriptError(found)
    }
    env[cliVariable] = shim ?? found ?? request.provider
  }
  if (request.provider === 'claude') {
    if (request.model) env.ANTHROPIC_MODEL = request.model
  } else {
    const existing = parseJsonObject(baseEnv.CODEX_CONFIG)
    const config: Record<string, unknown> = { ...existing }
    if (request.model) config.model = request.model
    if (request.systemPrompt.trim()) config.developer_instructions = request.systemPrompt
    // Permissao total como o Lider, salvo read_only (sandbox sem escrita no disco).
    // shortcut: no_commit no Codex nao tem trava: ele nao pede permissao (approval never) e o
    // sandbox nao separa git commit de outra escrita; so o prompt do papel pede, ate haver hook.
    config.sandbox_mode = request.access === 'read_only' ? 'read-only' : 'danger-full-access'
    config.approval_policy = 'never'
    if (Object.keys(config).length > 0) env.CODEX_CONFIG = JSON.stringify(config)
  }
  return { command: nodeBinary, args: [scriptPath], env }
}

/** _meta do session/new e session/load. */
export function buildSessionMeta(
  request: Pick<MemberSessionStart, 'provider' | 'systemPrompt' | 'access'>,
): Record<string, unknown> | undefined {
  if (request.provider !== 'claude') return undefined
  const options: Record<string, unknown> = { settingSources: [...CLAUDE_SETTING_SOURCES] }
  // O adaptador soma estes aos dele (acp-agent.js, disallowedTools). Vale no session/load tambem.
  if (request.access === 'read_only') options.disallowedTools = [...READ_ONLY_DISALLOWED_TOOLS]
  const meta: Record<string, unknown> = { claudeCode: { options } }
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
