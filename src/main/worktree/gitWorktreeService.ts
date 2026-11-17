/**
 * WorktreeService com git (execFile, sem shell). Copiado de
 * src/contexts/worktree/infrastructure/git do app antigo, sem canvas e sem worker
 * remoto. Mantem a correcao de symlink: todo caminho comparado passa por realpath.
 *
 * Uma worktree + branch por tarefa. Branch padrao: feat/<slug do titulo>.
 * Nome em conflito (branch ou pasta) ganha sufixo -2, -3...
 */
import { appendFile, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { DEFAULT_BRANCH_PREFIX, slugify } from '@shared/branch'
import { DomainError } from '@shared/domain'
import type { CreateWorktreeRequest, WorktreeInfo, WorktreeService } from '@shared/ports'
import {
  firstLine,
  runGit,
  toCanonicalPath,
  toCanonicalPathEvenIfMissing,
  type GitResult,
} from './git'

export { DEFAULT_BRANCH_PREFIX, slugify }
const MAX_SUFFIX = 99

function requireAbsolute(path: string, label: string): string {
  const trimmed = path.trim()
  if (!trimmed || !isAbsolute(trimmed)) {
    throw new DomainError('invalid_input', `${label} precisa ser um caminho absoluto`, {
      path,
    })
  }
  return trimmed
}

function gitFailure(result: GitResult, fallback: string): DomainError {
  return new DomainError('internal', firstLine(result.stderr) ?? fallback, {
    exitCode: result.exitCode,
  })
}

async function isDirectoryEmptyOrMissing(path: string): Promise<boolean> {
  try {
    const info = await stat(path)
    if (!info.isDirectory()) return false
    return (await readdir(path)).length === 0
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
    throw error
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

export function parseWorktreePorcelain(stdout: string): WorktreeInfo[] {
  const entries: WorktreeInfo[] = []
  let current: WorktreeInfo | null = null
  const flush = (): void => {
    if (current && current.path.trim()) entries.push(current)
    current = null
  }
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) {
      flush()
      continue
    }
    if (line.startsWith('worktree ')) {
      flush()
      current = { path: line.slice('worktree '.length).trim(), head: null, branch: null }
      continue
    }
    if (!current) continue
    const entry: WorktreeInfo = current
    if (line.startsWith('HEAD ')) entry.head = line.slice('HEAD '.length).trim()
    else if (line.startsWith('branch ')) {
      const ref = line.slice('branch '.length).trim()
      entry.branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref
    } else if (line.trim() === 'detached') entry.branch = null
  }
  flush()
  return entries
}

export class GitWorktreeService implements WorktreeService {
  /** Serializa criacoes/remocoes por repositorio: dois create com o mesmo nome nao colidem. */
  private readonly locks = new Map<string, Promise<unknown>>()

  private async withRepoLock<T>(projectRoot: string, fn: () => Promise<T>): Promise<T> {
    const key = await toCanonicalPath(projectRoot)
    const previous = this.locks.get(key) ?? Promise.resolve()
    const run = previous.catch(() => undefined).then(fn)
    const tail = run.catch(() => undefined)
    this.locks.set(key, tail)
    try {
      return await run
    } finally {
      if (this.locks.get(key) === tail) this.locks.delete(key)
    }
  }

  async isGitRepository(path: string): Promise<boolean> {
    if (!isAbsolute(path)) return false
    try {
      const result = await runGit(['rev-parse', '--is-inside-work-tree'], path, 'observation')
      return result.exitCode === 0 && result.stdout.trim() === 'true'
    } catch {
      return false
    }
  }

  async initRepository(path: string): Promise<void> {
    const root = requireAbsolute(path, 'a pasta do projeto')
    if (!(await this.isGitRepository(root))) {
      const init = await runGit(['init'], root, 'mutation')
      if (init.exitCode !== 0) {
        throw new DomainError('internal', 'Não deu para iniciar o git nesta pasta.', {
          exitCode: init.exitCode,
          stderr: init.stderr.trim(),
        })
      }
    }
    // Sem HEAD (init passou e o commit falhou antes): repetir refaz o commit inicial.
    const head = await runGit(['rev-parse', '--verify', 'HEAD'], root, 'observation')
    if (head.exitCode === 0) return
    const commit = await runGit(
      ['commit', '--allow-empty', '-m', 'Início do repositório'],
      root,
      'mutation',
    )
    if (commit.exitCode !== 0) {
      throw new DomainError(
        'internal',
        'git init feito, mas o primeiro commit falhou. Configure user.name e user.email do git e tente de novo.',
        { exitCode: commit.exitCode, stderr: commit.stderr.trim() },
      )
    }
  }

  private async ensureRepo(projectRoot: string): Promise<void> {
    if (!(await this.isGitRepository(projectRoot))) {
      throw new DomainError('invalid_input', 'a pasta não é um repositório git', {
        path: projectRoot,
      })
    }
  }

  async getDefaultBranch(projectRoot: string): Promise<string | null> {
    const root = requireAbsolute(projectRoot, 'projectRoot')
    await this.ensureRepo(root)

    const remotes = (await runGit(['remote'], root, 'observation')).stdout
      .split(/\r?\n/)
      .map((r) => r.trim())
      .filter(Boolean)
    const remote = remotes.includes('origin') ? 'origin' : (remotes[0] ?? null)

    if (remote) {
      const symbolic = await runGit(
        ['symbolic-ref', '--quiet', `refs/remotes/${remote}/HEAD`],
        root,
        'observation',
      )
      const prefix = `refs/remotes/${remote}/`
      const ref = symbolic.stdout.trim()
      if (symbolic.exitCode === 0 && ref.startsWith(prefix) && ref.length > prefix.length) {
        return ref.slice(prefix.length)
      }
    }

    const refExists = async (ref: string): Promise<boolean> =>
      (await runGit(['show-ref', '--verify', '--quiet', ref], root, 'observation')).exitCode === 0
    for (const candidate of ['main', 'master']) {
      if (remote && (await refExists(`refs/remotes/${remote}/${candidate}`))) return candidate
      if (await refExists(`refs/heads/${candidate}`)) return candidate
    }

    const current = await runGit(['branch', '--show-current'], root, 'observation')
    return current.exitCode === 0 ? firstLine(current.stdout) : null
  }

  async list(projectRoot: string): Promise<WorktreeInfo[]> {
    const root = requireAbsolute(projectRoot, 'projectRoot')
    await this.ensureRepo(root)
    const result = await runGit(['worktree', 'list', '--porcelain'], root, 'observation')
    if (result.exitCode !== 0) throw gitFailure(result, 'git worktree list falhou')
    return Promise.all(
      parseWorktreePorcelain(result.stdout).map(async (entry) => ({
        ...entry,
        path: await toCanonicalPath(entry.path),
      })),
    )
  }

  private async listBranches(root: string): Promise<Set<string>> {
    const result = await runGit(
      ['for-each-ref', '--format=%(refname:short)', 'refs/heads'],
      root,
      'observation',
    )
    if (result.exitCode !== 0) throw gitFailure(result, 'git branch list falhou')
    return new Set(
      result.stdout
        .split(/\r?\n/)
        .map((b) => b.trim())
        .filter(Boolean),
    )
  }

  async create(request: CreateWorktreeRequest): Promise<WorktreeInfo & { baseBranch: string }> {
    const root = requireAbsolute(request.projectRoot, 'projectRoot')
    const worktreesRoot = requireAbsolute(request.worktreesRoot, 'worktreesRoot')
    return this.withRepoLock(root, async () => {
      await this.ensureRepo(root)
      const hasCommits = await runGit(
        ['rev-parse', '--verify', '--quiet', 'HEAD'],
        root,
        'observation',
      )
      if (hasCommits.exitCode !== 0) {
        throw new DomainError('invalid_input', 'o repositório ainda não tem commits')
      }

      const slug = slugify(request.name)
      const requestedBranch = request.branch?.trim() || `${DEFAULT_BRANCH_PREFIX}${slug}`
      const refCheck = await runGit(
        ['check-ref-format', '--branch', requestedBranch],
        root,
        'observation',
      )
      if (refCheck.exitCode !== 0) {
        throw new DomainError('invalid_input', `nome de branch inválido: ${requestedBranch}`)
      }

      const baseBranch = request.baseBranch?.trim() || (await this.getDefaultBranch(root))
      if (!baseBranch) {
        throw new DomainError('invalid_input', 'não foi possível descobrir a branch de origem')
      }
      const baseCheck = await runGit(
        ['rev-parse', '--verify', '--quiet', `${baseBranch}^{commit}`],
        root,
        'observation',
      )
      if (baseCheck.exitCode !== 0) {
        throw new DomainError('invalid_input', `branch de origem não existe: ${baseBranch}`)
      }

      const branches = await this.listBranches(root)
      const branch = pickFree(requestedBranch, (candidate) => !branches.has(candidate))
      if (!branch)
        throw new DomainError('conflict', `sem nome livre para a branch ${requestedBranch}`)

      await mkdir(worktreesRoot, { recursive: true })
      await excludeWorktreesRootFromGit(root, worktreesRoot)
      const canonicalRoot = await toCanonicalPath(worktreesRoot)
      const registered = new Set((await this.list(root)).map((w) => w.path))
      const dirSeed = slugify(
        branch.startsWith(DEFAULT_BRANCH_PREFIX)
          ? branch.slice(DEFAULT_BRANCH_PREFIX.length)
          : branch,
      )
      let path: string | null = null
      for (let i = 1; i <= MAX_SUFFIX && !path; i++) {
        const candidate = await toCanonicalPathEvenIfMissing(
          join(canonicalRoot, i === 1 ? dirSeed : `${dirSeed}-${i}`),
        )
        if (!registered.has(candidate) && (await isDirectoryEmptyOrMissing(candidate))) {
          path = candidate
        }
      }
      if (!path) throw new DomainError('conflict', 'sem pasta livre para a worktree')

      const add = await runGit(
        ['worktree', 'add', '-b', branch, path, baseBranch],
        root,
        'mutation',
      )
      if (add.exitCode !== 0) throw gitFailure(add, 'git worktree add falhou')

      const head = await runGit(['rev-parse', 'HEAD'], path, 'observation')
      return {
        path: await toCanonicalPath(path),
        branch,
        head: head.exitCode === 0 ? firstLine(head.stdout) : null,
        baseBranch,
      }
    })
  }

  async remove(request: {
    projectRoot: string
    worktreePath: string
    branch: string | null
    deleteBranch: boolean
    force: boolean
  }): Promise<void> {
    const root = requireAbsolute(request.projectRoot, 'projectRoot')
    const target = requireAbsolute(request.worktreePath, 'worktreePath')
    await this.withRepoLock(root, async () => {
      await this.ensureRepo(root)
      const canonicalRoot = await toCanonicalPath(root)
      const canonicalTarget = await toCanonicalPathEvenIfMissing(target)
      const worktrees = await this.list(root)
      const main = worktrees[0]?.path ?? canonicalRoot
      if (canonicalTarget === canonicalRoot || canonicalTarget === main) {
        throw new DomainError('invalid_input', 'não é possível remover a worktree principal')
      }
      const entry = worktrees.find((w) => w.path === canonicalTarget) ?? null
      const branch = entry?.branch ?? request.branch

      if (entry) {
        if (!request.force) await assertNoUncommittedChanges(entry.path)
        const args = ['worktree', 'remove', ...(request.force ? ['--force'] : []), entry.path]
        const result = await runGit(args, root, 'mutation')
        const still = (await this.list(root)).some((w) => w.path === canonicalTarget)
        if (still) throw gitFailure(result, 'git worktree remove falhou')
        await rm(entry.path, { recursive: true, force: true, maxRetries: 2, retryDelay: 150 })
      } else {
        // Ja nao esta registrada (apagada a mao): so limpa o registro do git.
        await runGit(['worktree', 'prune'], root, 'mutation')
      }

      if (request.deleteBranch && branch) {
        const exists = await runGit(
          ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`],
          root,
          'observation',
        )
        if (exists.exitCode === 0) {
          const del = await runGit(['branch', '-D', branch], root, 'mutation')
          if (del.exitCode !== 0) {
            throw new DomainError(
              'internal',
              `worktree removida, mas a branch ${branch} não foi apagada: ${firstLine(del.stderr) ?? ''}`,
              { worktreeRemoved: true, branch },
            )
          }
        }
      }
    })
  }
}

function pickFree(base: string, isFree: (candidate: string) => boolean): string | null {
  for (let i = 1; i <= MAX_SUFFIX; i++) {
    const candidate = i === 1 ? base : `${base}-${i}`
    if (isFree(candidate)) return candidate
  }
  return null
}

async function assertNoUncommittedChanges(worktreePath: string): Promise<void> {
  if (!(await pathExists(worktreePath))) return
  const status = await runGit(
    ['status', '--porcelain', '--untracked-files=all'],
    worktreePath,
    'observation',
  )
  if (status.exitCode !== 0) return
  const changed = status.stdout.split(/\r?\n/).filter((l) => l.trim()).length
  if (changed > 0) {
    throw new DomainError(
      'conflict',
      `a worktree tem ${changed} arquivo(s) sem commit; faça commit ou force a remoção`,
      { changedFileCount: changed },
    )
  }
}

/**
 * Pasta de worktrees dentro do repo apareceria como nao rastreada no git status.
 * Esconde com uma linha em info/exclude (nunca commitado). Melhor esforco.
 */
export async function excludeWorktreesRootFromGit(
  repoPath: string,
  worktreesRoot: string,
): Promise<void> {
  try {
    const canonicalRepo = await toCanonicalPath(repoPath)
    const canonicalRoot = await toCanonicalPathEvenIfMissing(worktreesRoot)
    const rel = relative(canonicalRepo, canonicalRoot)
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return
    const ignored = await runGit(['check-ignore', '-q', '--', rel], canonicalRepo, 'observation')
    if (ignored.exitCode === 0) return
    const commonDir = await runGit(['rev-parse', '--git-common-dir'], canonicalRepo, 'observation')
    const gitDir = commonDir.stdout.trim()
    if (commonDir.exitCode !== 0 || !gitDir) return
    const excludePath = resolve(canonicalRepo, gitDir, 'info', 'exclude')
    const pattern = `/${rel.split(sep).join('/')}/`
    const current = await readFile(excludePath, 'utf8').catch(() => '')
    if (current.split(/\r?\n/).some((line) => line.trim() === pattern)) return
    await mkdir(dirname(excludePath), { recursive: true })
    const separator = current.length > 0 && !current.endsWith('\n') ? '\n' : ''
    await appendFile(excludePath, `${separator}# Eclipse Code worktrees\n${pattern}\n`, 'utf8')
  } catch {
    // Pasta visivel no status e cosmetico; worktree que falha nao e.
  }
}

export function createWorktreeService(): GitWorktreeService {
  return new GitWorktreeService()
}
