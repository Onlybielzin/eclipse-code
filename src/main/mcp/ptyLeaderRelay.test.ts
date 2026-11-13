import { describe, expect, it } from 'vitest'
import type { PtyExit, PtyHost } from '@shared/ports'
import { createPtyLeaderRelay, lastBracketedPasteMode } from './ptyLeaderRelay'

/** PtyHost falso com relogio manual: sleep avanca o tempo e roda o "agendado". */
function setup(options: { bracketed?: boolean; scrollback?: string } = {}) {
  let now = 0
  const writes: string[] = []
  const dataListeners = new Set<(id: string, d: string) => void>()
  const exitListeners = new Set<(id: string, e: PtyExit) => void>()
  let alive = true
  const onSleep: ((t: number) => void)[] = []
  const pty = {
    write: (_id: string, data: string) => writes.push(data),
    onData: (l: (id: string, d: string) => void) => {
      dataListeners.add(l)
      return () => dataListeners.delete(l)
    },
    onExit: (l: (id: string, e: PtyExit) => void) => {
      exitListeners.add(l)
      return () => exitListeners.delete(l)
    },
    scrollback: () => options.scrollback ?? '',
    isAlive: () => alive,
  } as unknown as PtyHost
  const output = (data: string) => {
    for (const l of dataListeners) l('p1', data)
  }
  const relay = createPtyLeaderRelay({
    pty,
    resolvePty: (sessionId) => (sessionId === 'L1' ? 'p1' : null),
    clock: { now: () => now },
    sleep: async (ms) => {
      now += ms
      for (const hook of onSleep) hook(now)
    },
    quietMs: 1_000,
    submitDelayMs: 100,
    pollMs: 500,
    maxWaitMs: 10_000,
  })
  if (options.bracketed !== false && options.scrollback === undefined) output('\x1b[?2004h')
  return {
    relay,
    writes,
    output,
    onSleep,
    advance: (ms: number) => (now += ms),
    kill: () => (alive = false),
  }
}

describe('lastBracketedPasteMode', () => {
  it('vale a ultima sequencia vista', () => {
    expect(lastBracketedPasteMode('abc')).toBeNull()
    expect(lastBracketedPasteMode('\x1b[?2004h..\x1b[?2004l')).toBe(false)
    expect(lastBracketedPasteMode('\x1b[?2004l..\x1b[?2004h')).toBe(true)
  })
})

describe('createPtyLeaderRelay', () => {
  it('espera o Lider ficar quieto, cola entre colchetes e so depois manda Enter', async () => {
    const t = setup()
    // Lider "trabalhando": saida a cada sleep por 3 s.
    t.onSleep.push((now) => {
      if (now < 3_000) t.output('spinner')
    })
    const result = await t.relay.deliver('L1', 'Subtarefa a pronto')
    expect(result.delivered).toBe(true)
    expect(result.attempts).toBeGreaterThan(3)
    expect(t.writes).toEqual(['\x1b[200~Subtarefa a pronto\x1b[201~', '\r'])
  })

  it('nao cola por cima do usuario digitando', async () => {
    const t = setup()
    t.advance(5_000)
    t.relay.noteInput('p1')
    let typedUntil = 2_000 + 5_000
    t.onSleep.push((now) => {
      if (now < typedUntil) t.relay.noteInput('p1')
    })
    const result = await t.relay.deliver('L1', 'oi')
    expect(result.delivered).toBe(true)
    expect(result.attempts).toBeGreaterThan(1)
    typedUntil = 0
  })

  it('sem colagem entre colchetes nao escreve; desiste no prazo', async () => {
    const t = setup({ bracketed: false })
    t.advance(5_000)
    const result = await t.relay.deliver('L1', 'oi')
    expect(result.delivered).toBe(false)
    expect(t.writes).toEqual([])
  })

  it('le o modo de colagem do scrollback quando ligou antes do relay', async () => {
    const t = setup({ scrollback: 'banner\x1b[?2004h> ' })
    t.advance(5_000)
    expect((await t.relay.deliver('L1', 'oi')).delivered).toBe(true)
  })

  it('Lider morto ou desconhecido nao recebe nada', async () => {
    const t = setup()
    t.advance(5_000)
    expect(await t.relay.deliver('outro', 'oi')).toEqual({ delivered: false, attempts: 0 })
    t.kill()
    expect((await t.relay.deliver('L1', 'oi')).delivered).toBe(false)
    expect(t.writes).toEqual([])
  })

  it('dois avisos na mesma sessao saem um depois do outro, sem misturar', async () => {
    const t = setup()
    t.advance(5_000)
    const [a, b] = await Promise.all([t.relay.deliver('L1', 'A'), t.relay.deliver('L1', 'B')])
    expect(a.delivered && b.delivered).toBe(true)
    expect(t.writes).toEqual(['\x1b[200~A\x1b[201~', '\r', '\x1b[200~B\x1b[201~', '\r'])
  })
})
