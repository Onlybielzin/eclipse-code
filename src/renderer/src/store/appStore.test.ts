import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppStore } from './appStore'
import { formatElapsed, groupOpenTasks, sortTasks, splitTasks, subtaskRowLabel } from './format'
import {
  FakeApi,
  makeActivity,
  makeProject,
  makeSubtask,
  makeTask,
  mockupData,
} from '../test/fakeApi'

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

  it('ignora tarefa de outro projeto e mantém a arquivada no grupo Concluída', async () => {
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

  it('tarefa de time respeita useWorktree false', async () => {
    const { api, store } = await started()
    await store.createTask({ title: 'nova', kind: 'team', useWorktree: false })
    expect(api.callsTo('tasks.create')).toEqual([
      { projectId: 'p1', title: 'nova', kind: 'team', useWorktree: false },
    ])
  })

  it('volta ao último chat da tarefa ao reabri-la', async () => {
    const { store } = await started()
    await store.selectSubtask('d1')
    store.selectTask('solo1')
    expect(store.getState().selectedSubtaskId).toBeNull()
    store.selectTask('t1')
    expect(store.getState().selectedTaskId).toBe('t1')
    expect(store.getState().selectedSubtaskId).toBe('d1')
    expect(store.getState().midTab).not.toBe('leader')
  })

  it('clicar na tarefa já selecionada leva ao Líder', async () => {
    const { store } = await started()
    await store.selectSubtask('d1')
    store.selectTask('t1')
    expect(store.getState().selectedSubtaskId).toBeNull()
    expect(store.getState().midTab).toBe('leader')
  })

  it('não restaura o chat quando pedido (pergunta do Líder)', async () => {
    const { store } = await started()
    await store.selectSubtask('d1')
    store.selectTask('solo1')
    store.selectTask('t1', false)
    expect(store.getState().selectedSubtaskId).toBeNull()
  })
})

