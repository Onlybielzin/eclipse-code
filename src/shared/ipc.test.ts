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

  it('settings.save aceita 1 a 100 ou null e recusa o resto', () => {
    const save = (input: unknown) => parseIpcInvokeRequest({ channel: 'settings.save', input }).ok
    const ok = { maxLiveAgents: 12, maxLiveMembersPerTask: null }
    expect(save(ok)).toBe(true)
    expect(save({ maxLiveAgents: 1, maxLiveMembersPerTask: 100 })).toBe(true)
    for (const bad of [0, 101, 1.5, '5', Infinity, -1]) {
      expect(save({ ...ok, maxLiveAgents: bad })).toBe(false)
      expect(save({ ...ok, maxLiveMembersPerTask: bad })).toBe(false)
    }
    expect(save({ ...ok, extra: 1 })).toBe(false)
    expect(save({ maxLiveAgents: 3 })).toBe(false)
    expect(parseIpcInvokeRequest({ channel: 'settings.get', input: {} }).ok).toBe(true)
    expect(parseIpcInvokeRequest({ channel: 'settings.get', input: { x: 1 } }).ok).toBe(false)
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
    expect(
      parseIpcInvokeRequest({
        channel: 'projects.add',
        input: { rootPath: 'C:\\Users\\conta\\eclipse-code' },
      }).ok,
    ).toBe(true)
  })
})
