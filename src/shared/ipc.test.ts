import { describe, expect, it } from 'vitest'
import { parseIpcInvokeRequest } from './ipc'

describe('parseIpcInvokeRequest', () => {
  it('aceita comando valido', () => {
    const r = parseIpcInvokeRequest({
      channel: 'tasks.list',
      input: { projectId: 'p1', includeArchived: false },
    })
    expect(r.ok).toBe(true)
  })

  it('recusa canal desconhecido e prototipo', () => {
    for (const channel of ['nao.existe', '__proto__', 'toString']) {
      const r = parseIpcInvokeRequest({ channel, input: {} })
      expect(r.ok).toBe(false)
    }
  })

  it('recusa campo extra e tipo errado', () => {
    expect(parseIpcInvokeRequest({ channel: 'app.info', input: { x: 1 } }).ok).toBe(false)
    expect(
      parseIpcInvokeRequest({
        channel: 'terminal.resize',
        input: { sessionId: 's', cols: 0, rows: 10 },
      }).ok,
    ).toBe(false)
    expect(parseIpcInvokeRequest(null).ok).toBe(false)
  })

  it('tarefa de time exige worktree', () => {
    const r = parseIpcInvokeRequest({
      channel: 'tasks.create',
      input: { projectId: 'p', title: 'x', kind: 'team', useWorktree: false },
    })
    expect(r.ok).toBe(false)
  })

  it('projeto exige caminho absoluto', () => {
    expect(
      parseIpcInvokeRequest({ channel: 'projects.add', input: { rootPath: 'rel/x' } }).ok,
    ).toBe(false)
    expect(
      parseIpcInvokeRequest({ channel: 'projects.add', input: { rootPath: '/abs/x' } }).ok,
    ).toBe(true)
  })
})
