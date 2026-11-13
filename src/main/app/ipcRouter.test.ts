import { describe, expect, it } from 'vitest'
import { DomainError } from '@shared/domain'
import { createIpcRouter } from './ipcRouter'

describe('createIpcRouter', () => {
  it('despacha entrada validada e embrulha o resultado', async () => {
    const route = createIpcRouter({ 'sessions.list': async () => [] })
    expect(await route({ channel: 'sessions.list', input: { taskId: 't1' } })).toEqual({
      ok: true,
      value: [],
    })
  })

  it('nao chama handler com entrada invalida', async () => {
    let called = false
    const route = createIpcRouter({
      'sessions.list': async () => {
        called = true
        return []
      },
    })
    const r = await route({ channel: 'sessions.list', input: {} })
    expect(r.ok).toBe(false)
    expect(called).toBe(false)
  })

  it('DomainError vira erro tipado; handler ausente vira unavailable', async () => {
    const route = createIpcRouter({
      'subtasks.list': async () => {
        throw new DomainError('not_found', 'tarefa não existe')
      },
    })
    expect(await route({ channel: 'subtasks.list', input: { taskId: 'x' } })).toEqual({
      ok: false,
      error: { code: 'not_found', message: 'tarefa não existe' },
    })
    const missing = await route({
      channel: 'tasks.list',
      input: { projectId: 'p', includeArchived: true },
    })
    expect(missing.ok === false && missing.error.code).toBe('unavailable')
  })
})
