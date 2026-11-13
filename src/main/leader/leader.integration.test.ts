import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { LeaderLaunchRequest, PtyHost } from '@shared/ports'
import { createPtyHost } from '../terminal'
import { claudeHookPaths } from './claudeHooks'
import { claudeSessionIdFor } from './commands'
import { createLeaderModule, type LeaderModule, type LeaderSessionEvent } from './index'

const FAKE_AGENT = resolve(__dirname, 'testing/fakeAgent.mjs')
const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** Pasta com `claude` e `codex` falsos, como o wrapper de rodizio no PATH. */
function fakeBin(): string {
  const bin = tempDir('fake-bin-')
  for (const name of ['claude', 'codex']) {
    writeFileSync(
      join(bin, name),
      `#!/bin/sh\nexec /usr/bin/env ELECTRON_RUN_AS_NODE=1 '${process.execPath}' '${FAKE_AGENT}' "$@"\n`,
      { mode: 0o755 },
    )
  }
  return bin
}

interface Harness {
  host: PtyHost
  leader: LeaderModule
  events: LeaderSessionEvent[]
  bin: string
  logFile: string
  hooksRoot: string
  cwd: string
}

function setup(
  options: { withBin?: boolean; maxAttempts?: number; codexHome?: string } = {},
): Harness {
  const host = createPtyHost({ killGraceMs: 500, disposeTimeoutMs: 2000 })
  const hooksRoot = tempDir('leader-hooks-')
  const bin = fakeBin()
  const empty = tempDir('empty-')
  const leader = createLeaderModule({
    ptyHost: host,
    hooksRoot,
    dirs: { claudeConfigDirs: [empty], codexHomes: [options.codexHome ?? empty] },
    launcher: {
      baseEnv: {
        PATH: options.withBin === false ? '/usr/bin:/bin' : `${bin}:/usr/bin:/bin`,
        HOME: process.env['HOME'] ?? '/tmp',
        CLAUDECODE: '1',
      },
    },
    sessions: {
      quietMs: 300,
      settleMs: 50,
      tailPollMs: 30,
      codexLocateTimeoutMs: options.codexHome ? 5000 : 200,
      promptAckTimeoutMs: 3000,
    },
    relay: { retryDelayMs: 50, submitDelayMs: 50, maxAttempts: options.maxAttempts ?? 200 },
  })
  const events: LeaderSessionEvent[] = []
  leader.sessions.onEvent((event) => events.push(event))
  cleanups.push(async () => {
    await host.dispose()
    await leader.dispose()
  })
  return {
    host,
    leader,
    events,
    bin,
    logFile: join(tempDir('fake-log-'), 'log.jsonl'),
    hooksRoot,
    cwd: tempDir('wt-'),
  }
}

function request(h: Harness, overrides: Partial<LeaderLaunchRequest> = {}): LeaderLaunchRequest {
  return {
    sessionId: 'sess-lider-1',
    taskId: 'task-1',
    provider: 'claude',
    model: null,
    cwd: h.cwd,
    initialPrompt: 'Você é o Líder.',
    resumeProviderSessionId: null,
    mcpServer: {
      name: 'eclipse',
      command: '/bin/true',
      args: ['mcp'],
      env: { ECLIPSE_NEXT_MCP_TOKEN: 't' },
    },
    env: { FAKE_LOG: h.logFile },
    cols: 100,
    rows: 30,
    ...overrides,
  }
}

