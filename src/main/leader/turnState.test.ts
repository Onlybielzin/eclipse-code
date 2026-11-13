import { describe, expect, it } from 'vitest'
import { detectTranscriptTurnState, parseClaudeHookRecord, stateFromClaudeHook } from './turnState'
import { sanitizeRelayText } from './relay'
import { selectNearestSessionId } from './sessionLocator'

describe('detectTranscriptTurnState', () => {
  it('Codex: task_started trabalha, task_complete fica ocioso', () => {
    expect(
      detectTranscriptTurnState('codex', { type: 'event_msg', payload: { type: 'task_started' } }),
    ).toBe('working')
    expect(
      detectTranscriptTurnState('codex', { type: 'event_msg', payload: { type: 'task_complete' } }),
    ).toBe('idle')
    expect(
      detectTranscriptTurnState('codex', {
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', phase: 'commentary' },
      }),
    ).toBe('working')
    expect(
      detectTranscriptTurnState('codex', { type: 'session_meta', payload: { id: 'x' } }),
    ).toBeNull()
  })

  it('Claude: tool_use trabalha, texto final fica ocioso', () => {
    expect(
      detectTranscriptTurnState('claude', {
        type: 'assistant',
        message: { content: [{ type: 'tool_use' }] },
      }),
    ).toBe('working')
    expect(
      detectTranscriptTurnState('claude', {
        type: 'assistant',
        message: { content: [{ type: 'text' }], stop_reason: 'end_turn' },
      }),
    ).toBe('idle')
    expect(detectTranscriptTurnState('claude', { type: 'user' })).toBe('working')
  })
})

describe('ganchos do Claude', () => {
  it('mapeia eventos para estado', () => {
    const record = (event: string, notificationType: string | null = null) =>
      parseClaudeHookRecord({ event, notificationType, at: 1 })!
    expect(stateFromClaudeHook(record('SessionStart'))).toBe('idle')
    expect(stateFromClaudeHook(record('UserPromptSubmit'))).toBe('working')
    expect(stateFromClaudeHook(record('PreToolUse'))).toBe('working')
    expect(stateFromClaudeHook(record('Stop'))).toBe('idle')
    expect(stateFromClaudeHook(record('Notification', 'permission_prompt'))).toBeNull()
    expect(stateFromClaudeHook(record('Notification', 'idle_prompt'))).toBe('idle')
    expect(parseClaudeHookRecord({ nada: 1 })).toBeNull()
  })
})

describe('sanitizeRelayText', () => {
  it('tira ESC e controles, preserva quebras de linha e acentos', () => {
    expect(sanitizeRelayText('olá\r\nfim\x1b[201~\x07 ok\t!\n\n')).toBe('olá\nfim[201~ ok\t!')
  })
})

describe('selectNearestSessionId', () => {
  it('escolhe o mais proximo e recusa empate', () => {
    expect(
      selectNearestSessionId({
        candidates: [
          { sessionId: 'a', timestampMs: 1000 },
          { sessionId: 'b', timestampMs: 1500 },
        ],
        startedAtMs: 1400,
        maxDistanceMs: 5000,
      }),
    ).toBe('b')
    expect(
      selectNearestSessionId({
        candidates: [
          { sessionId: 'a', timestampMs: 1000 },
          { sessionId: 'b', timestampMs: 2000 },
        ],
        startedAtMs: 1500,
        maxDistanceMs: 5000,
      }),
    ).toBeNull()
    expect(
      selectNearestSessionId({
        candidates: [{ sessionId: 'a', timestampMs: 0 }],
        startedAtMs: 99_999,
        maxDistanceMs: 10,
      }),
    ).toBeNull()
  })
})
