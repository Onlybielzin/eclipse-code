// fastForwardToBase contra repositório git temporário real.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fastForwardToBase } from './fastForward'
import { gitEnv } from './git'

let dir: string

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=Teste', '-c', 'user.email=teste@example.invalid', '-c', 'commit.gpgsign=false', ...args],
    { cwd, env: gitEnv('mutation'), encoding: 'utf8' },
  ).trim()
}

function commit(cwd: string, file: string): void {
  writeFileSync(join(cwd, file), file)
  git(cwd, 'add', file)
  git(cwd, 'commit', '-m', file)
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'eclipse-ff-')))
  git(dir, 'init', '-b', 'main')
  commit(dir, 'a.txt')
  git(dir, 'checkout', '-b', 'feat')
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('fastForwardToBase', () => {
  it('sem commit próprio: avança a branch até a base', async () => {
    git(dir, 'checkout', 'main')
    commit(dir, 'b.txt')
    git(dir, 'checkout', 'feat')
    expect(await fastForwardToBase({ worktreePath: dir, baseBranch: 'main' })).toBe(true)
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(git(dir, 'rev-parse', 'main'))
  })

  it('com commit próprio: não faz merge e devolve false', async () => {
    commit(dir, 'c.txt')
    const head = git(dir, 'rev-parse', 'HEAD')
    git(dir, 'checkout', 'main')
    commit(dir, 'b.txt')
    git(dir, 'checkout', 'feat')
    expect(await fastForwardToBase({ worktreePath: dir, baseBranch: 'main' })).toBe(false)
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(head)
  })

  it('erro do git vira DomainError', async () => {
    await expect(
      fastForwardToBase({ worktreePath: dir, baseBranch: 'nao-existe' }),
    ).rejects.toMatchObject({ code: 'unavailable' })
  })
})
