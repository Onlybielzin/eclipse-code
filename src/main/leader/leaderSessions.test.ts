import { describe, expect, it } from 'vitest'
import type { PtyHost } from '@shared/ports'
import { createLeaderSessionRegistry } from './leaderSessions'

function setup() {
  let clock = 1_000_000
  const dataListeners = new Set<(ptyId: string, data: string) => void>()
  const ptyHost = {
    onData: (l: (ptyId: string, data: string) => void) => {
      dataListeners.add(l)
      return () => dataListeners.delete(l)
    },
    onExit: () => () => undefined,
    scrollback: () => '\x1b[?2004h',
    isAlive: () => true,
  } as unknown as PtyHost
  const registry = createLeaderSessionRegistry({
    ptyHost,
    now: () => clock,
    dirs: { claudeConfigDirs: [], codexHomes: [] },
    quietMs: 10,
  })
  registry.register({
    sessionId: 'L1',
    ptyId: 'p1',
    pid: 1,
    provider: 'claude',
    cwd: '/tmp',
    startedAt: clock,
    providerSessionId: 'abc',
    resumed: true,
    claudeHooks: null,
  })
  return { registry, advance: (ms: number) => void (clock += ms) }
}

describe('rascunho do usuario no terminal do Lider', () => {
  it('digitacao sem Enter segura o relay; Enter libera', () => {
    const { registry, advance } = setup()
    advance(100)
    expect(registry.isReadyForInput('L1')).toBe(true)
    registry.noteUserInput('L1', 'faz pull')
    advance(100)
    expect(registry.isReadyForInput('L1')).toBe(false)
    registry.noteUserInput('L1', '\r')
    expect(registry.isReadyForInput('L1')).toBe(true)
  })

  it('20 s sem digitar liberam o relay', () => {
    const { registry, advance } = setup()
    advance(100)
    registry.noteUserInput('L1', 'x')
    advance(19_000)
    expect(registry.isReadyForInput('L1')).toBe(false)
    advance(1_001)
    expect(registry.isReadyForInput('L1')).toBe(true)
  })

  it('foco do terminal nao conta como digitação', () => {
    const { registry, advance } = setup()
    advance(100)
    registry.noteUserInput('L1', '\x1b[I')
    expect(registry.isReadyForInput('L1')).toBe(true)
  })

  it.each(['\x1b[12;5R', '\x1b[?1;2c', '\x1b[<0;10;5M', '\x1b]11;rgb:0000/0000/0000\x07', '\x1b[A', '\x1bOA', '\x1b[200~\x1b[201~'])(
    'resposta automatica ou seta %j nao conta como rascunho',
    (data) => {
      const { registry, advance } = setup()
      advance(100)
      registry.noteUserInput('L1', data)
      expect(registry.isReadyForInput('L1')).toBe(true)
    },
  )

  it('Enter dentro de colagem (bracketed paste) nao e Enter', () => {
    const { registry, advance } = setup()
    advance(100)
    registry.noteUserInput('L1', 'x')
    registry.noteUserInput('L1', '\x1b[200~linha 1\nlinha 2\x1b[201~')
    advance(100)
    expect(registry.isReadyForInput('L1')).toBe(false)
  })

  it('o que vem depois do ultimo Enter e rascunho novo', () => {
    const { registry, advance } = setup()
    advance(100)
    registry.noteUserInput('L1', 'abc\rdef')
    advance(100)
    expect(registry.isReadyForInput('L1')).toBe(false)
    registry.noteUserInput('L1', 'abc\r')
    expect(registry.isReadyForInput('L1')).toBe(true)
  })
})
