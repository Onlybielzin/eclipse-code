import { DomainError } from '@shared/domain'
import { runGit } from './git'

/**
 * Traz o codigo da base para a worktree (`git merge --ff-only <base>`) quando a branch ainda nao
 * tem commit proprio. Devolve false, sem mexer em nada, se a branch tem commit proprio.
 */
export async function fastForwardToBase(request: {
  worktreePath: string
  baseBranch: string
}): Promise<boolean> {
  const { worktreePath, baseBranch } = request
  const ahead = await runGit(['rev-list', '--count', `${baseBranch}..HEAD`], worktreePath, 'observation')
  if (ahead.exitCode !== 0) {
    throw new DomainError('unavailable', 'não foi possível comparar a branch com a base', {
      debug: ahead.stderr.trim(),
    })
  }
  if (Number(ahead.stdout.trim()) > 0) return false
  const merged = await runGit(['merge', '--ff-only', baseBranch], worktreePath, 'mutation')
  if (merged.exitCode !== 0) {
    throw new DomainError('conflict', 'não foi possível trazer o código da base para a worktree', {
      debug: merged.stderr.trim(),
    })
  }
  return true
}
