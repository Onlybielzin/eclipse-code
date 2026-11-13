import { join } from 'node:path'
import { homedir, tmpdir, userInfo } from 'node:os'
import { DATABASE_FILE_NAME, USER_DATA_DIR_NAME, type AppPaths } from '@shared/app'

/**
 * Resolve as pastas proprias do app novo. Nunca aponta para a pasta do app antigo.
 * `configHome` e `runtimeHome` sao injetaveis para teste.
 */
export function resolveAppPaths(
  env: NodeJS.ProcessEnv = process.env,
  configHome = env['XDG_CONFIG_HOME'] || join(homedir(), '.config'),
): AppPaths {
  const userData = join(configHome, USER_DATA_DIR_NAME)
  const runtimeBase = env['XDG_RUNTIME_DIR']
  const runtime = runtimeBase
    ? join(runtimeBase, USER_DATA_DIR_NAME)
    : join(tmpdir(), `${USER_DATA_DIR_NAME}-${userInfo().uid}`)
  return {
    userData,
    database: join(userData, DATABASE_FILE_NAME),
    logs: join(userData, 'logs'),
    runtime,
    worktrees: join(userData, 'worktrees'),
  }
}