function readLog(h: Harness): Array<Record<string, unknown>> {
  if (!existsSync(h.logFile)) return []
  return readFileSync(h.logFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

async function waitFor<T>(check: () => T | null | undefined | false, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = check()
    if (value) return value
    if (Date.now() > deadline) throw new Error('timeout em waitFor')
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('Lider Claude com agente falso', () => {
  it('abre com --session-id, MCP, ganchos e TODO tools; fica ocioso pelo gancho SessionStart', async () => {
    const h = setup()
    const result = await h.leader.launcher.launch(request(h))
    expect(result.resumed).toBe(false)
    expect(result.command.command).toBe(join(h.bin, 'claude'))
    expect(h.host.isAlive(result.ptyId)).toBe(true)

    const start = await waitFor(() => readLog(h).find((r) => r['kind'] === 'start'))
    const argv = start['argv'] as string[]
    expect(argv).toContain('--session-id')
    expect(argv[argv.indexOf('--session-id') + 1]).toBe(claudeSessionIdFor('sess-lider-1'))
    expect(argv[argv.indexOf('--mcp-config') + 1]).toContain('"eclipse"')
    expect(argv.at(-1)).toBe('Você é o Líder.')
    expect(start['todo']).toBe('1')
    expect(start['marker']).toBe('1')
    expect(start['electronRunAsNode']).toBe('1') // so o wrapper do teste define

    await waitFor(() => h.leader.sessions.get('sess-lider-1')?.activity === 'idle')
    const snapshot = h.leader.sessions.get('sess-lider-1')
    expect(snapshot).toMatchObject({
      provider: 'claude',
      ptyId: result.ptyId,
      providerSessionId: claudeSessionIdFor('sess-lider-1'),
      hasTurnSignal: true,
      bracketedPaste: true,
    })
  })

  it('relay cola o texto, manda Enter, e o estado vai a trabalhando e volta a ocioso', async () => {
    const h = setup()
    await h.leader.launcher.launch(request(h))
    await waitFor(() => h.leader.sessions.get('sess-lider-1')?.activity === 'idle')

    const texto = 'Subtarefa st-1 terminou.\nSTATUS: PRONTO — revise a entrega'
    const result = await h.leader.relay.deliver('sess-lider-1', texto)
    expect(result.delivered).toBe(true)
    expect(result.attempts).toBeGreaterThanOrEqual(1)

    const prompt = await waitFor(() => readLog(h).find((r) => r['kind'] === 'prompt'))
    expect(prompt['text']).toBe(texto)
    await waitFor(() => h.events.some((e) => e.type === 'activity' && e.activity === 'working'))
    await waitFor(() => h.leader.sessions.get('sess-lider-1')?.activity === 'idle')
  })

  it('duas entregas seguidas saem em ordem, uma por turno', async () => {
    const h = setup()
    await h.leader.launcher.launch(request(h))
    const [a, b] = await Promise.all([
      h.leader.relay.deliver('sess-lider-1', 'primeira'),
      h.leader.relay.deliver('sess-lider-1', 'segunda'),
    ])
    expect(a.delivered && b.delivered).toBe(true)
    const prompts = await waitFor(() => {
      const list = readLog(h).filter((r) => r['kind'] === 'prompt')
      return list.length === 2 ? list : null
    })
    expect(prompts.map((p) => p['text'])).toEqual(['primeira', 'segunda'])
  })

  it('retomar usa --resume e avisa quando o Claude informa outro id', async () => {
    const h = setup()
    const result = await h.leader.launcher.launch(
      request(h, {
        resumeProviderSessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        env: { FAKE_LOG: h.logFile, FAKE_REPORTED_SESSION: 'ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee' },
      }),
    )
    expect(result.resumed).toBe(true)
    const start = await waitFor(() => readLog(h).find((r) => r['kind'] === 'start'))
    const argv = start['argv'] as string[]
    expect(argv.slice(-2)).toEqual(['--resume', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'])
    expect(argv).not.toContain('--session-id')
    expect(argv).not.toContain('Você é o Líder.')
    const changed = await waitFor(() => h.events.find((e) => e.type === 'provider-session-id'))
    expect(changed).toEqual({
      type: 'provider-session-id',
      sessionId: 'sess-lider-1',
      providerSessionId: 'ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    })
  })

  it('saida do Lider: evento exit, relay recusa e arquivos de ganchos somem', async () => {
    const h = setup()
    const result = await h.leader.launcher.launch(request(h))
    const hooks = claudeHookPaths(h.hooksRoot, 'sess-lider-1')
    await waitFor(() => h.leader.sessions.get('sess-lider-1')?.activity === 'idle')
    expect(existsSync(hooks.settings)).toBe(true)

    h.host.write(result.ptyId, 'sair\r')
    const exit = await waitFor(() => h.events.find((e) => e.type === 'exit'))
    expect(exit).toMatchObject({
      type: 'exit',
      sessionId: 'sess-lider-1',
      exit: { exitCode: 0, signal: null },
    })
    expect(h.host.liveCount()).toBe(0)
    expect(h.leader.sessions.get('sess-lider-1')?.activity).toBe('exited')
    expect(await h.leader.relay.deliver('sess-lider-1', 'oi')).toEqual({
      delivered: false,
      attempts: 0,
    })
    await waitFor(() => !existsSync(hooks.directory))
  })

  it('Lider que nunca fica pronto: relay desiste depois de maxAttempts', async () => {
    const h = setup({ maxAttempts: 5 })
    await h.leader.launcher.launch(
      request(h, { env: { FAKE_LOG: h.logFile, FAKE_MODE: 'no-paste' } }),
    )
    await waitFor(() => readLog(h).some((r) => r['kind'] === 'start'))
    const result = await h.leader.relay.deliver('sess-lider-1', 'oi')
    expect(result).toEqual({ delivered: false, attempts: 5 })
    expect(readLog(h).some((r) => r['kind'] === 'prompt')).toBe(false)
  })

  it('CLI ausente no PATH vira DomainError unavailable', async () => {
    const h = setup({ withBin: false })
    await expect(h.leader.launcher.launch(request(h))).rejects.toMatchObject({
      code: 'unavailable',
    })
    expect(h.host.liveCount()).toBe(0)
    expect(existsSync(claudeHookPaths(h.hooksRoot, 'sess-lider-1').directory)).toBe(false)
  })

  it('sessao desconhecida: nada a entregar', async () => {
    const h = setup()
    expect(await h.leader.relay.deliver('nao-existe', 'oi')).toEqual({
      delivered: false,
      attempts: 0,
    })
  })
})

describe('Lider Codex com agente falso', () => {
  it('abre com -c mcp_servers e entrega pelo silencio do terminal (sem transcript)', async () => {
    const h = setup()
    const result = await h.leader.launcher.launch(
      request(h, { provider: 'codex', sessionId: 'sess-codex' }),
    )
    expect(result.command.command).toBe(join(h.bin, 'codex'))
    const start = await waitFor(() => readLog(h).find((r) => r['kind'] === 'start'))
    const argv = start['argv'] as string[]
    expect(argv).toContain('mcp_servers.eclipse.command="/bin/true"')
    expect(argv.slice(-2)).toEqual(['--', 'Você é o Líder.'])
    expect(start['todo']).toBeNull()

    const delivered = await h.leader.relay.deliver('sess-codex', 'aviso ao Líder')
    expect(delivered.delivered).toBe(true)
    const prompt = await waitFor(() => readLog(h).find((r) => r['kind'] === 'prompt'))
    expect(prompt['text']).toBe('aviso ao Líder')
  })

  it('acha o rollout do Codex, informa o id e segue task_started/task_complete', async () => {
    const codexHome = tempDir('codex-home-')
    const h = setup({ codexHome })
    await h.leader.launcher.launch(
      request(h, {
        provider: 'codex',
        sessionId: 'sess-codex',
        env: { FAKE_LOG: h.logFile, FAKE_CODEX_HOME: codexHome, FAKE_CODEX_ID: 'th-rollout-1' },
      }),
    )
    const found = await waitFor(() => h.events.find((e) => e.type === 'provider-session-id'))
    expect(found).toMatchObject({ sessionId: 'sess-codex', providerSessionId: 'th-rollout-1' })

    const delivered = await h.leader.relay.deliver('sess-codex', 'primeiro aviso')
    expect(delivered.delivered).toBe(true)
    await waitFor(() => h.events.some((e) => e.type === 'activity' && e.activity === 'working'))
    await waitFor(() => h.leader.sessions.get('sess-codex')?.activity === 'idle')
    expect(h.leader.sessions.get('sess-codex')?.hasTurnSignal).toBe(true)
    expect(
      await h.leader.launcher.locateProviderSessionId({
        provider: 'codex',
        cwd: h.cwd,
        startedAt: h.leader.sessions.get('sess-codex')!.startedAt,
        timeoutMs: 0,
      }),
    ).toBe('th-rollout-1')
  })

  it('retomar usa codex resume <id>', async () => {
    const h = setup()
    const result = await h.leader.launcher.launch(
      request(h, {
        provider: 'codex',
        sessionId: 'sess-codex',
        resumeProviderSessionId: 'th-9',
        model: 'gpt-5',
      }),
    )
    expect(result.resumed).toBe(true)
    const start = await waitFor(() => readLog(h).find((r) => r['kind'] === 'start'))
    expect((start['argv'] as string[]).slice(-4)).toEqual(['resume', 'th-9', '--model', 'gpt-5'])
    expect(h.leader.sessions.get('sess-codex')?.providerSessionId).toBe('th-9')
  })
})
