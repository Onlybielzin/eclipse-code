import { describe, expect, it } from 'vitest'
import { makeSubtask, makeTask } from '../test/fakeApi'
import { formatShortElapsed, groupOpenTasks, subtaskSummary } from './format'

describe('formatShortElapsed', () => {
  it('agora, minutos, horas e dias', () => {
    expect(formatShortElapsed(0, 30_000)).toBe('agora')
    expect(formatShortElapsed(0, 3 * 60_000)).toBe('3m')
    expect(formatShortElapsed(0, 61 * 60_000)).toBe('1h')
    expect(formatShortElapsed(0, 49 * 60 * 60_000)).toBe('2d')
  })
})

describe('subtaskSummary', () => {
  it('conta por estado e soma o tempo', () => {
    const subs = [
      makeSubtask('a', 't', { state: 'completed', createdAt: 0, finishedAt: 60 * 60_000 }),
      makeSubtask('b', 't', { state: 'completed', createdAt: 0, finishedAt: 2 * 60_000 }),
      makeSubtask('c', 't', { state: 'input_required', createdAt: 0, finishedAt: 0 }),
    ]
    expect(subtaskSummary(subs, 0)).toBe('2 prontas · 1 dúvida · 1 h 2 min')
  })
})

describe('groupOpenTasks', () => {
  it('mostra os grupos Esperando outra e Lançada, na ordem da tela', () => {
    const open = [
      makeTask('a', 'a', { workflowStatus: 'subiu' }),
      makeTask('b', 'b', { workflowStatus: 'esperando_outra' }),
      makeTask('c', 'c', { workflowStatus: 'a_fazer' }),
      makeTask('d', 'd', { workflowStatus: 'pronto_lancar' }),
    ]
    expect(groupOpenTasks(open).map((g) => g.label)).toEqual([
      'A fazer',
      'Esperando outra',
      'Pronto pra lançar',
      'Lançada',
    ])
  })
})
