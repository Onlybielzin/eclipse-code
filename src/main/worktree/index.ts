/**
 * worktree/: uma worktree + branch por tarefa. Implementa WorktreeService
 * (src/shared/ports.ts) com git via execFile, sem shell.
 *
 * Origem: /data/Projects/eclipse-code/src/contexts/worktree (com a correcao de
 * symlink: todo caminho comparado passa por realpath).
 */
export {
  DEFAULT_BRANCH_PREFIX,
  GitWorktreeService,
  createWorktreeService,
  excludeWorktreesRootFromGit,
  parseWorktreePorcelain,
  slugify,
} from './gitWorktreeService'
export { runGit, toCanonicalPath, toCanonicalPathEvenIfMissing } from './git'
