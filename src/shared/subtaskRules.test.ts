import { describe, expect, it } from 'vitest'
import type { Artifact, Delivery, TurnResult } from './domain'
import { assembleFinalText, parseStatusLine, resolveTurn } from './subtaskRules'

function turn(partial: Partial<TurnResult>): TurnResult {
  return {
    turnId: 't1',
    sessionId: 's1',
    outcome: { kind: 'stopped', stopReason: 'end_turn' },
    finalText: '',
    deliveries: [],
    startedAt: 1,
    endedAt: 2,
    ...partial,
  }
}

function artifact(delivery: Partial<Delivery>): Artifact {
  return {
    id: 'a1',
    taskId: 'k1',
    subtaskId: 'st1',
    sessionId: 's1',
    turnId: 't1',
    format: 'structured',
    delivery: {
      state: 'completed',
      summary: 'feito',
      files: [],
      tests: [],
      questions: [],
      ...delivery,
    },
    parts: [],
    createdAt: 2,
  }
}

describe('parseStatusLine', () => {
  it('le a ultima linha STATUS com e sem acento', () => {
    expect(parseStatusLine('a\nSTATUS: PRONTO')).toBe('completed')
    expect(parseStatusLine('**Status:** dúvida sobre X')).toBe('input_required')
    expect(parseStatusLine('STATUS: PRONTO\n...\nSTATUS: BLOQUEADO')).toBe('failed')
    expect(parseStatusLine('nada aqui')).toBeNull()
    expect(parseStatusLine('STATUS: talvez')).toBeNull()
  })
})

describe('assembleFinalText', () => {
  it('usa o texto depois da ultima ferramenta', () => {
    expect(
      assembleFinalText([
        { kind: 'text', text: 'vou ler' },
        {
          kind: 'tool_call',
          toolCallId: 'x',
          title: 'Read',
          toolKind: 'read',
          status: 'pending',
          input: null,
        },
        { kind: 'tool_result', toolCallId: 'x', status: 'completed', output: 'conteudo' },
        { kind: 'text', text: 'Feito. ' },
        { kind: 'text', text: 'STATUS: PRONTO' },
      ]),
    ).toBe('Feito. STATUS: PRONTO')
  })

  it('cai no ultimo texto quando nada vem depois da ferramenta', () => {
    expect(
      assembleFinalText([
        { kind: 'text', text: 'antes' },
        {
          kind: 'tool_call',
          toolCallId: 'x',
          title: 'Bash',
          toolKind: 'execute',
          status: 'pending',
          input: null,
        },
      ]),
    ).toBe('antes')
  })
})

describe('resolveTurn', () => {
  it('entrega estruturada vence, ate com erro depois', () => {
    const r = resolveTurn(
      turn({
        outcome: { kind: 'error', error: { code: 'process_exited', message: 'morreu' } },
        deliveries: [artifact({ state: 'completed', summary: 'tudo certo' })],
      }),
    )
    expect(r.state).toBe('completed')
    expect(r.fallbackDelivery).toBeNull()
    expect(r.statusMessage).toContain('process_exited')
  })

  it('processo morto sem entrega vira bloqueado: processo morreu', () => {
    const r = resolveTurn(
      turn({ outcome: { kind: 'error', error: { code: 'process_exited', message: 'x' } } }),
    )
    expect(r).toMatchObject({
      state: 'failed',
      failureCode: 'process_exited',
      statusMessage: 'bloqueado: processo morreu',
    })
  })

  it('vigia de silencio vira bloqueado: sem resposta', () => {
    const r = resolveTurn(
      turn({ outcome: { kind: 'error', error: { code: 'silent_timeout', message: 'x' } } }),
    )
    expect(r.statusMessage).toBe('bloqueado: sem resposta')
  })

  it('sem entregar, usa a linha STATUS e marca sem formato', () => {
    const r = resolveTurn(turn({ finalText: 'fiz X\nSTATUS: PRONTO' }))
    expect(r.state).toBe('completed')
    expect(r.fallbackDelivery?.summary).toBe('fiz X\nSTATUS: PRONTO')
    expect(r.statusMessage.startsWith('sem formato')).toBe(true)
  })

  it('sem entregar e sem STATUS fica em duvida (nao final)', () => {
    const r = resolveTurn(turn({ finalText: 'terminei?' }))
    expect(r.state).toBe('input_required')
    expect(r.fallbackDelivery).not.toBeNull()
  })

  it('cancelado vira cancelada sem entrega', () => {
    const r = resolveTurn(turn({ outcome: { kind: 'stopped', stopReason: 'cancelled' } }))
    expect(r).toMatchObject({ state: 'canceled', fallbackDelivery: null })
  })

  it('max_tokens vira bloqueado por limite', () => {
    const r = resolveTurn(turn({ outcome: { kind: 'stopped', stopReason: 'max_tokens' } }))
    expect(r).toMatchObject({ state: 'failed', failureCode: 'limit_reached' })
  })
})
