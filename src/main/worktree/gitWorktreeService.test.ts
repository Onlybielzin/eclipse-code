// WorktreeService contra repositórios git temporários reais.
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DomainError } from '@shared/domain'
import { GitWorktreeService, parseWorktreePorcelain, slugify } from './gitWorktreeService'
import { gitEnv } from './git'

let base: string
let repo: string
let worktreesRoot: string
const service = new GitWorktreeService()

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=Teste',
      '-c',
      'user.email=teste@example.invalid',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd, env: gitEnv('mutation'), encoding: 'utf8' },
  ).trim()
}

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    if (error instanceof DomainError) return error.code
    throw error
  }
  throw new Error('esperava DomainError')
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'eclipse-next-wt-')))
  repo = join(base, 'repo')
  mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'README.md'), 'oi\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'inicio')
  worktreesRoot = join(base, 'worktrees')
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

describe('slugify', () => {
  it('tira acento, símbolo e limita o tamanho', () => {
    expect(slugify('Corrigir Login Já!')).toBe('corrigir-login-ja')
    expect(slugify('  ---  ')).toBe('tarefa')
    expect(slugify('a'.repeat(80))).toHaveLength(48)
  })
})

describe('parseWorktreePorcelain', () => {
  it('lê caminho, HEAD, branch e detached', () => {
    const out = [
      'worktree /r',
      'HEAD abc',
      'branch refs/heads/main',
      '',
      'worktree /w',
      'HEAD def',
      'detached',
      '',
    ].join('\n')
    expect(parseWorktreePorcelain(out)).toEqual([
      { path: '/r', head: 'abc', branch: 'main' },
      { path: '/w', head: 'def', branch: null },
    ])
  })
})

