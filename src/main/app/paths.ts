import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { homedir, tmpdir, userInfo } from 'node:os'
import { DATABASE_FILE_NAME, USER_DATA_DIR_NAME, type AppPaths } from '@shared/app'

/**
 * Resolve as pastas proprias do app novo. Nunca aponta para a pasta do app antigo.
 * `configHome` e `runtimeHome` sao injetaveis para teste.
 *
 * `userDataOverride` vem do switch --user-data-dir do Chromium. Com ele, dados e socket
 * ficam fora da instalacao normal: a pasta de runtime ganha um sufixo derivado do
 * caminho, para que uma instancia de teste nunca apague o socket da instancia em uso.
 */
export function resolveAppPaths(
  env: NodeJS.ProcessEnv = process.env,
  configHome = env['XDG_CONFIG_HOME'] || join(homedir(), '.config'),
  userDataOverride?: string,
): AppPaths {
  const userData = userDataOverride
    ? resolve(userDataOverride)
    : join(configHome, USER_DATA_DIR_NAME)
  const runtimeName = userDataOverride
    ? `${USER_DATA_DIR_NAME}-${createHash('sha256').update(userData).digest('hex').slice(0, 8)}`
    : USER_DATA_DIR_NAME
  const runtimeBase = env['XDG_RUNTIME_DIR']
  const runtime = runtimeBase
    ? join(runtimeBase, runtimeName)
    : join(tmpdir(), `${runtimeName}-${userInfo().uid}`)
  return {
    userData,
    database: join(userData, DATABASE_FILE_NAME),
    logs: join(userData, 'logs'),
    runtime,
    worktrees: join(userData, 'worktrees'),
  }
}
