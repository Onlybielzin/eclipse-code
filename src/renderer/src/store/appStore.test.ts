import { describe, expect, it } from 'vitest'
import { AppStore } from './appStore'
import { formatElapsed, groupTasks } from './format'
import { FakeApi, makeActivity, makeSubtask, makeTask, mockupData } from '../test/fakeApi'

async function started() {
  const api = new FakeApi(mockupData())
  const store = new AppStore(api)
  await store.start()
  return { api, store }
}

describe('AppStore', () => {
  it('carrega projeto, tarefas, subtarefas e perguntas abertas', async () => {
    const { store } = await started()
    const s = store.getState()
    expect(s.status).toBe('ready')
    expect(s.projectId).toBe('p1')
    expect(s.tasks.map((t) => t.id)).toEqual(['t1', 'solo1'])
    expect(s.subtasks.t1?.map((x) => x.id)).toEqual(['d1', 'd2', 't'])
    expect(s.selectedTaskId).toBe('t1')
    expect(s.questions).toHaveLength(1)
  })

  it('descarta evento com revisao igual ou menor que a ja vista (S2)', async () => {
    const { api, store } = await started()
    const newer = makeSubtask('d2', 't1', { state: 'working' })
    const stale = makeSubtask('d2', 't1', { state: 'input_required' })
    api.emitDomain({ type: 'subtask.upserted', subtask: newer }, 5)
    api.emitDomain({ type: 'subtask.upserted', subtask: stale }, 4)
    api.emitDomain({ type: 'subtask.upserted', subtask: stale }, 5)
    expect(store.getState().subtasks.t1?.find((x) => x.id === 'd2')?.state).toBe('working')
    expect(store.getState().lastRevision).toBe(5)
  })

  it('junta atividade ao vivo sem repetir sessionId+seq (S3)', async () => {
    const { api, store } = await started()
    await store.selectSubtask('d1')
    expect(store.getState().activity.d1).toHaveLength(4)
    const d1 = store.getState().subtasks.t1?.[0]
    if (!d1) throw new Error('d1')
    const repeated = makeActivity(d1, 4, { kind: 'turn_end', stopReason: 'end_turn', error: null })
    const fresh = makeActivity(d1, 5, { kind: 'text', text: 'mais um' })
    api.emitDomain({ type: 'activity.appended', events: [repeated, fresh] })
    expect(store.getState().activity.d1?.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5])
  })

  it('ignora tarefa de outro projeto e tira da lista a arquivada', async () => {
    const { api, store } = await started()
    api.emitDomain({ type: 'task.upserted', task: makeTask('x', 'outra', { projectId: 'p2' }) })
    expect(store.getState().tasks.some((t) => t.id === 'x')).toBe(false)
    api.emitDomain({
      type: 'task.upserted',
      task: makeTask('t1', 'feat-orfer-e-up', { status: 'archived' }),
    })
    expect(store.getState().tasks.some((t) => t.id === 't1')).toBe(false)
    expect(store.getState().selectedTaskId).toBeNull()
  })

  it('mostra o erro do main em vez de engolir', async () => {
    const { api, store } = await started()
    api.overrides.set('tasks.create', () => ({
      ok: false,
      error: { code: 'unavailable', message: 'git falhou ao criar a worktree' },
    }))
    const task = await store.createTask({ title: 'x', kind: 'team', useWorktree: true })
    expect(task).toBeUndefined()
    expect(store.getState().error).toBe('git falhou ao criar a worktree')
  })

  it('tarefa de time sempre pede worktree', async () => {
    const { api, store } = await started()
    await store.createTask({ title: 'nova', kind: 'team', useWorktree: false })
    expect(api.callsTo('tasks.create')).toEqual([
      { projectId: 'p1', title: 'nova', kind: 'team', useWorktree: true },
    ])
  })
})

describe('format', () => {
  it('formata tempo decorrido', () => {
    expect(formatElapsed(0, 30_000)).toBe('agora')
    expect(formatElapsed(0, 4 * 60_000)).toBe('4 min')
    expect(formatElapsed(0, 65 * 60_000)).toBe('1 h 5 min')
    expect(formatElapsed(0, 120 * 60_000)).toBe('2 h')
  })

  it('separa Em andamento e Avulsos', () => {
    const groups = groupTasks(mockupData().tasks)
    expect(groups.map((g) => [g.label, g.tasks.map((t) => t.id)])).toEqual([
      ['Em andamento', ['t1']],
      ['Avulsos', ['solo1']],
    ])
  })
})
