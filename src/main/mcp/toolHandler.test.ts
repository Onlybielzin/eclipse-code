import { afterEach, describe, expect, it, vi } from 'vitest'
import type { McpCaller } from '@shared/mcp'
import { createMcpToolHandler, type McpTeamActions } from './toolHandler'
import { createFakeTaskService, type FakeTaskService } from './testing/fakeTaskService'

const leader: McpCaller = { role: 'leader', sessionId: 'lead-s', taskId: 'task1', subtaskId: null }
const member: McpCaller = { role: 'member', sessionId: 'mem-s', taskId: 'task1', subtaskId: 'sub1' }

function setup() {
  const tasks: FakeTaskService = createFakeTaskService()
  const actions: McpTeamActions = {
    createSubtask: vi.fn(async (_caller, input) =>
      tasks.seedSubtask({ id: 'novo', roleId: input.roleId, title: input.title }),
    ),
    answerSubtask: vi.fn(async (_c, id) => tasks.setState(id, 'working')),
    cancelSubtask: vi.fn(async (_c, id) => tasks.setState(id, 'canceled')),
    createTask: vi.fn(async (input) => ({
      ...tasks.getTask('task1'),
      id: 'nova',
      projectId: input.projectId,
      title: input.title,
      name: input.title,
      branch: input.useWorktree ? 'eclipse/nova' : null,
    })),
  }
  const handler = createMcpToolHandler({ tasks, actions })
  return { tasks, actions, handler }
}

afterEach(() => vi.useRealTimers())

