import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveExecutableOnPath } from './executable'
import {
  defaultSessionLocatorDirs,
  encodeClaudeProjectPath,
  findClaudeTranscript,
  findCodexSessionFile,
  locateProviderSessionId,
  type SessionLocatorDirs,
} from './sessionLocator'

const roots: string[] = []
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  roots.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function codexRollout(home: string, at: Date, id: string, cwd: string): string {
  const dir = join(
    home,
    'sessions',
    String(at.getFullYear()),
    String(at.getMonth() + 1).padStart(2, '0'),
    String(at.getDate()).padStart(2, '0'),
  )
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `rollout-${at.toISOString().replace(/[:.]/g, '-')}-${id}.jsonl`)
  writeFileSync(
    file,
    `${JSON.stringify({ type: 'session_meta', timestamp: at.toISOString(), payload: { id, cwd, timestamp: at.toISOString() } })}\n`,
  )
  return file
}

describe('locateProviderSessionId', () => {
  it('Codex: acha o rollout do cwd mais proximo do inicio', async () => {
    const home = tempDir('codex-home-')
    const dirs: SessionLocatorDirs = { claudeConfigDirs: [], codexHomes: [home] }
    const startedAt = Date.now()
    codexRollout(home, new Date(startedAt + 800), 'th-certo', '/tmp/wt-a')
    codexRollout(home, new Date(startedAt + 300), 'th-outro-cwd', '/tmp/wt-b')
    codexRollout(home, new Date(startedAt - 60_000), 'th-antigo', '/tmp/wt-a')
    const id = await locateProviderSessionId(
      { provider: 'codex', cwd: '/tmp/wt-a', startedAt, timeoutMs: 0 },
      { dirs, now: Date.now, sleep: async () => undefined },
    )
    expect(id).toBe('th-certo')
    expect(await findCodexSessionFile('th-certo', dirs)).toMatch(/th-certo\.jsonl$/)
    expect(await findCodexSessionFile('nao-existe', dirs)).toBeNull()
  })

  it('Claude: acha o transcript criado depois do inicio na pasta do projeto', async () => {
    const config = tempDir('claude-config-')
    const cwd = '/tmp/projeto-x'
    const dirs: SessionLocatorDirs = { claudeConfigDirs: [config], codexHomes: [] }
    const projectDir = join(config, 'projects', encodeClaudeProjectPath(cwd))
    mkdirSync(projectDir, { recursive: true })
    const startedAt = Date.now()
    const id = '11111111-2222-4333-8444-555555555555'
    writeFileSync(join(projectDir, `${id}.jsonl`), '{}\n')
    writeFileSync(join(projectDir, 'nao-e-uuid.jsonl'), '{}\n')
    const found = await locateProviderSessionId(
      { provider: 'claude', cwd, startedAt: startedAt - 500, timeoutMs: 0 },
      { dirs, now: Date.now, sleep: async () => undefined },
    )
    expect(found).toBe(id)
    expect(await findClaudeTranscript(cwd, id, dirs)).toBe(join(projectDir, `${id}.jsonl`))
  })

  it('sem candidato devolve null depois do prazo', async () => {
    const dirs: SessionLocatorDirs = {
      claudeConfigDirs: [tempDir('c-')],
      codexHomes: [tempDir('x-')],
    }
    let clock = 1000
    let sleeps = 0
    const found = await locateProviderSessionId(
      { provider: 'codex', cwd: '/tmp/nada', startedAt: 1000, timeoutMs: 1000 },
      {
        dirs,
        now: () => clock,
        sleep: async (ms) => {
          sleeps += 1
          clock += ms
        },
      },
    )
    expect(found).toBeNull()
    expect(sleeps).toBeGreaterThan(0)
  })

  it('respeita CLAUDE_CONFIG_DIR e CODEX_HOME', () => {
    const dirs = defaultSessionLocatorDirs({
      HOME: '/home/u',
      CLAUDE_CONFIG_DIR: '/cfg/claude',
      CODEX_HOME: '/cfg/codex',
    })
    expect(dirs.claudeConfigDirs).toEqual(['/cfg/claude', '/home/u/.claude'])
    expect(dirs.codexHomes).toEqual(['/cfg/codex', '/home/u/.codex'])
  })
})

describe('resolveExecutableOnPath', () => {
  it('pega o primeiro do PATH (wrapper de rodizio) e pula nao executavel', () => {
    const rodizio = tempDir('rodizio-')
    const local = tempDir('local-')
    const quebrado = tempDir('quebrado-')
    writeFileSync(join(quebrado, 'claude'), '#!/bin/sh\n', { mode: 0o644 })
    writeFileSync(join(rodizio, 'claude'), '#!/bin/sh\n', { mode: 0o755 })
    writeFileSync(join(local, 'claude'), '#!/bin/sh\n', { mode: 0o755 })
    utimesSync(join(local, 'claude'), new Date(), new Date())
    expect(resolveExecutableOnPath('claude', `${quebrado}:${rodizio}:${local}`)).toBe(
      join(rodizio, 'claude'),
    )
    expect(resolveExecutableOnPath('claude', `${local}:${rodizio}`)).toBe(join(local, 'claude'))
    expect(resolveExecutableOnPath('claude', quebrado)).toBeNull()
    expect(resolveExecutableOnPath('claude', undefined)).toBeNull()
  })
})
