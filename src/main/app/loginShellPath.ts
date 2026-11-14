import { execFile } from 'node:child_process'
import type { AppLogger } from './teamCoordinator'

const MARKER = '__ECLIPSE_PATH__'
const TIMEOUT_MS = 3000

/** Pastas do shell primeiro; as do processo que faltarem vão no fim. Sem duplicatas. */
export function mergePaths(shellPath: string, currentPath: string, delimiter = ':'): string {
  const dirs = [...shellPath.split(delimiter), ...currentPath.split(delimiter)].filter(Boolean)
  return [...new Set(dirs)].join(delimiter)
}

export type RunShell = (shell: string, args: string[], timeoutMs: number) => Promise<string>

const runShell: RunShell = (shell, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(shell, args, { timeout: timeoutMs, encoding: 'utf8' }, (error, stdout) =>
      error ? reject(error) : resolve(stdout),
    )
  })

/**
 * App aberto pelo menu ou reaberto pelo auto-update herda um PATH curto (sem ~/.local/bin).
 * Lê o PATH do shell de login e grava em env.PATH. Falha nunca quebra a partida.
 */
export async function applyLoginShellPath(options: {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  exec?: RunShell
  log: Pick<AppLogger, 'info' | 'warn'>
}): Promise<void> {
  const env = options.env ?? process.env
  if ((options.platform ?? process.platform) === 'win32') return
  const shell = env['SHELL'] || '/bin/sh'
  try {
    const out = await (options.exec ?? runShell)(
      shell,
      ['-ilc', `printf "\\n${MARKER}%s" "$PATH"`],
      TIMEOUT_MS,
    )
    const at = out.lastIndexOf(MARKER)
    const shellPath = at < 0 ? '' : out.slice(at + MARKER.length).trim()
    if (!shellPath) {
      options.log.warn('PATH do shell de login: saída sem marcador', { shell })
      return
    }
    env['PATH'] = mergePaths(shellPath, env['PATH'] ?? '')
    options.log.info('PATH do shell de login aplicado', { shell })
  } catch (error) {
    options.log.warn('PATH do shell de login indisponível; mantém o atual', {
      shell,
      error: String(error),
    })
  }
}