describe('GitWorktreeService', () => {
  it('reconhece repositório e branch padrão', async () => {
    expect(await service.isGitRepository(repo)).toBe(true)
    expect(await service.isGitRepository(base)).toBe(false)
    expect(await service.isGitRepository('relativo')).toBe(false)
    expect(await service.getDefaultBranch(repo)).toBe('main')
  })

  it('cria worktree com branch feat/<slug> saindo da branch padrão', async () => {
    const wt = await service.create({ projectRoot: repo, worktreesRoot, name: 'Corrigir Login Já' })
    expect(wt.branch).toBe('feat/corrigir-login-ja')
    expect(wt.baseBranch).toBe('main')
    expect(wt.path).toBe(join(worktreesRoot, 'corrigir-login-ja'))
    expect(wt.head).toBe(git(repo, 'rev-parse', 'main'))
    expect(existsSync(join(wt.path, 'README.md'))).toBe(true)
    const listed = await service.list(repo)
    expect(listed.map((w) => [w.path, w.branch])).toEqual([
      [repo, 'main'],
      [wt.path, 'feat/corrigir-login-ja'],
    ])
  })

  it('nome em conflito ganha sufixo na branch e na pasta', async () => {
    git(repo, 'branch', 'feat/login')
    const a = await service.create({ projectRoot: repo, worktreesRoot, name: 'login' })
    const b = await service.create({ projectRoot: repo, worktreesRoot, name: 'login' })
    expect(a.branch).toBe('feat/login-2')
    expect(b.branch).toBe('feat/login-3')
    expect(new Set([a.path, b.path]).size).toBe(2)
  })

  it('criações simultâneas com o mesmo nome não colidem', async () => {
    const results = await Promise.all(
      [1, 2, 3].map(() => service.create({ projectRoot: repo, worktreesRoot, name: 'paralelo' })),
    )
    expect(results.map((r) => r.branch).sort()).toEqual([
      'feat/paralelo',
      'feat/paralelo-2',
      'feat/paralelo-3',
    ])
  })

  it('respeita branch e origem explícitas; recusa origem inexistente e nome inválido', async () => {
    git(repo, 'checkout', '-q', '-b', 'dev')
    writeFileSync(join(repo, 'dev.txt'), 'dev\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'dev')
    git(repo, 'checkout', '-q', 'main')
    const wt = await service.create({
      projectRoot: repo,
      worktreesRoot,
      name: 'x',
      branch: 'eclipse/minha',
      baseBranch: 'dev',
    })
    expect(wt).toMatchObject({ branch: 'eclipse/minha', baseBranch: 'dev' })
    expect(existsSync(join(wt.path, 'dev.txt'))).toBe(true)
    expect(
      await code(
        service.create({ projectRoot: repo, worktreesRoot, name: 'y', baseBranch: 'nao-existe' }),
      ),
    ).toBe('invalid_input')
    expect(
      await code(
        service.create({ projectRoot: repo, worktreesRoot, name: 'y', branch: 'feat/a..b' }),
      ),
    ).toBe('invalid_input')
  })

  it('recusa pasta que não é git e repositório sem commits', async () => {
    expect(await code(service.create({ projectRoot: base, worktreesRoot, name: 'a' }))).toBe(
      'invalid_input',
    )
    const empty = join(base, 'vazio')
    mkdirSync(empty)
    git(empty, 'init', '-q')
    expect(await code(service.create({ projectRoot: empty, worktreesRoot, name: 'a' }))).toBe(
      'invalid_input',
    )
  })

  it('pasta de worktrees dentro do repo vai para info/exclude', async () => {
    const inside = join(repo, '.eclipse-next', 'worktrees')
    await service.create({ projectRoot: repo, worktreesRoot: inside, name: 'dentro' })
    expect(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8')).toContain(
      '/.eclipse-next/worktrees/',
    )
    expect(git(repo, 'status', '--porcelain')).toBe('')
  })

  it('symlink: repo e pasta de worktrees por link casam com o caminho real', async () => {
    const repoLink = join(base, 'repo-link')
    const rootLink = join(base, 'wt-link')
    mkdirSync(worktreesRoot)
    symlinkSync(repo, repoLink)
    symlinkSync(worktreesRoot, rootLink)
    const wt = await service.create({
      projectRoot: repoLink,
      worktreesRoot: rootLink,
      name: 'link',
    })
    expect(wt.path).toBe(join(worktreesRoot, 'link'))
    expect((await service.list(repoLink)).map((w) => w.path)).toContain(wt.path)
    // Remove passando o caminho pelo link.
    await service.remove({
      projectRoot: repoLink,
      worktreePath: join(rootLink, 'link'),
      branch: wt.branch,
      deleteBranch: true,
      force: false,
    })
    expect(existsSync(wt.path)).toBe(false)
    expect(git(repo, 'branch', '--list', 'feat/link')).toBe('')
  })

  it('remove recusa mudança sem commit, a menos que force', async () => {
    const wt = await service.create({ projectRoot: repo, worktreesRoot, name: 'sujo' })
    writeFileSync(join(wt.path, 'novo.txt'), 'x\n')
    const req = {
      projectRoot: repo,
      worktreePath: wt.path,
      branch: wt.branch,
      deleteBranch: true,
      force: false,
    }
    expect(await code(service.remove(req))).toBe('conflict')
    expect(existsSync(wt.path)).toBe(true)
    await service.remove({ ...req, force: true })
    expect(existsSync(wt.path)).toBe(false)
    expect((await service.list(repo)).map((w) => w.path)).toEqual([repo])
    expect(git(repo, 'branch', '--list', 'feat/sujo')).toBe('')
  })

  it('remove mantém a branch quando pedido e nunca remove a worktree principal', async () => {
    const wt = await service.create({ projectRoot: repo, worktreesRoot, name: 'fica' })
    await service.remove({
      projectRoot: repo,
      worktreePath: wt.path,
      branch: wt.branch,
      deleteBranch: false,
      force: false,
    })
    expect(git(repo, 'branch', '--list', 'feat/fica')).toContain('feat/fica')
    expect(
      await code(
        service.remove({
          projectRoot: repo,
          worktreePath: repo,
          branch: 'main',
          deleteBranch: true,
          force: true,
        }),
      ),
    ).toBe('invalid_input')
  })

  it('worktree apagada à mão: remove só limpa o registro e a branch', async () => {
    const wt = await service.create({ projectRoot: repo, worktreesRoot, name: 'sumiu' })
    rmSync(wt.path, { recursive: true, force: true })
    await service.remove({
      projectRoot: repo,
      worktreePath: wt.path,
      branch: wt.branch,
      deleteBranch: true,
      force: false,
    })
    expect((await service.list(repo)).map((w) => w.path)).toEqual([repo])
    expect(git(repo, 'branch', '--list', 'feat/sumiu')).toBe('')
  })
})
