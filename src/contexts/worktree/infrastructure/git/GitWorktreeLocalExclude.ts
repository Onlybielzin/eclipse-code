import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { runGit } from './GitWorktreeService.shared'

/**
 * A worktrees root inside the repository (the default `.eclipse-code/worktrees`) would show up as
 * untracked in `git status`. Hide it the way Git itself recommends for local-only paths: a line in
 * the repository's `info/exclude`, which is never committed. Best effort: creating the worktree
 * never fails because of this.
 */
export async function excludeWorktreesRootFromGit(
  repoPath: string,
  worktreesRoot: string,
): Promise<void> {
  try {
    const relativeRoot = relative(resolve(repoPath), resolve(worktreesRoot))
    if (relativeRoot.length === 0 || relativeRoot.startsWith('..') || isAbsolute(relativeRoot)) {
      return
    }

    const ignored = await runGit(['check-ignore', '-q', '--', relativeRoot], repoPath, {
      intent: 'observation',
    })
    if (ignored.exitCode === 0) {
      return
    }

    const commonDir = await runGit(['rev-parse', '--git-common-dir'], repoPath, {
      intent: 'observation',
    })
    const gitDir = commonDir.stdout.trim()
    if (commonDir.exitCode !== 0 || gitDir.length === 0) {
      return
    }

    const excludePath = resolve(repoPath, gitDir, 'info', 'exclude')
    const pattern = `/${relativeRoot.split(sep).join('/')}/`
    const current = await readFile(excludePath, 'utf8').catch(() => '')
    if (current.split(/\r?\n/).some(line => line.trim() === pattern)) {
      return
    }

    await mkdir(dirname(excludePath), { recursive: true })
    const separator = current.length > 0 && !current.endsWith('\n') ? '\n' : ''
    await appendFile(excludePath, `${separator}# Eclipse Code worktrees\n${pattern}\n`, 'utf8')
  } catch {
    // Best effort: an unhidden directory is cosmetic; a failed worktree is not.
  }
}