describe('autorizacao pelo papel do token', () => {
  it('membro nao cria, nao responde, nao cancela, nao ve e nao espera', async () => {
    const { handler, actions } = setup()
    for (const name of [
      'subtarefa_criar',
      'subtarefa_responder',
      'subtarefa_cancelar',
      'subtarefas_ver',
      'subtarefas_esperar',
      'pergunta_repassar',
      'tarefa_concluir',
      'tarefa_renomear',
      'tarefa_iniciar',
    ] as const) {
      await expect(handler.callTool(member, name, {})).rejects.toMatchObject({ code: 'forbidden' })
    }
    expect(actions.createSubtask).not.toHaveBeenCalled()
  })

  it('Lider nao entrega', async () => {
    const { handler, tasks } = setup()
    await expect(
      handler.callTool(leader, 'entregar', { estado: 'pronto', resumo: 'x' }),
    ).rejects.toMatchObject({ code: 'forbidden' })
    expect(tasks.deliveries).toHaveLength(0)
  })

  it('entrada invalida vira invalid_input com o campo', async () => {
    const { handler } = setup()
    await expect(
      handler.callTool(leader, 'subtarefa_criar', { papel: 'Dev', titulo: '' }),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(
      handler.callTool(member, 'entregar', { estado: 'feito', resumo: 'x' }),
    ).rejects.toMatchObject({ code: 'invalid_input' })
  })
})

describe('tarefa_concluir', () => {
  it('Lider conclui: a tarefa vai para Em revisão', async () => {
    const { handler, tasks } = setup()
    const result = await handler.callTool(leader, 'tarefa_concluir', { resumo: 'Login pronto' })
    expect(tasks.getTask('task1').workflowStatus).toBe('em_revisao')
    expect(result.text).toContain('Em revisão')
    expect(result.data).toMatchObject({ tarefa_id: 'task1', status: 'em_revisao' })
  })

  it('membro é recusado e a tarefa não muda', async () => {
    const { handler, tasks } = setup()
    await expect(
      handler.callTool(member, 'tarefa_concluir', { resumo: 'acabei tudo' }),
    ).rejects.toMatchObject({ code: 'forbidden' })
    expect(tasks.getTask('task1').workflowStatus).toBe('em_andamento')
  })

  it('pede resumo e não aceita escolher status', async () => {
    const { handler, tasks } = setup()
    await expect(handler.callTool(leader, 'tarefa_concluir', {})).rejects.toMatchObject({
      code: 'invalid_input',
    })
    await expect(
      handler.callTool(leader, 'tarefa_concluir', { resumo: 'x', status: 'lancado' }),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    expect(tasks.getTask('task1').workflowStatus).toBe('em_andamento')
  })
})

describe('tarefa_renomear', () => {
  it('Lider renomeia e o title fica', async () => {
    const { handler, tasks } = setup()
    const result = await handler.callTool(leader, 'tarefa_renomear', { nome: '  Login novo ' })
    expect(tasks.getTask('task1')).toMatchObject({ name: 'Login novo', title: 'Tarefa' })
    expect(result.text).toBe('Tarefa renomeada para "Login novo".')
    expect(result.data).toEqual({ tarefa_id: 'task1', nome: 'Login novo' })
  })

  it('membro é recusado', async () => {
    const { handler, tasks } = setup()
    await expect(handler.callTool(member, 'tarefa_renomear', { nome: 'x' })).rejects.toMatchObject({
      code: 'forbidden',
    })
    expect(tasks.getTask('task1').name).toBe('Tarefa')
  })

  it('nome com 81 letras ou em branco dá invalid_input', async () => {
    const { handler } = setup()
    for (const nome of ['a'.repeat(81), '   ']) {
      await expect(handler.callTool(leader, 'tarefa_renomear', { nome })).rejects.toMatchObject({
        code: 'invalid_input',
      })
    }
  })
})

describe('tarefa_iniciar', () => {
  it('acha o projeto pelo nome sem caixa e cria tarefa de time com worktree', async () => {
    const { handler, actions } = setup()
    const result = await handler.callTool(leader, 'tarefa_iniciar', {
      projeto: '  ereemby ',
      pedido: 'Ajustar o login',
    })
    expect(actions.createTask).toHaveBeenCalledWith({
      projectId: 'proj2',
      title: 'Ajustar o login',
      description: undefined,
      kind: 'team',
      useWorktree: true,
    })
    expect(result.text).toContain('Ereemby')
    expect(result.data).toEqual({
      tarefa_id: 'nova',
      projeto_id: 'proj2',
      projeto: 'Ereemby',
      nome: 'Ajustar o login',
      branch: 'eclipse/nova',
    })
  })

  it('repassa a descricao ao createTask e recusa acima do limite', async () => {
    const { handler, actions } = setup()
    await handler.callTool(leader, 'tarefa_iniciar', {
      projeto: 'proj1',
      pedido: 'x',
      descricao: 'linha 1\nlinha 2',
    })
    expect(actions.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ description: 'linha 1\nlinha 2' }),
    )
    await expect(
      handler.callTool(leader, 'tarefa_iniciar', {
        projeto: 'proj1',
        pedido: 'x',
        descricao: 'a'.repeat(20_001),
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('acha pelo id e aceita worktree false (branch null)', async () => {
    const { handler, actions } = setup()
    const result = await handler.callTool(leader, 'tarefa_iniciar', {
      projeto: 'proj1',
      pedido: 'x',
      worktree: false,
    })
    expect(actions.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'proj1', useWorktree: false }),
    )
    expect(result.data).toMatchObject({ branch: null })
  })

  it('projeto inexistente dá not_found com os nomes existentes', async () => {
    const { handler, actions } = setup()
    await expect(
      handler.callTool(leader, 'tarefa_iniciar', { projeto: 'nada', pedido: 'x' }),
    ).rejects.toMatchObject({
      code: 'not_found',
      message: expect.stringContaining('Eclipse Code, Ereemby'),
    })
    expect(actions.createTask).not.toHaveBeenCalled()
  })

  it('nome repetido em dois projetos é ambíguo; o id resolve', async () => {
    const { tasks, handler, actions } = setup()
    const base = tasks.listProjects()
    tasks.listProjects = () => [
      ...base,
      { id: 'proj3', name: 'Ereemby', rootPath: '/tmp/p3', createdAt: 1, updatedAt: 1 },
    ]
    await expect(
      handler.callTool(leader, 'tarefa_iniciar', { projeto: 'ereemby', pedido: 'x' }),
    ).rejects.toMatchObject({
      code: 'invalid_input',
      message: expect.stringMatching(/ambíguo.*proj2.*proj3/),
    })
    expect(actions.createTask).not.toHaveBeenCalled()
    await handler.callTool(leader, 'tarefa_iniciar', { projeto: 'proj3', pedido: 'x' })
    expect(actions.createTask).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'proj3' }))
  })

  it('membro é recusado', async () => {
    const { handler, actions } = setup()
    await expect(
      handler.callTool(member, 'tarefa_iniciar', { projeto: 'ereemby', pedido: 'x' }),
    ).rejects.toMatchObject({ code: 'forbidden' })
    expect(actions.createTask).not.toHaveBeenCalled()
  })
})