describe('última tarefa por projeto', () => {
  const saved = new Map<string, string>()
  beforeEach(() => {
    saved.clear()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => saved.get(k) ?? null,
      setItem: (k: string, v: string) => void saved.set(k, v),
      removeItem: (k: string) => void saved.delete(k),
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  async function twoProjects() {
    const data = mockupData()
    data.projects.push({ ...makeProject(), id: 'p2', name: 'outro' })
    data.tasks.push(makeTask('b1', 'tarefa do outro', { projectId: 'p2' }))
    const store = new AppStore(new FakeApi(data))
    await store.start()
    return store
  }

  it('volta para a tarefa que estava selecionada ao reabrir o projeto', async () => {
    const store = await twoProjects()
    store.selectTask('solo1')
    await store.openProject('p2')
    expect(store.getState().selectedTaskId).toBe('b1')
    await store.openProject('p1')
    expect(store.getState().selectedTaskId).toBe('solo1')
    expect(saved.get('eclipse.lastTask.p1')).toBe('solo1')
  })

  it('volta também para a subtarefa que estava aberta', async () => {
    const store = await twoProjects()
    await store.selectSubtask('d2')
    await store.openProject('p2')
    await store.openProject('p1')
    expect(store.getState().selectedTaskId).toBe('t1')
    expect(store.getState().selectedSubtaskId).toBe('d2')
  })

  it('cai na primeira tarefa aberta se a salva não existe mais', async () => {
    const store = await twoProjects()
    saved.set('eclipse.lastTask.p2', 'sumiu')
    await store.openProject('p2')
    expect(store.getState().selectedTaskId).toBe('b1')
    saved.set('eclipse.lastTask.p1', 'sumiu')
    await store.openProject('p1')
    expect(store.getState().selectedTaskId).toBe('t1')
    expect(store.getState().error).toBeNull()
  })
})

describe('format', () => {
  it('formata tempo decorrido', () => {
    expect(formatElapsed(0, 30_000)).toBe('agora')
    expect(formatElapsed(0, 4 * 60_000)).toBe('4 min')
    expect(formatElapsed(0, 65 * 60_000)).toBe('1 h 5 min')
    expect(formatElapsed(0, 120 * 60_000)).toBe('2 h')
  })

  it('separa abertas das arquivadas, cada lado do mais recente para o mais antigo', () => {
    const tasks = [
      makeTask('velha', 'velha', { updatedAt: 1, createdAt: 1 }),
      makeTask('nova', 'nova', { workflowStatus: 'em_revisao', updatedAt: 9, createdAt: 1 }),
      makeTask('empate', 'empate', { workflowStatus: 'a_fazer', updatedAt: 9, createdAt: 5 }),
      makeTask('conc', 'conc', { workflowStatus: 'lancado', updatedAt: 50, createdAt: 1 }),
      makeTask('canc', 'canc', { workflowStatus: 'cancelado', updatedAt: 60, createdAt: 1 }),
    ]
    const { open, archived } = splitTasks(tasks)
    expect(open.map((t) => t.id)).toEqual(['empate', 'nova', 'velha'])
    expect(archived.map((t) => t.id)).toEqual(['canc', 'conc'])
    expect(splitTasks([])).toEqual({ open: [], archived: [] })
  })
})

describe('sortTasks e groupOpenTasks', () => {
  const tasks = [
    makeTask('a', 'Zebra', { workflowStatus: 'a_fazer', updatedAt: 5, createdAt: 1 }),
    makeTask('b', 'abacaxi', { workflowStatus: 'em_andamento', updatedAt: 9, createdAt: 2 }),
    makeTask('c', 'Água', { workflowStatus: 'pronto_lancar', updatedAt: 7, createdAt: 3 }),
    makeTask('q', 'zzz pergunta', { workflowStatus: 'pergunta', updatedAt: 1, createdAt: 0 }),
    makeTask('r', 'revisar', { workflowStatus: 'em_revisao', updatedAt: 6, createdAt: 4 }),
    makeTask('e', 'espera', { workflowStatus: 'em_espera', updatedAt: 2, createdAt: 5 }),
    makeTask('x', 'encerrada', { workflowStatus: 'lancado', updatedAt: 99, createdAt: 99 }),
  ]
  const ids = (list: { id: string }[]) => list.map((t) => t.id)

  it('cada ordem, sempre com Pergunta para você em cima', () => {
    expect(ids(sortTasks(tasks, 'updated'))).toEqual(['q', 'x', 'b', 'c', 'r', 'a', 'e'])
    expect(ids(sortTasks(tasks, 'created'))).toEqual(['q', 'x', 'e', 'r', 'c', 'b', 'a'])
    // pt-BR sem acento nem caixa: Água, abacaxi, encerrada, revisar, Zebra.
    expect(ids(sortTasks(tasks, 'name'))).toEqual(['q', 'b', 'c', 'x', 'e', 'r', 'a'])
    expect(ids(sortTasks(tasks, 'status'))).toEqual(['q', 'b', 'r', 'a', 'c', 'e', 'x'])
  })

  it('splitTasks usa a ordem e separa as encerradas', () => {
    const { open, archived } = splitTasks(tasks, 'name')
    expect(ids(open)).toEqual(['q', 'b', 'c', 'e', 'r', 'a'])
    expect(ids(archived)).toEqual(['x'])
  })

  it('grupos na ordem dos status abertos, com a ordem escolhida dentro e sem grupo vazio', () => {
    const more = [...tasks, makeTask('d', 'dois', { workflowStatus: 'a_fazer', updatedAt: 8 })]
    const groups = groupOpenTasks(splitTasks(more, 'updated').open)
    expect(groups.map((g) => g.status)).toEqual([
      'pergunta',
      'em_andamento',
      'em_revisao',
      'a_fazer',
      'pronto_lancar',
      'em_espera',
    ])
    expect(groups[0]?.label).toBe('Pergunta para você')
    expect(groups[5]?.label).toBe('Em espera')
    expect(ids(groups[3]!.tasks)).toEqual(['d', 'a'])
    expect(groupOpenTasks([])).toEqual([])
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
