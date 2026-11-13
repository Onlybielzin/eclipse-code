import { chmodSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'

/**
 * node-pty usa um `spawn-helper` que as vezes perde o bit de execucao ao ser
 * desempacotado (asar, pnpm). Copiado de ptyHost/spawnHelperPermissions.ts.
 */
interface SpawnHelperDeps {
  requireResolve: (specifier: string) => string
  statSync: typeof statSync
  chmodSync: typeof chmodSync
  platform: NodeJS.Platform
  arch: string
}

const require = createRequire(import.meta.url)

function normalizeAsarPath(value: string): string {
  return value
    .replace('app.asar', 'app.asar.unpacked')
    .replace('node_modules.asar', 'node_modules.asar.unpacked')
}

export function resolveNodePtySpawnHelperPaths(
  deps: Pick<SpawnHelperDeps, 'requireResolve' | 'platform' | 'arch'>,
): string[] {
  const unixTerminalPath = deps.requireResolve('node-pty/lib/unixTerminal.js')
  const packageRoot = normalizeAsarPath(resolve(dirname(unixTerminalPath), '..'))
  return [
    resolve(packageRoot, 'prebuilds', `${deps.platform}-${deps.arch}`, 'spawn-helper'),
    resolve(packageRoot, 'build', 'Release', 'spawn-helper'),
    resolve(packageRoot, 'build', 'Debug', 'spawn-helper'),
  ]
}

export function ensureNodePtySpawnHelperExecutable(
  deps: SpawnHelperDeps = {
    requireResolve: require.resolve.bind(require),
    statSync,
    chmodSync,
    platform: process.platform,
    arch: process.arch,
  },
): boolean {
  let updated = false
  let paths: string[]
  try {
    paths = resolveNodePtySpawnHelperPaths(deps)
  } catch {
    return false
  }
  for (const helperPath of paths) {
    try {
      const stats = deps.statSync(helperPath)
      if ((stats.mode & 0o111) !== 0) continue
      deps.chmodSync(helperPath, (stats.mode & 0o777) | 0o755)
      updated = true
    } catch {
      // Candidato ausente ou sem permissao: ignorar.
    }
  }
  return updated
}
