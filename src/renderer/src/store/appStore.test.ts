import { describe, expect, it } from 'vitest'
import { AppStore } from './appStore'
import { formatElapsed, groupTasks, subtaskRowLabel } from './format'
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
    expect(s.tasks.map((t) => t.id)).toEqual(['t1', 'solo1', 'old1'])
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

  it('ignora tarefa de outro projeto e mantém a arquivada no grupo Lançado', async () => {
    const { api, store } = await started()
    expect(api.callsTo('tasks.list')).toEqual([{ projectId: 'p1', includeArchived: true }])
    api.emitDomain({ type: 'task.upserted', task: makeTask('x', 'outra', { projectId: 'p2' }) })
    expect(store.getState().tasks.some((t) => t.id === 'x')).toBe(false)
    api.emitDomain({
      type: 'task.upserted',
      task: makeTask('t1', 'feat-orfer-e-up', { status: 'archived', workflowStatus: 'lancado' }),
    })
    expect(store.getState().tasks.find((t) => t.id === 't1')?.workflowStatus).toBe('lancado')
  })

  it('troca o status pelo main e usa a tarefa que ele devolve (S1)', async () => {
    const { api, store } = await started()
    await store.setTaskStatus('t1', 'em_revisao')
    expect(api.callsTo('tasks.setStatus')).toEqual([{ taskId: 't1', status: 'em_revisao' }])
    expect(store.getState().tasks.find((t) => t.id === 't1')?.workflowStatus).toBe('em_revisao')

    api.overrides.set('tasks.setStatus', () => ({
      ok: false,
      error: { code: 'unavailable', message: 'a worktree desta tarefa foi removida' },
    }))
    await store.setTaskStatus('old1', 'a_fazer')
    expect(store.getState().error).toBe('a worktree desta tarefa foi removida')
    expect(store.getState().tasks.find((t) => t.id === 'old1')?.workflowStatus).toBe('lancado')
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

  it('agrupa por status na ordem fixa e esconde grupo vazio', () => {
    const tasks = [
      ...mockupData().tasks,
      makeTask('r1', 'revisar', { workflowStatus: 'em_revisao' }),
      makeTask('p1t', 'pronta', { workflowStatus: 'pronto_lancar' }),
      makeTask('q1t', 'perguntando', { workflowStatus: 'pergunta' }),
    ]
    const groups = groupTasks(tasks)
    expect(groups.map((g) => [g.label, g.tasks.map((t) => t.id)])).toEqual([
      ['A fazer', ['solo1']],
      ['Em andamento', ['t1']],
      ['Pergunta para você', ['q1t']],
      ['Em revisão', ['r1']],
      ['Pronto pra lançar', ['p1t']],
      ['Lançado', ['old1']],
    ])
    expect(groupTasks([makeTask('a', 'a')]).map((g) => g.status)).toEqual(['em_andamento'])
  })
})

describe('subtaskRowLabel', () => {
  it('em dúvida mostra a statusMessage (ex: parada pelo reinício); nos outros, o estado', () => {
    expect(
      subtaskRowLabel(
        makeSubtask('s1', 't1', {
          state: 'input_required',
          statusMessage: 'parada: o app reiniciou',
        }),
      ),
    ).toBe('parada: o app reiniciou')
    expect(
      subtaskRowLabel(makeSubtask('s1', 't1', { state: 'input_required', statusMessage: null })),
    ).toBe('dúvida')
    expect(
      subtaskRowLabel(
        makeSubtask('s1', 't1', { state: 'failed', statusMessage: 'bloqueado: erro' }),
      ),
    ).toBe('bloqueado')
  })
})
