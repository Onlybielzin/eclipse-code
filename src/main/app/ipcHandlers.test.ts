import { describe, expect, it } from 'vitest'
import type { QuestionItem } from '@shared/domain'
import { createHarness, seedTeam } from '../tasks/testing'
import { createIpcHandlers } from './ipcHandlers'
import { createIpcRouter } from './ipcRouter'
import type { AppServices } from './services'

const ITEM: QuestionItem = {
  id: 'i1',
  prompt: 'Qual banco?',
  options: [
    { id: 'a', label: 'Postgres' },
    { id: 'b', label: 'SQLite' },
  ],
  multiSelect: false,
  allowFreeText: false,
}

function handlersFor(service: AppServices['tasks']) {
  // projects.summary so le o TaskService; o coordinator nao e tocado.
  return createIpcHandlers(
    {
      tasks: service,
      coordinator: {} as AppServices['coordinator'],
      brain: {} as AppServices['brain'],
      worktrees: {} as AppServices['worktrees'],
      taskProcesses: { owns: () => false } as unknown as AppServices['taskProcesses'],
    },
    { homeDir: '/home/vings' },
  )
}

describe('projects.add', () => {
  it('pasta já cadastrada com initGit dá conflict antes de mexer no disco', async () => {
    const { service } = createHarness()
    service.addProject({ rootPath: '/repo/a' })
    let initCalls = 0
    const handlers = createIpcHandlers(
      {
        tasks: service,
        coordinator: {} as AppServices['coordinator'],
        brain: {} as AppServices['brain'],
        worktrees: {
          initRepository: async () => {
            initCalls += 1
          },
        } as unknown as AppServices['worktrees'],
        taskProcesses: { owns: () => false } as unknown as AppServices['taskProcesses'],
      },
      { homeDir: '/home/vings' },
    )
    const result = await handlers['projects.add']({ rootPath: '/repo/a', initGit: true }).catch(
      (e: unknown) => e,
    )
    expect(result).toMatchObject({ code: 'conflict' })
    expect(initCalls).toBe(0)
  })
})

describe('projects.summary', () => {
  it('conta tarefas não arquivadas e perguntas abertas de cada projeto', async () => {
    const { service } = createHarness()
    const fx = seedTeam(service, '/repo/a')
    const second = service.createTask({
      projectId: fx.project.id,
      title: 'Outra tarefa',
      kind: 'solo',
      worktreePath: null,
      branch: null,
      baseBranch: null,
      leadRoleId: null,
      soloProvider: 'claude',
    })
    const archived = service.createTask({
      projectId: fx.project.id,
      title: 'Já lançada',
      kind: 'solo',
      worktreePath: null,
      branch: null,
      baseBranch: null,
      leadRoleId: null,
      soloProvider: 'claude',
    })
    service.createQuestion({ taskId: fx.task.id, subtaskId: null, items: [ITEM] })
    const answered = service.createQuestion({
      taskId: second.id,
      subtaskId: null,
      items: [ITEM],
    })
    service.answerQuestion(answered.id, [{ itemId: 'i1', optionIds: ['a'], text: null }])
    // Pergunta aberta numa tarefa arquivada fecha junto com ela e sai da conta.
    service.createQuestion({ taskId: archived.id, subtaskId: null, items: [ITEM] })
    service.markTaskArchived(archived.id)
    const empty = service.addProject({ rootPath: '/repo/b' })

    const summary = await handlersFor(service)['projects.summary']({})

    expect(summary).toEqual({
      homeDir: '/home/vings',
      projects: [
        { projectId: fx.project.id, openTasks: 2, needsYou: 1 },
        { projectId: empty.id, openTasks: 0, needsYou: 0 },
      ],
    })
  })

  it('sem projetos devolve lista vazia; entrada com campo extra é recusada', async () => {
    const { service } = createHarness()
    const route = createIpcRouter(handlersFor(service))
    expect(await route({ channel: 'projects.summary', input: {} })).toEqual({
      ok: true,
      value: { homeDir: '/home/vings', projects: [] },
    })
    const bad = await route({ channel: 'projects.summary', input: { projectId: 'p1' } })
    expect(bad.ok === false && bad.error.code).toBe('invalid_input')
  })
})
