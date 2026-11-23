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

  it('roles.save: access é opcional, validado e devolvido ao main', () => {
    const base = {
      projectId: 'p1',
      name: 'Revisor',
      description: '',
      provider: 'claude',
      model: null,
      promptTemplate: 'x',
      isLead: false,
    }
    const parse = (extra: object) =>
      parseIpcInvokeRequest({ channel: 'roles.save', input: { ...base, ...extra } })
    const semCampo = parse({})
    // Ausente fica ausente: o TaskService decide (criação 'full', edição mantém o atual).
    expect(semCampo.ok && (semCampo.input as { access?: string }).access).toBeUndefined()
    const lido = parse({ access: 'read_only' })
    expect(lido.ok && (lido.input as { access: string }).access).toBe('read_only')
    expect(parse({ access: 'root' }).ok).toBe(false)
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
    expect(save({ ...ok, idleStandbyHours: 0 })).toBe(true)
    expect(save({ ...ok, idleStandbyHours: 720 })).toBe(true)
    for (const bad of [-1, 721, 1.5, '5', Infinity]) {
      expect(save({ ...ok, idleStandbyHours: bad })).toBe(false)
    }
    expect(save({ ...ok, extra: 1 })).toBe(false)
    expect(save({ maxLiveAgents: 3 })).toBe(false)
    expect(parseIpcInvokeRequest({ channel: 'settings.get', input: {} }).ok).toBe(true)
    expect(parseIpcInvokeRequest({ channel: 'settings.get', input: { x: 1 } }).ok).toBe(false)
  })

  it('tarefa de time aceita useWorktree false (roda na raiz)', () => {
    const r = parseIpcInvokeRequest({
      channel: 'tasks.create',
      input: { projectId: 'p', title: 'x', kind: 'team', useWorktree: false },
    })
    expect(r.ok).toBe(true)
  })

  it('tasks.create aceita descrição até 20_000 caracteres e recusa acima', () => {
    const create = (description: string) =>
      parseIpcInvokeRequest({
        channel: 'tasks.create',
        input: { projectId: 'p', title: 'x', description, kind: 'team', useWorktree: true },
      }).ok
    expect(create('a'.repeat(20_000))).toBe(true)
    expect(create('a'.repeat(20_001))).toBe(false)
  })

  it('projects.update exige nome e recusa campo extra; projects.add aceita initGit', () => {
    const update = (input: unknown) =>
      parseIpcInvokeRequest({ channel: 'projects.update', input }).ok
    expect(update({ projectId: 'p1', name: 'Novo' })).toBe(true)
    expect(update({ projectId: 'p1', name: '' })).toBe(false)
    expect(update({ projectId: 'p1', name: 'Novo', extra: 1 })).toBe(false)
    const add = (input: unknown) => parseIpcInvokeRequest({ channel: 'projects.add', input }).ok
    expect(add({ rootPath: '/abs/x', initGit: true })).toBe(true)
    expect(add({ rootPath: '/abs/x', initGit: 'sim' })).toBe(false)
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
