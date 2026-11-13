import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'

/**
 * Acha o executavel no PATH do ambiente que o agente vai receber, na ordem do PATH.
 * Assim o wrapper de rodizio de contas (~/.local/claude-rodizio/bin/claude), que vem
 * antes no PATH do usuario, e o escolhido. Nunca procura fora do PATH.
 */
export function resolveExecutableOnPath(
  command: string,
  pathValue: string | undefined,
): string | null {
  if (command.length === 0) return null
  if (isAbsolute(command) || command.includes('/')) {
    return isExecutableFile(command) ? command : null
  }
  for (const directory of (pathValue ?? '').split(delimiter)) {
    if (!directory) continue
    const candidate = join(directory, command)
    if (isExecutableFile(candidate)) return candidate
  }
  return null
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}
