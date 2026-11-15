import { describe, expect, it } from 'vitest'
import {
  canTransitionSubtask,
  DomainError,
  FINAL_SUBTASK_STATES,
  isFinalSubtaskState,
  isTerminalTask,
  SUBTASK_STATE_LABELS,
  SUBTASK_STATES,
  toDomainErrorPayload,
} from './domain'

describe('estados da subtarefa', () => {
  it('estado final nunca muda', () => {
    for (const from of FINAL_SUBTASK_STATES) {
      for (const to of SUBTASK_STATES) expect(canTransitionSubtask(from, to)).toBe(false)
    }
  })

  it('segue na fila -> trabalhando -> duvida <-> trabalhando -> final', () => {
    expect(canTransitionSubtask('submitted', 'working')).toBe(true)
    expect(canTransitionSubtask('working', 'input_required')).toBe(true)
    expect(canTransitionSubtask('input_required', 'working')).toBe(true)
    expect(canTransitionSubtask('working', 'completed')).toBe(true)
    expect(canTransitionSubtask('submitted', 'completed')).toBe(false)
    expect(canTransitionSubtask('input_required', 'completed')).toBe(false)
    expect(canTransitionSubtask('working', 'working')).toBe(false)
  })

  it('tem rotulo em portugues para todo estado', () => {
    expect(SUBTASK_STATE_LABELS).toEqual({
      submitted: 'na fila',
      working: 'trabalhando',
      input_required: 'dúvida',
      completed: 'pronto',
      failed: 'bloqueado',
      canceled: 'cancelada',
    })
    expect(SUBTASK_STATES.filter(isFinalSubtaskState)).toEqual([...FINAL_SUBTASK_STATES])
  })
})

describe('DomainError', () => {
  it('vira payload serializavel', () => {
    expect(toDomainErrorPayload(new DomainError('final_state', 'x'))).toEqual({
      code: 'final_state',
      message: 'x',
    })
    expect(toDomainErrorPayload(new Error('boom'))).toEqual({ code: 'internal', message: 'boom' })
  })
})

describe('isTerminalTask', () => {
  it('só solo sem papel e sem provedor é Terminal', () => {
    const base = { kind: 'solo', leadRoleId: null, soloProvider: null } as const
    expect(isTerminalTask(base)).toBe(true)
    expect(isTerminalTask({ ...base, soloProvider: 'claude' })).toBe(false)
    expect(isTerminalTask({ ...base, leadRoleId: 'r1' })).toBe(false)
    expect(isTerminalTask({ ...base, kind: 'team' })).toBe(false)
  })
})
