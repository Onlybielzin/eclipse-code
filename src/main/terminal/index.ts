/**
 * terminal/: hospedeiro de pty. Implementa PtyHost (src/shared/ports.ts).
 *
 * Origem: /data/Projects/eclipse-code/src/platform/process/ptyHost e pty
 * (sem worker remoto, sem utilityProcess, sem Windows console observer).
 */
export { createPtyHost, toPtyExit, waitForPtyExit } from './ptyHost'
export type { PtyHostOptions, PtyProcessLike, SpawnPty } from './ptyHost'
export { ScrollbackBuffer, DEFAULT_SCROLLBACK_CHARS } from './scrollback'
export { resolvePtySpawnEnv, PARENT_AGENT_SESSION_ENV_KEYS } from './spawnEnv'
export { ensureNodePtySpawnHelperExecutable } from './spawnHelperPermissions'
