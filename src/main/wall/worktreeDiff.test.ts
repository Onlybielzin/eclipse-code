// Diff da worktree contra repositórios git temporários reais.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { gitEnv } from '../worktree/git'
import { readWorktreeDiff } from './worktreeDiff'

let dir: string
function git(...args: string[]): void {
  execFileSync(
    'git',
    ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args],
    { cwd: dir, env: gitEnv('mutation') },
  )
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wall-diff-'))
  git('init', '-q', '-b', 'main')
  writeFileSync(join(dir, 'a.txt'), 'um\ndois\n')
  writeFileSync(join(dir, 'b.txt'), 'x\n')
  git('add', '.')
  git('commit', '-q', '-m', 'base')
  git('checkout', '-q', '-b', 'feat')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('readWorktreeDiff', () => {
  it('conta +/- do que não foi commitado e devolve as últimas linhas do arquivo mais novo', async () => {
    writeFileSync(join(dir, 'a.txt'), 'um\nnovo1\nnovo2\n') // -1 (dois) +2
    writeFileSync(join(dir, 'b.txt'), `x\n${'y'.repeat(300)}\n`) // +1
    const past = new Date(Date.now() - 60_000)
    utimesSync(join(dir, 'a.txt'), past, past)
    const r = await readWorktreeDiff(dir, 'main')
    expect(r.linesAdded).toBe(3)
    expect(r.linesRemoved).toBe(1)
    expect(r.lastFile).toBe('b.txt')
    expect(r.lastLines).toHaveLength(1)
    expect(r.lastLines[0]!.startsWith('+y')).toBe(true)
    expect(r.lastLines[0]!.length).toBeLessThanOrEqual(160)
  })

  it('inclui o que já foi commitado na branch e limita a 6 linhas', async () => {
    writeFileSync(join(dir, 'a.txt'), Array.from({ length: 10 }, (_, i) => `l${i}`).join('\n') + '\n')
    git('commit', '-q', '-am', 'feat')
    const r = await readWorktreeDiff(dir, 'main')
    expect(r.linesAdded).toBe(10)
    expect(r.linesRemoved).toBe(2)
    expect(r.lastFile).toBe('a.txt')
    expect(r.lastLines).toHaveLength(6)
    expect(r.lastLines.at(-1)).toBe('+l9')
  })

  it('pasta sumida ou sem git devolve zeros', async () => {
    const zero = { linesAdded: 0, linesRemoved: 0, lastFile: null, lastLines: [] }
    expect(await readWorktreeDiff(join(dir, 'nao-existe'), 'main')).toEqual(zero)
    const plain = mkdtempSync(join(tmpdir(), 'wall-plain-'))
    try {
      expect(await readWorktreeDiff(plain, 'main')).toEqual(zero)
    } finally {
      rmSync(plain, { recursive: true, force: true })
    }
  })

  it('nome com acento, binário e linha que começa com "++"', async () => {
    writeFileSync(join(dir, 'ação.ts'), '++contador;\n--x;\n')
    writeFileSync(join(dir, 'img.bin'), Buffer.from([0, 1, 2, 0, 255]))
    git('add', '.')
    const past = new Date(Date.now() - 60_000)
    utimesSync(join(dir, 'img.bin'), past, past)
    const r = await readWorktreeDiff(dir, 'main')
    expect(r.linesAdded).toBe(2)
    expect(r.lastFile).toBe('ação.ts')
    expect(r.lastLines).toEqual(['+++contador;', '+--x;'])
  })

  it('base que avançou depois da worktree: só conta o que a tarefa mudou', async () => {
    writeFileSync(join(dir, 'a.txt'), 'um\ndois\ntres\n')
    git('commit', '-q', '-am', 'feat')
    git('checkout', '-q', 'main')
    writeFileSync(join(dir, 'c.txt'), '1\n2\n3\n4\n5\n')
    git('add', '.')
    git('commit', '-q', '-m', 'main avancou')
    git('checkout', '-q', 'feat')
    const r = await readWorktreeDiff(dir, 'main')
    expect(r.linesAdded).toBe(1)
    expect(r.linesRemoved).toBe(0)
    expect(r.lastFile).toBe('a.txt')
  })
})