describe('ferramentas do Lider', () => {
  it('subtarefa_criar acha o papel sem acento/maiuscula e chama o coordenador', async () => {
    const { handler, actions } = setup()
    const result = await handler.callTool(leader, 'subtarefa_criar', {
      papel: 'revisor',
      titulo: 'Revisar login',
      instrucoes: 'Revise o diff',
    })
    expect(actions.createSubtask).toHaveBeenCalledWith(leader, {
      roleId: 'rev',
      title: 'Revisar login',
      instructions: 'Revise o diff',
      referenceTaskIds: [],
    })
    expect(result.text).toContain('novo')
    expect(result.data).toMatchObject({ id: 'novo', papel: 'Revisor', estado: 'na fila' })
  })

  it('subtarefa_criar recusa papel inexistente, o Lider como membro e origem de outra tarefa', async () => {
    const { handler, tasks } = setup()
    await expect(
      handler.callTool(leader, 'subtarefa_criar', { papel: 'Mago', titulo: 't', instrucoes: 'i' }),
    ).rejects.toMatchObject({ code: 'not_found', message: expect.stringContaining('Revisor') })
    await expect(
      handler.callTool(leader, 'subtarefa_criar', { papel: 'Lider', titulo: 't', instrucoes: 'i' }),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    tasks.seedSubtask({ id: 'alheia', taskId: 'task2' })
    await expect(
      handler.callTool(leader, 'subtarefa_criar', {
        papel: 'Dev',
        titulo: 't',
        instrucoes: 'i',
        origem: ['alheia'],
      }),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  it('subtarefa_responder so em duvida; cancelar recusa estado final', async () => {
    const { handler, tasks, actions } = setup()
    tasks.seedSubtask({ id: 'sub1', state: 'working' })
    await expect(
      handler.callTool(leader, 'subtarefa_responder', { subtarefa_id: 'sub1', texto: 'use pg' }),
    ).rejects.toMatchObject({ code: 'invalid_transition' })
    tasks.setState('sub1', 'input_required')
    await handler.callTool(leader, 'subtarefa_responder', { subtarefa_id: 'sub1', texto: 'use pg' })
    expect(actions.answerSubtask).toHaveBeenCalledWith(leader, 'sub1', 'use pg')

    tasks.seedSubtask({ id: 'sub2', state: 'completed' })
    await expect(
      handler.callTool(leader, 'subtarefa_cancelar', { subtarefa_id: 'sub2' }),
    ).rejects.toMatchObject({ code: 'final_state' })
    await handler.callTool(leader, 'subtarefa_cancelar', { subtarefa_id: 'sub1', motivo: 'mudou' })
    expect(actions.cancelSubtask).toHaveBeenCalledWith(leader, 'sub1', 'mudou')
  })

  it('subtarefas_ver lista so a tarefa do chamador e detalha com a entrega', async () => {
    const { handler, tasks } = setup()
    tasks.seedSubtask({ id: 'sub1', state: 'completed', statusMessage: 'ok' })
    tasks.seedSubtask({ id: 'alheia', taskId: 'task2' })
    tasks.addArtifact('sub1', 't1', {
      summary: 'login pronto',
      files: [{ path: 'src/a.ts', change: 'modified' }],
      tests: [{ command: 'pnpm test', result: '3 passed', passed: true }],
    })
    const list = await handler.callTool(leader, 'subtarefas_ver', {})
    expect(list.text).toContain('sub1')
    expect(list.text).not.toContain('alheia')
    const detail = await handler.callTool(leader, 'subtarefas_ver', { subtarefa_id: 'sub1' })
    expect(detail.data).toMatchObject({
      estado: 'pronto',
      entrega: {
        resumo: 'login pronto',
        arquivos: [{ caminho: 'src/a.ts' }],
        testes: [{ passou: true }],
      },
    })
    await expect(
      handler.callTool(leader, 'subtarefas_ver', { subtarefa_id: 'alheia' }),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  it('pergunta_repassar grava a pergunta na tarefa do Lider', async () => {
    const { handler, tasks } = setup()
    const itens = [
      { id: 'i1', prompt: 'Qual banco?', options: [], multiSelect: false, allowFreeText: true },
    ]
    await handler.callTool(leader, 'pergunta_repassar', { itens })
    expect(tasks.questions[0]).toMatchObject({ taskId: 'task1', subtaskId: null, items: itens })
  })
})

describe('entregar', () => {
  it('grava a entrega na sessao do token, mapeando o estado em portugues', async () => {
    const { handler, tasks } = setup()
    await handler.callTool(member, 'entregar', { estado: 'duvida', resumo: 'qual banco?' })
    expect(tasks.deliveries).toEqual([
      {
        sessionId: 'mem-s',
        delivery: {
          state: 'input_required',
          summary: 'qual banco?',
          files: [],
          tests: [],
          questions: [],
        },
      },
    ])
  })
})

describe('subtarefas_esperar', () => {
  it('volta quando todas param, com as entregas, sem consulta em laco', async () => {
    const { handler, tasks } = setup()
    tasks.seedSubtask({ id: 'a', state: 'working' })
    tasks.seedSubtask({ id: 'b', state: 'submitted' })
    tasks.seedSubtask({ id: 'c', state: 'completed' })
    let settled = false
    const waiting = handler.callTool(leader, 'subtarefas_esperar', {}).then((r) => {
      settled = true
      return r
    })
    tasks.addArtifact('a', 'ta', { summary: 'A feito' })
    tasks.setState('a', 'completed')
    await Promise.resolve()
    expect(settled).toBe(false)
    tasks.setState('b', 'working')
    tasks.setState('b', 'input_required', 'qual banco?')
    const result = await waiting
    expect(result.data).toMatchObject({
      prazo_acabou: false,
      subtarefas: [
        { id: 'a', estado: 'pronto', entrega: { resumo: 'A feito' } },
        { id: 'b', estado: 'dúvida', entrega: null, resumo: 'qual banco?' },
      ],
    })
    expect(result.text).toContain('2 de 2 pararam')
  })

  it('modo qualquer volta na primeira; sem nada em andamento volta na hora', async () => {
    const { handler, tasks } = setup()
    const empty = await handler.callTool(leader, 'subtarefas_esperar', {})
    expect(empty.data).toMatchObject({ subtarefas: [] })
    tasks.seedSubtask({ id: 'a', state: 'working' })
    tasks.seedSubtask({ id: 'b', state: 'working' })
    const waiting = handler.callTool(leader, 'subtarefas_esperar', { modo: 'qualquer' })
    tasks.setState('b', 'failed', 'processo morreu')
    const result = await waiting
    expect(result.text).toContain('1 de 2 pararam')
  })

  it('devolve o estado atual quando o prazo acaba e solta quem espera no dispose', async () => {
    vi.useFakeTimers()
    const { handler, tasks } = setup()
    tasks.seedSubtask({ id: 'a', state: 'working' })
    const waiting = handler.callTool(leader, 'subtarefas_esperar', {
      subtarefa_ids: ['a'],
      timeout_segundos: 5,
    })
    await vi.advanceTimersByTimeAsync(5_000)
    expect((await waiting).data).toMatchObject({ prazo_acabou: true })

    const second = handler.callTool(leader, 'subtarefas_esperar', { subtarefa_ids: ['a'] })
    await Promise.resolve()
    handler.dispose()
    expect((await second).data).toMatchObject({ prazo_acabou: true })
  })

  it('recusa id de outra tarefa', async () => {
    const { handler, tasks } = setup()
    tasks.seedSubtask({ id: 'alheia', taskId: 'task2', state: 'working' })
    await expect(
      handler.callTool(leader, 'subtarefas_esperar', { subtarefa_ids: ['alheia'] }),
    ).rejects.toMatchObject({ code: 'not_found' })
  })
})
