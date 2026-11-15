import { accessSync, constants, lstatSync, readFileSync, statSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import { DomainError } from '@shared/domain'

export interface ExecutableLookupOptions {
  platform?: NodeJS.Platform
  /** PATHEXT do Windows. Padrao: process.env.PATHEXT ou `.COM;.EXE;.BAT;.CMD`. */
  pathExt?: string
}

/**
 * Acha o executavel no PATH do ambiente que o agente vai receber, na ordem do PATH.
 * Assim o wrapper de rodizio de contas (~/.local/claude-rodizio/bin/claude), que vem
 * antes no PATH do usuario, e o escolhido. Nunca procura fora do PATH.
 * No win32 tenta as extensoes do PATHEXT, na ordem, e nao exige X_OK.
 */
export function resolveExecutableOnPath(
  command: string,
  pathValue: string | undefined,
  options: ExecutableLookupOptions = {},
): string | null {
  if (command.length === 0) return null
  const win = (options.platform ?? process.platform) === 'win32'
  const extensions = win
    ? (options.pathExt ?? process.env['PATHEXT'] ?? '').split(';').filter(Boolean)
    : []
  if (win && extensions.length === 0) extensions.push('.COM', '.EXE', '.BAT', '.CMD')
  const variants = (base: string): string[] =>
    win
      ? [
          ...(extensions.some((ext) => base.toLowerCase().endsWith(ext.toLowerCase()))
            ? [base]
            : []),
          ...extensions.map((ext) => base + ext),
        ]
      : [base]
  const isFile = (path: string) => isExecutableFile(path, win)
  if (isAbsolute(command) || command.includes('/') || (win && command.includes('\\'))) {
    return variants(command).find(isFile) ?? null
  }
  for (const raw of (pathValue ?? '').split(win ? ';' : delimiter)) {
    // O Windows aceita aspas numa entrada do PATH ("C:\\Program Files\\x").
    const directory = win ? raw.replace(/^"(.*)"$/, '$1') : raw
    if (!directory) continue
    const found = variants(join(directory, command)).find(isFile)
    if (found) return found
  }
  return null
}

/**
 * Linha do shim do npm (cmd-shim): `"%_prog%" "%dp0%\\node_modules\\...\\x.js" %*`.
 * O alvo tambem pode ser um binario nativo (`...\\bin\\claude.exe`), como no claude-code recente.
 */
const NPM_SHIM_SCRIPT = /"%(?:~dp0|dp0%)\\([^"\r\n]+\.(?:(?:c|m)?js|exe))"/gi

/**
 * node-pty no Windows nao roda .cmd/.bat (CreateProcess nao os trata como programa), e
 * passa-los por cmd.exe deixaria o texto do prompt virar operador (`&`, `|`, `%`).
 * Por isso um shim do npm vira `node.exe <script.js> ...args`, sem cmd.exe. Qualquer outro
 * .cmd/.bat, ou shim sem node no PATH, e erro. Outros casos ficam como estao.
 */
export function wrapWindowsScript(
  executable: string,
  args: string[],
  pathValue: string | undefined,
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } {
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(executable)) {
    return { command: executable, args }
  }
  const script = resolveNpmShimScript(executable)
  if (script && /\.exe$/i.test(script)) return { command: script, args }
  const node = script ? resolveExecutableOnPath('node', pathValue, { platform }) : null
  if (!script || !node) throw unsupportedScriptError(executable)
  return { command: node, args: [script, ...args] }
}

export function unsupportedScriptError(executable: string): DomainError {
  return new DomainError(
    'unavailable',
    `O comando foi encontrado como script .cmd (${executable}) e não pode rodar direto. ` +
      'Instale a versão nativa (.exe) ou deixe o node no PATH.',
    { executable },
  )
}

/** Caminho absoluto do alvo (.js ou .exe) de um shim do npm, ou null se o .cmd nao for um shim. */
export function resolveNpmShimScript(cmdPath: string): string | null {
  let text: string
  try {
    text = readFileSync(cmdPath, 'utf8')
  } catch {
    return null
  }
  // A linha de execucao e a ultima; antes dela o shim testa `"%dp0%\node.exe"`.
  const relative = [...text.matchAll(NPM_SHIM_SCRIPT)].at(-1)?.[1]
  return relative ? join(dirname(cmdPath), ...relative.split('\\')) : null
}

function isExecutableFile(path: string, skipExecuteBit: boolean): boolean {
  try {
    if (!statSync(path).isFile()) return false
    if (!skipExecuteBit) accessSync(path, constants.X_OK)
    return true
  } catch {
    // Alias de app do Windows (WindowsApps\\wt.exe) e um reparse point que o stat nao segue.
    if (!skipExecuteBit) return false
    try {
      return lstatSync(path).isSymbolicLink()
    } catch {
      return false
    }
  }
}
