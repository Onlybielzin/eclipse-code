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
