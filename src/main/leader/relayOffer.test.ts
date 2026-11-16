import { mkdtempSync, rmSync } from 'node:fs'
import { appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PtyHost } from '@shared/ports'
import { claudeHookPaths, writeClaudeHookFiles, type ClaudeHookPaths } from './claudeHooks'
import { claimInbox } from './inbox'
import { createLeaderSessionRegistry, type LeaderSessionEvent } from './leaderSessions'
import { createLeaderRelay } from './relay'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function setup(provider: 'claude' | 'codex' = 'claude') {
  const root = mkdtempSync(join(tmpdir(), 'offer-'))
  dirs.push(root)
  const hooks = provider === 'claude' ? claudeHookPaths(root, 'L1') : null
  if (hooks) await writeClaudeHookFiles(hooks, process.execPath)
  const writes: string[] = []
  const ptyHost = {
    onData: () => () => undefined,
    onExit: () => () => undefined,
    scrollback: () => '\x1b[?2004h',
    isAlive: () => true,
    write: (_ptyId: string, data: string) => void writes.push(data),
  } as unknown as PtyHost
  const registry = createLeaderSessionRegistry({
    ptyHost,
    dirs: { claudeConfigDirs: [], codexHomes: [] },
    quietMs: 0,
    settleMs: 0,
    tailPollMs: 10,
  })
  registry.register({
    sessionId: 'L1',
    ptyId: 'p1',
    pid: 1,
    provider,
    cwd: '/tmp',
    startedAt: Date.now(),
    providerSessionId: 'abc',
    resumed: false,
    claudeHooks: hooks,
  })
  const events: LeaderSessionEvent[] = []
  registry.onEvent((e) => events.push(e))
  const relay = createLeaderRelay({ ptyHost, registry, submitDelayMs: 0, retryDelayMs: 5 })
  const hookEvent = async (record: object) => {
    if (hooks) await appendFile(hooks.events, JSON.stringify({ at: Date.now(), ...record }) + '\n')
  }
  return { hooks: hooks as ClaudeHookPaths, writes, registry, relay, events, hookEvent }
}

const A = { id: 1, text: '[eclipse] a' }
const B = { id: 2, text: '[eclipse] b' }

describe('LeaderRelay.offer', () => {
  it('Lider trabalhando: grava na caixa, nao toca no pty e nao repete o id', async () => {
    const h = await setup()
    await h.hookEvent({ event: 'UserPromptSubmit' })
    await vi.waitFor(() => expect(h.registry.get('L1')?.activity).toBe('working'))
    expect(await h.relay.offer!('L1', [A])).toEqual([])
    expect(await h.relay.offer!('L1', [A, B])).toEqual([])
    expect(h.writes).toEqual([])
    expect(await claimInbox(h.hooks)).toEqual([A, B])
  })

  it('NoticesDelivered vira evento notices-delivered e libera o id', async () => {
    const h = await setup()
    await h.hookEvent({ event: 'UserPromptSubmit' })
    await vi.waitFor(() => expect(h.registry.get('L1')?.activity).toBe('working'))
    await h.relay.offer!('L1', [A])
    await claimInbox(h.hooks) // o gancho levou
    await h.hookEvent({ event: 'NoticesDelivered', ids: [1] })
    await vi.waitFor(() =>
      expect(h.events).toContainEqual({ type: 'notices-delivered', sessionId: 'L1', ids: [1] }),
    )
    // Id entregue e ainda na fila (o TeamTurnRelay marca em seguida): pode ser oferecido de novo.
    expect(await h.relay.offer!('L1', [A])).toEqual([])
    expect(await claimInbox(h.hooks)).toEqual([A])
  })

  it('Lider Claude ocioso: grava na caixa, devolve [] e nada e colado', async () => {
    const h = await setup()
    await h.hookEvent({ event: 'UserPromptSubmit' })
    await vi.waitFor(() => expect(h.registry.get('L1')?.activity).toBe('working'))
    await h.relay.offer!('L1', [A])
    await h.hookEvent({ event: 'Stop' })
    await vi.waitFor(() => expect(h.registry.get('L1')?.activity).toBe('idle'))
    expect(await h.relay.offer!('L1', [A, B])).toEqual([])
    expect(h.writes).toEqual([])
    expect(await claimInbox(h.hooks)).toEqual([A, B])
  })

  it('gancho levou a caixa e o Lider ficou ocioso antes do evento: nao regrava o aviso em voo', async () => {
    const h = await setup()
    await h.hookEvent({ event: 'UserPromptSubmit' })
    await vi.waitFor(() => expect(h.registry.get('L1')?.activity).toBe('working'))
    await h.relay.offer!('L1', [A])
    await claimInbox(h.hooks) // gancho levou, NoticesDelivered ainda nao lido
    await h.hookEvent({ event: 'Stop' })
    await vi.waitFor(() => expect(h.registry.get('L1')?.activity).toBe('idle'))
    expect(await h.relay.offer!('L1', [A, B])).toEqual([])
    expect(await claimInbox(h.hooks)).toEqual([B])
  })

  it('aviso descartado enquanto estava na caixa sai da caixa', async () => {
    const h = await setup()
    await h.hookEvent({ event: 'UserPromptSubmit' })
    await vi.waitFor(() => expect(h.registry.get('L1')?.activity).toBe('working'))
    await h.relay.offer!('L1', [A, B])
    await h.relay.offer!('L1', [B]) // A foi descartado (subtarefa vista)
    expect(await claimInbox(h.hooks)).toEqual([B])
  })

  it('Codex (sem gancho): devolve tudo para colar', async () => {
    const h = await setup('codex')
    expect(await h.relay.offer!('L1', [A, B])).toEqual([A, B])
  })
})

describe('LeaderRelay.wake', () => {
  it('Claude ocioso: cola so a linha curta e o Enter', async () => {
    const { relay, writes } = await setup()
    expect(await relay.wake!('L1')).toBe(true)
    expect(writes[0]).toBe('\x1b[200~[eclipse] Chegou aviso novo.\x1b[201~')
    expect(writes[1]).toBe('\r')
  })

  it('Lider ocupado logo apos colar: nao cola de novo', async () => {
    const { relay, writes } = await setup()
    await relay.wake!('L1')
    expect(await relay.wake!('L1')).toBe(false)
    expect(writes).toHaveLength(2)
  })

  it('Codex (sem gancho): nao cola', async () => {
    const { relay, writes } = await setup('codex')
    expect(await relay.wake!('L1')).toBe(false)
    expect(writes).toEqual([])
  })
})
