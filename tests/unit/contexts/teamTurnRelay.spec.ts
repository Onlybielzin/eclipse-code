import { describe, expect, it } from 'vitest'
import {
  composeTeamTurnMessage,
  startTeamTurnRelay,
  type TeamTurnRelayPorts,
} from '../../../src/contexts/agent/application/TeamTurnRelay'

function setup(overrides: Partial<TeamTurnRelayPorts> = {}) {
  let emit: (event: { nodeId: string | null; turnId: string; outcome: string }) => void = () => {}
  const delivered: Array<{ to: string; text: string }> = []
  const ports: TeamTurnRelayPorts = {
    subscribe: listener => {
      emit = listener
      return () => {}
    },
    readMember: async nodeId =>
      nodeId === 'reviewer' ? { parentNodeId: 'lead', title: 'Revisor' } : null,
    readFinalMessage: async () => 'Revisei o diff.\nSTATUS: PRONTO — sem achados',
    deliver: async (to, text) => {
      delivered.push({ to, text })
    },
    sleep: async () => {},
    ...overrides,
  }
  startTeamTurnRelay(ports)
  return { emit: (e: Parameters<typeof emit>[0]) => emit(e), delivered }
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

describe('team turn relay (any provider)', () => {
  it('sends a member reply to its lead when the member ends a turn', async () => {
    const t = setup()
    t.emit({ nodeId: 'reviewer', turnId: 't1', outcome: 'completed' })
    await flush()
    expect(t.delivered).toHaveLength(1)
    expect(t.delivered[0]!.to).toBe('lead')
    expect(t.delivered[0]!.text).toContain('[time] Revisor (id reviewer) terminou o turno.')
    expect(t.delivered[0]!.text).toContain('STATUS: PRONTO — sem achados')
  })

  it('ignores agents the user started (no lead) and repeated events for the same turn', async () => {
    const t = setup()
    t.emit({ nodeId: 'lead', turnId: 't1', outcome: 'completed' })
    t.emit({ nodeId: 'reviewer', turnId: 't2', outcome: 'completed' })
    t.emit({ nodeId: 'reviewer', turnId: 't2', outcome: 'completed' })
    await flush()
    expect(t.delivered.map(item => item.to)).toEqual(['lead'])
  })

  it('still tells the lead when the reply cannot be read', async () => {
    const t = setup({ readFinalMessage: async () => null })
    t.emit({ nodeId: 'reviewer', turnId: 't3', outcome: 'failed' })
    await flush()
    expect(t.delivered[0]!.text).toContain('terminou o turno com falha')
    expect(t.delivered[0]!.text).toContain('agente_ler e tela=true')
  })

  it('retries while the lead is busy receiving another message', async () => {
    let attempts = 0
    const t = setup({
      deliver: async () => {
        attempts++
        if (attempts < 3) {
          throw Object.assign(new Error('busy'), { code: 'agent.busy' })
        }
      },
    })
    t.emit({ nodeId: 'reviewer', turnId: 't4', outcome: 'completed' })
    await flush()
    await flush()
    expect(attempts).toBe(3)
  })

  it('finds STATUS written at the end of a sentence', () => {
    const text = composeTeamTurnMessage({
      title: 'Dev',
      nodeId: 'dev',
      outcome: 'completed',
      reply: 'ok. STATUS: PRONTO - membro',
    })
    expect(text).toContain('terminou o turno. STATUS: PRONTO - membro')
  })

  it('clips a long reply and keeps the STATUS line', () => {
    const text = composeTeamTurnMessage({
      title: 'Dev 1',
      nodeId: 'dev',
      outcome: 'completed',
      reply: `${'x'.repeat(7000)}\nSTATUS: DUVIDA — qual tabela?`,
    })
    expect(text).toContain('STATUS: DUVIDA — qual tabela?')
    expect(text.length).toBeLessThan(7000)
  })
})
