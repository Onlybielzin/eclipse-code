import { ENV } from '@shared/app'

/**
 * Ambiente dos processos abertos no pty. Copiado de ptyHost/spawnEnv.ts e
 * shared/runtime/stripParentAgentSessionEnv.ts do app antigo.
 */

/**
 * Variaveis que descrevem a sessao do Claude Code que abriu o app (nunca configuracao
 * do usuario). Lista exata: outras CLAUDE_CODE_* e ANTHROPIC_* configuram o provedor.
 */
export const PARENT_AGENT_SESSION_ENV_KEYS = [
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_PID',
] as const

/**
 * Devolve uma copia limpa do ambiente:
 *  - tira as marcas da sessao Claude pai (senao o filho acha que e sessao aninhada);
 *  - tira NO_COLOR/NODE_DISABLE_COLORS herdados de ferramentas (terminal real tem cor);
 *  - tira ELECTRON_RUN_AS_NODE (quebraria ferramentas Electron abertas no terminal),
 *    salvo quando o chamador pede explicitamente com '1' em `keepElectronRunAsNode`.
 *  - remove valores undefined (node-pty exige string).
 */
export function resolvePtySpawnEnv(
  env: Record<string, string | undefined>,
  options: { keepElectronRunAsNode?: boolean } = {},
): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') result[key] = value
  }
  for (const key of PARENT_AGENT_SESSION_ENV_KEYS) delete result[key]
  delete result['NO_COLOR']
  delete result['NODE_DISABLE_COLORS']
  if (!options.keepElectronRunAsNode) delete result['ELECTRON_RUN_AS_NODE']
  if (!result['TERM']) result['TERM'] = 'xterm-256color'
  if (!result['COLORTERM']) result['COLORTERM'] = 'truecolor'
  return result
}

/** Prefixo das variaveis de sessao do app antigo (canvas, CLI `eclipse`, token de controle). */
export const LEGACY_APP_ENV_PREFIX = 'ECLIPSE_CODE_'

/** Pastas que o app antigo poe na frente do PATH (shim do CLI `eclipse` e dos provedores). */
const LEGACY_PATH_SHIM_KEYS = [
  'ECLIPSE_CODE_CLI_SHIM_DIRECTORY',
  'ECLIPSE_CODE_TERMINAL_AGENT_SHIM_DIRECTORY',
] as const

/** Variaveis do proprio app novo que nunca passam de um agente pai para um filho. */
const INHERITED_APP_SECRET_KEYS = [ENV.mcpToken, ENV.mcpSocket] as const

/**
 * Ambiente herdado do processo do app, sem o que pertence a outra sessao:
 *  - nada com prefixo ECLIPSE_CODE_ (o app antigo injeta ECLIPSE_CODE_ENV=1, URL e token de
 *    controle, ids de Space/no e ECLIPSE_CODE_TEAM_RELAY quando o v2 roda de um agente dele;
 *    o Lider e os membros do v2 passariam a criar Spaces e agentes no app ANTIGO);
 *  - sem as pastas de shim do app antigo no PATH;
 *  - ZDOTDIR do terminal do app antigo volta ao original;
 *  - sem token/socket MCP de uma sessao pai (cada agente recebe o proprio).
 * Valores undefined saem (node-pty e spawn exigem string).
 */
export function sanitizeInheritedEnv(
  env: Record<string, string | undefined>,
): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') result[key] = value
  }
  const shimDirs = new Set(
    LEGACY_PATH_SHIM_KEYS.map((key) => result[key]?.trim()).filter(
      (dir): dir is string => !!dir && dir.length > 0,
    ),
  )
  const zshDotDir = result['ECLIPSE_CODE_TERMINAL_AGENT_ZSH_DOT_DIRECTORY']
  const originalZdotdir = result['ECLIPSE_CODE_TERMINAL_AGENT_ORIGINAL_ZDOTDIR']
  if (zshDotDir && result['ZDOTDIR'] === zshDotDir) {
    if (originalZdotdir) result['ZDOTDIR'] = originalZdotdir
    else delete result['ZDOTDIR']
  }
  for (const key of Object.keys(result)) {
    if (key.toUpperCase().startsWith(LEGACY_APP_ENV_PREFIX)) delete result[key]
  }
  for (const key of INHERITED_APP_SECRET_KEYS) delete result[key]
  for (const key of PARENT_AGENT_SESSION_ENV_KEYS) delete result[key]
  if (shimDirs.size > 0) {
    const pathKey = Object.keys(result).find((key) => key.toUpperCase() === 'PATH')
    if (pathKey) {
      result[pathKey] = (result[pathKey] ?? '')
        .split(':')
        .filter((entry) => !shimDirs.has(entry.trim()) && !shimDirs.has(entry.replace(/\/+$/, '')))
        .join(':')
    }
  }
  return result
}
