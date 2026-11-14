// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from './App'
import { AppStore } from './store/appStore'
import {
  FakeApi,
  makeActivity,
  makeSubtask,
  makeTask,
  mockupData,
  type FakeData,
} from './test/fakeApi'

// jsdom nao tem canvas/WebGL: o xterm vira um <pre> que acumula o que foi escrito.
const xtermInputs: ((data: string) => void)[] = []
vi.mock('./terminal/createXterm', () => ({
  createXterm: (container: HTMLElement) => {
    const pre = document.createElement('pre')
    pre.setAttribute('data-testid', 'xterm')
    container.appendChild(pre)
    return {
      write: (data: string) => {
        pre.textContent = (pre.textContent ?? '') + data
      },
      onData: (listener: (data: string) => void) => {
        xtermInputs.push(listener)
        return () => {
          xtermInputs.splice(xtermInputs.indexOf(listener), 1)
        }
      },
      fit: () => ({ cols: 100, rows: 30 }),
      focus: () => undefined,
      dispose: () => pre.remove(),
    }
  },
}))

let api: FakeApi

async function renderApp(data: FakeData = mockupData()) {
  api = new FakeApi(data)
  const store = new AppStore(api)
  const view = render(<App store={store} />)
  await screen.findByTestId('task-t1')
  return { store, view }
}

/** O "Adicionar projeto" fica no rodapé do seletor de projeto do topo. */
function openAddProject() {
  fireEvent.click(screen.getByRole('button', { name: /^Projeto: / }))
  const picker = screen.getByRole('dialog', { name: 'Trocar projeto' })
  fireEvent.click(within(picker).getByRole('button', { name: '+ Adicionar projeto' }))
}

describe('Configurações', () => {
  const openSettings = () => fireEvent.click(screen.getByRole('button', { name: 'Configurações' }))

  it('foca o primeiro campo depois de carregar os valores', async () => {
    await renderApp()
    openSettings()
    const dialog = screen.getByRole('dialog', { name: 'Configurações' })
    const agents = await within(dialog).findByLabelText(/Máximo de agentes vivos no app/)
    await waitFor(() => expect(document.activeElement).toBe(agents))
  })

  it('abre com os limites atuais e salva vazio como sem limite', async () => {
    await renderApp()
    api.agentLimits = { maxLiveAgents: 12, maxLiveMembersPerTask: null }
    openSettings()
    const dialog = screen.getByRole('dialog', { name: 'Configurações' })
    const agents = await within(dialog).findByLabelText(/Máximo de agentes vivos no app/)
    await waitFor(() => expect(agents).toHaveProperty('value', '12'))
    const members = within(dialog).getByLabelText(/Máximo de membros vivos por tarefa/)
    expect(members).toHaveProperty('value', '')
    fireEvent.change(agents, { target: { value: '' } })
    fireEvent.change(members, { target: { value: '3' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Configurações' })).toBeNull())
    expect(api.callsTo('settings.save')).toEqual([
      { maxLiveAgents: null, maxLiveMembersPerTask: 3 },
    ])
  })

  it('valor inválido mostra o erro no modal e não grava', async () => {
    await renderApp()
    openSettings()
    const dialog = screen.getByRole('dialog', { name: 'Configurações' })
    const agents = await within(dialog).findByLabelText(/Máximo de agentes vivos no app/)
    await waitFor(() => expect(agents).toHaveProperty('disabled', false))
    fireEvent.change(agents, { target: { value: '101' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }))
    expect((await within(dialog).findByRole('alert')).textContent).toContain('1 a 100')
    expect(api.callsTo('settings.save')).toEqual([])
  })

  it('erro do main aparece no modal; Cancelar fecha sem gravar', async () => {
    await renderApp()
    api.overrides.set('settings.save', () => ({
      ok: false,
      error: { code: 'invalid_input', message: 'recusado pelo main' },
    }))
    openSettings()
    const dialog = screen.getByRole('dialog', { name: 'Configurações' })
    const agents = await within(dialog).findByLabelText(/Máximo de agentes vivos no app/)
    await waitFor(() => expect(agents).toHaveProperty('disabled', false))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }))
    expect((await within(dialog).findByRole('alert')).textContent).toContain('recusado pelo main')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }))
    expect(screen.queryByRole('dialog', { name: 'Configurações' })).toBeNull()
  })

  it('Second Brain: salva a chave, mostra só o final e remove', async () => {
    await renderApp()
    openSettings()
    const dialog = screen.getByRole('dialog', { name: 'Configurações' })
    const field = await within(dialog).findByLabelText(/Chave de acesso/)
    fireEvent.change(field, { target: { value: 'sbk_segredo5678' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Salvar chave' }))
    expect(await within(dialog).findByText('Chave salva (…5678)')).toBeTruthy()
    expect(api.callsTo('brain.setKey')).toEqual([{ key: 'sbk_segredo5678' }])
    expect(dialog.textContent).not.toContain('segredo')
    expect(field).toHaveProperty('value', '')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remover chave' }))
    await waitFor(() => expect(within(dialog).getByText(/Nenhuma chave salva/)).toBeTruthy())
    expect(api.callsTo('brain.setKey')).toEqual([{ key: 'sbk_segredo5678' }, { key: null }])
  })

  it('Second Brain: texto sem sbk_ não vai ao main', async () => {
    await renderApp()
    openSettings()
    const dialog = screen.getByRole('dialog', { name: 'Configurações' })
    fireEvent.change(await within(dialog).findByLabelText(/Chave de acesso/), {
      target: { value: 'qualquer' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Salvar chave' }))
    expect((await within(dialog).findByRole('alert')).textContent).toContain('sbk_')
    expect(api.callsTo('brain.setKey')).toEqual([])
  })
})

function middle() {
  return screen.getByRole('region', { name: 'Centro' })
}

beforeEach(() => {
  xtermInputs.length = 0
  localStorage.clear()
})
afterEach(() => {
  vi.clearAllMocks()
})

describe('tela de 3 colunas', () => {
  it('mostra tarefas por status, subtarefas e o contador "precisa de você"', async () => {
    await renderApp()
    const list = screen.getByRole('region', { name: 'Tarefas' })
    expect(within(list).getByText('Em andamento')).toBeTruthy()
    expect(within(list).getByText('conversa solta')).toBeTruthy()
    expect(
      within(list).getByTestId('task-solo1').querySelector('.m')?.getAttribute('title'),
    ).toContain('avulso')
    expect(screen.getByTestId('need-you').textContent).toMatch(/^1 precisa de você/)

    const right = screen.getByRole('region', { name: 'Subtarefas' })
    expect(within(right).getByTestId('subtask-count').textContent).toBe('1/3 prontas')
    const testes = within(right).getByTestId('subtask-t')
    expect(testes.textContent).toContain('Testes')
    expect(testes.textContent).toContain('trabalhando · Codex')
    expect(within(right).getByTestId('subtask-d1').textContent).toContain('pronto · sonnet · 5 min')
  })

  it('abre o terminal do Líder com o scrollback e manda a digitação ao main', async () => {
    await renderApp()
    const term = await within(middle()).findByTestId('xterm')
    await waitFor(() => expect(term.textContent).toContain('vings: plano já está feito'))
    expect(api.callsTo('leader.ensure')).toContainEqual({ taskId: 't1' })

    act(() => api.emit('terminal.data', { sessionId: 'lead-t1', data: 'saída nova' }))
    act(() => api.emit('terminal.data', { sessionId: 'outra', data: 'não é daqui' }))
    expect(term.textContent).toContain('saída nova')
    expect(term.textContent).not.toContain('não é daqui')

    xtermInputs[0]?.('ls\r')
    expect(api.callsTo('terminal.write')).toContainEqual({ sessionId: 'lead-t1', data: 'ls\r' })
    expect(api.callsTo('terminal.resize')).toContainEqual({
      sessionId: 'lead-t1',
      cols: 100,
      rows: 30,
    })
  })

  it('troca entre Líder, Entrega e Atividade', async () => {
    await renderApp()
    fireEvent.click(screen.getByTestId('subtask-d1'))

    const delivery = await within(middle()).findByTestId('delivery')
    expect(delivery.textContent).toContain('Adicionei group_by=offer')
    expect(delivery.textContent).toContain('src/reports/report.ts')
    expect(delivery.textContent).toContain('npm run analise')
    expect(screen.getByRole('tab', { name: 'Entrega' }).getAttribute('aria-selected')).toBe('true')
    expect(within(middle()).getByTestId('leader-terminal').closest('[hidden]')).not.toBeNull()

    fireEvent.click(screen.getByRole('tab', { name: 'Atividade' }))
    const activity = within(middle()).getByTestId('activity')
    expect(within(middle()).queryByTestId('delivery')).toBeNull()
    expect(activity.textContent).toContain('Ler report.ts')
    expect(activity.textContent).toContain('Pronto, group_by adicionado.')
    expect(activity.textContent).toContain('fim do turno · fim normal')

    fireEvent.click(screen.getByRole('tab', { name: 'Líder' }))
    expect(within(middle()).queryByTestId('activity')).toBeNull()
    expect(within(middle()).getByTestId('leader-terminal').closest('[hidden]')).toBeNull()

    // Clicar na tarefa volta para o Líder e tira as abas.
    fireEvent.click(screen.getByTestId('task-t1'))
    expect(screen.queryByRole('tab', { name: 'Entrega' })).toBeNull()
    expect(within(middle()).getByText('Líder · terminal')).toBeTruthy()
    // O xterm nao foi recriado ao trocar de aba: so um leader.ensure para t1.
    expect(
      api.callsTo('leader.ensure').filter((c) => (c as { taskId: string }).taskId === 't1'),
    ).toHaveLength(1)
  })

  it('atualiza atividade e estado ao vivo pelos eventos do main', async () => {
    await renderApp()
    fireEvent.click(screen.getByTestId('subtask-t'))
    fireEvent.click(await screen.findByRole('tab', { name: 'Atividade' }))
    const sub = makeSubtask('t', 't1', { roleId: 'qa', title: 'Cobrir by_offer' })
    act(() =>
      api.emitDomain({
        type: 'activity.appended',
        events: [
          makeActivity(sub, 1, {
            kind: 'tool_call',
            toolCallId: 'c9',
            title: 'npx jest report.test.ts',
            toolKind: 'execute',
            status: 'in_progress',
            input: null,
          }),
        ],
      }),
    )
    expect(within(middle()).getByTestId('activity').textContent).toContain(
      'npx jest report.test.ts',
    )

    act(() =>
      api.emitDomain({
        type: 'subtask.upserted',
        subtask: { ...sub, state: 'failed', failureCode: 'silent_timeout', finishedAt: Date.now() },
      }),
    )
    expect(screen.getByTestId('subtask-t').textContent).toContain('bloqueado')
    fireEvent.click(screen.getByRole('tab', { name: 'Entrega' }))
    expect(within(middle()).getByTestId('delivery').textContent).toContain('sem resposta')
  })

  it('responde a dúvida repassada pelo Líder: marca a opção e confirma', async () => {
    await renderApp()
    fireEvent.click(screen.getByTestId('need-you'))
    const question = await within(middle()).findByTestId('question')
    const option = within(question).getByText('Sem origem').closest('button')!
    fireEvent.click(option)
    expect(option.getAttribute('aria-pressed')).toBe('true')
    expect(api.callsTo('questions.answer')).toHaveLength(0)
    fireEvent.click(within(question).getByRole('button', { name: /Enviar/ }))
    await waitFor(() =>
      expect(api.callsTo('questions.answer')).toEqual([
        { questionId: 'q1', answers: [{ itemId: 'i1', optionIds: ['o2'], text: null }] },
      ]),
    )
    await waitFor(() =>
      expect(screen.getByTestId('need-you').textContent).toMatch(/^0 precisam de você/),
    )
  })

  it('cria tarefa pelo nome e abre o terminal dela', async () => {
    await renderApp()
    fireEvent.click(screen.getByText('+ tarefa'))
    const form = screen.getByRole('form', { name: 'Nova tarefa' })
    fireEvent.change(within(form).getByLabelText('Nome'), {
      target: { value: 'relatório por oferta' },
    })
    expect(form.textContent).toContain('Cria uma worktree e uma branch')
    fireEvent.click(within(form).getByText('Criar tarefa'))
    await waitFor(() =>
      expect(api.callsTo('tasks.create')).toEqual([
        { projectId: 'p1', title: 'relatório por oferta', kind: 'team', useWorktree: true },
      ]),
    )
    await waitFor(() => expect(api.callsTo('leader.ensure')).toContainEqual({ taskId: 't-new-4' }))
    expect(screen.queryByRole('form', { name: 'Nova tarefa' })).toBeNull()
  })

  it('avulso sem worktree roda na raiz', async () => {
    await renderApp()
    fireEvent.click(screen.getByText('+ tarefa'))
    const form = screen.getByRole('form', { name: 'Nova tarefa' })
    fireEvent.change(within(form).getByLabelText('Nome'), { target: { value: 'pergunta rápida' } })
    fireEvent.click(within(form).getByLabelText(/Avulso/))
    fireEvent.change(within(form).getByLabelText('Agente'), { target: { value: 'codex' } })
    fireEvent.click(within(form).getByLabelText(/Criar worktree própria/))
    fireEvent.click(within(form).getByText('Criar tarefa'))
    await waitFor(() =>
      expect(api.callsTo('tasks.create')).toEqual([
        {
          projectId: 'p1',
          title: 'pergunta rápida',
          kind: 'solo',
          useWorktree: false,
          soloProvider: 'codex',
        },
      ]),
    )
  })
})

describe('status da tarefa na lista', () => {
  function list() {
    return screen.getByRole('region', { name: 'Tarefas' })
  }
  function groupLabels() {
    return within(list())
      .getAllByRole('group')
      .map((g) => g.getAttribute('aria-label'))
  }

  it('agrupa na ordem dos status, com contador, sem grupo vazio e Concluída recolhido', async () => {
    await renderApp()
    expect(groupLabels()).toEqual(['A fazer', 'Em andamento', 'Concluída'])
    expect(within(list()).queryByText('Em revisão')).toBeNull()
    expect(within(screen.getByTestId('group-a_fazer')).getByText('1')).toBeTruthy()
    expect(screen.getByTestId('group-lancado').getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByTestId('task-old1')).toBeNull()

    fireEvent.click(screen.getByTestId('group-lancado'))
    expect(screen.getByTestId('group-lancado').getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByTestId('task-old1').textContent).toContain('checkout antigo')

    fireEvent.click(screen.getByTestId('group-em_andamento'))
    expect(screen.queryByTestId('task-t1')).toBeNull()
  })

  it('ícone abre menu com os 6 status e a troca vai ao main e move a tarefa de grupo', async () => {
    await renderApp()
    const row = screen.getByTestId('task-t1')
    fireEvent.click(within(row).getByRole('button', { name: /Status de feat-orfer-e-up/ }))
    const menu = screen.getByRole('menu', { name: 'Trocar status de feat-orfer-e-up' })
    const options = within(menu).getAllByRole('menuitemradio')
    expect(options.map((o) => o.textContent)).toEqual([
      'A fazer',
      'Em andamento',
      'Pergunta para você',
      'Em revisão',
      'Pronto pra lançar',
      'Concluída',
    ])
    expect(options[1]?.getAttribute('aria-checked')).toBe('true')
    // Abrir o menu nao seleciona a tarefa nem muda nada.
    expect(api.callsTo('tasks.setStatus')).toEqual([])

    fireEvent.click(within(menu).getByText('Em revisão'))
    expect(screen.queryByRole('menu')).toBeNull()
    await waitFor(() =>
      expect(api.callsTo('tasks.setStatus')).toEqual([{ taskId: 't1', status: 'em_revisao' }]),
    )
    await waitFor(() => expect(groupLabels()).toEqual(['A fazer', 'Em revisão', 'Concluída']))
    expect(
      within(screen.getByRole('group', { name: 'Em revisão' })).getByText('feat-orfer-e-up'),
    ).toBeTruthy()
  })

  it('escolher o status atual ou apertar Esc não chama o main', async () => {
    await renderApp()
    const button = within(screen.getByTestId('task-t1')).getByRole('button', {
      name: /Status de/,
    })
    fireEvent.click(button)
    fireEvent.click(within(screen.getByRole('menu')).getByText('Em andamento'))
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.click(button)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(api.callsTo('tasks.setStatus')).toEqual([])
  })

  it('marcar Concluída arquiva e o centro mostra a tarefa lançada', async () => {
    await renderApp()
    fireEvent.click(
      within(screen.getByTestId('task-t1')).getByRole('button', { name: /Status de/ }),
    )
    fireEvent.click(within(screen.getByRole('menu')).getByText('Concluída'))
    await waitFor(() => expect(within(middle()).getByTestId('task-launched')).toBeTruthy())
    expect(groupLabels()).toEqual(['A fazer', 'Concluída'])
    expect(within(screen.getByTestId('group-lancado')).getByText('2')).toBeTruthy()
  })
})

/** Três projetos: o da maquete (p1), um com acento na home (p2) e um vazio fora dela (p3). */
function threeProjects(): FakeData {
  const d = mockupData()
  const q1 = d.questions[0]!
  d.projects.push(
    {
      id: 'p2',
      name: 'Árvore Genealógica',
      rootPath: '/home/vings/Projetos/arvore',
      createdAt: 1,
      updatedAt: 1,
    },
    { id: 'p3', name: 'zeta', rootPath: '/data/zeta', createdAt: 1, updatedAt: 1 },
  )
  d.tasks.push(
    makeTask('a1', 'raiz da árvore', { projectId: 'p2' }),
    makeTask('a2', 'galhos', { projectId: 'p2' }),
  )
  d.questions.push(
    { ...q1, id: 'qa1', taskId: 'a1', subtaskId: null },
    { ...q1, id: 'qa2', taskId: 'a2', subtaskId: null },
  )
  return d
}

function picker() {
  return screen.getByRole('dialog', { name: 'Trocar projeto' })
}

function search() {
  return within(picker()).getByRole('combobox', { name: 'Buscar projeto' })
}

function optionIds(): string[] {
  return within(picker())
    .queryAllByRole('option')
    .map((o) => o.getAttribute('data-testid') ?? '')
}

function highlighted(): string | null {
  const active = within(picker())
    .queryAllByRole('option')
    .find((o) => o.getAttribute('aria-selected') === 'true')
  return active?.getAttribute('data-testid') ?? null
}

describe('seletor de projeto do topo', () => {
  it('abre com a busca focada; Esc fecha e devolve o foco; clique fora fecha', async () => {
    await renderApp(threeProjects())
    const button = screen.getByRole('button', { name: 'Projeto: ereemby' })
    expect(button.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(button)
    expect(document.activeElement).toBe(search())
    expect(button.getAttribute('aria-expanded')).toBe('true')
    expect(optionIds()).toEqual(['project-option-p1', 'project-option-p2', 'project-option-p3'])

    fireEvent.keyDown(search(), { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Trocar projeto' })).toBeNull()
    expect(document.activeElement).toBe(button)

    fireEvent.click(button)
    expect(picker()).toBeTruthy()
    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('dialog', { name: 'Trocar projeto' })).toBeNull()
  })

  it('mostra caminho com ~, check no atual, tarefas abertas e o badge "precisa de você"', async () => {
    await renderApp(threeProjects())
    fireEvent.click(screen.getByRole('button', { name: 'Projeto: ereemby' }))
    await within(picker()).findByTestId('project-open-p1')
    expect(api.callsTo('projects.summary')).toHaveLength(1)

    const p1 = within(picker()).getByTestId('project-option-p1')
    expect(p1.getAttribute('aria-current')).toBe('true')
    expect(p1.querySelector('.proj-check svg')).not.toBeNull()
    expect(within(p1).getByText('/repo/ereemby')).toBeTruthy()
    // t1 e solo1 abertas; old1 arquivada fica fora.
    expect(within(picker()).getByTestId('project-open-p1').textContent).toBe('2')
    expect(within(picker()).getByTestId('project-need-p1').textContent).toBe('1 precisa de você')

    const p2 = within(picker()).getByTestId('project-option-p2')
    expect(p2.getAttribute('aria-current')).toBeNull()
    expect(within(p2).getByText('~/Projetos/arvore')).toBeTruthy()
    expect(within(picker()).getByTestId('project-need-p2').textContent).toBe('2 precisam de você')

    expect(within(picker()).getByTestId('project-open-p3').textContent).toBe('0')
    expect(within(picker()).queryByTestId('project-need-p3')).toBeNull()
  })

  it('busca por nome e caminho sem diferenciar maiúsculas e acentos', async () => {
    await renderApp(threeProjects())
    fireEvent.click(screen.getByRole('button', { name: 'Projeto: ereemby' }))

    fireEvent.change(search(), { target: { value: 'ARVORE genealogica' } })
    expect(optionIds()).toEqual(['project-option-p2'])
    expect(highlighted()).toBe('project-option-p2')

    fireEvent.change(search(), { target: { value: 'data/ZE' } })
    expect(optionIds()).toEqual(['project-option-p3'])

    fireEvent.change(search(), { target: { value: 'nada disso' } })
    expect(optionIds()).toEqual([])
    expect(within(picker()).getByText('Nenhum projeto encontrado.')).toBeTruthy()
  })

  it('↑/↓ movem o destaque a partir do atual e Enter abre o projeto', async () => {
    const { store } = await renderApp(threeProjects())
    const button = screen.getByRole('button', { name: 'Projeto: ereemby' })
    fireEvent.click(button)
    expect(highlighted()).toBe('project-option-p1')

    fireEvent.keyDown(search(), { key: 'ArrowDown' })
    expect(highlighted()).toBe('project-option-p2')
    expect(search().getAttribute('aria-activedescendant')).toBe(
      within(picker()).getByTestId('project-option-p2').id,
    )
    fireEvent.keyDown(search(), { key: 'ArrowUp' })
    fireEvent.keyDown(search(), { key: 'ArrowUp' })
    expect(highlighted()).toBe('project-option-p3')
    fireEvent.keyDown(search(), { key: 'ArrowDown' })
    fireEvent.keyDown(search(), { key: 'ArrowDown' })
    expect(highlighted()).toBe('project-option-p2')

    fireEvent.keyDown(search(), { key: 'Enter' })
    expect(screen.queryByRole('dialog', { name: 'Trocar projeto' })).toBeNull()
    await screen.findByTestId('task-a1')
    expect(store.getState().projectId).toBe('p2')
    expect(api.callsTo('tasks.list')).toContainEqual({ projectId: 'p2', includeArchived: true })
    expect(screen.queryByTestId('task-t1')).toBeNull()
    const renamed = screen.getByRole('button', { name: 'Projeto: Árvore Genealógica' })
    expect(document.activeElement).toBe(renamed)
  })

  it('hover destaca e clique abre o projeto', async () => {
    const { store } = await renderApp(threeProjects())
    fireEvent.click(screen.getByRole('button', { name: 'Projeto: ereemby' }))
    const p3 = within(picker()).getByTestId('project-option-p3')
    fireEvent.mouseMove(p3)
    expect(highlighted()).toBe('project-option-p3')
    fireEvent.click(p3)
    await waitFor(() => expect(store.getState().projectId).toBe('p3'))
    expect(screen.getByRole('button', { name: 'Projeto: zeta' })).toBeTruthy()
  })

  it('"+ Adicionar projeto" fecha o seletor e abre o modal', async () => {
    await renderApp(threeProjects())
    expect(screen.queryByRole('button', { name: '+ projeto' })).toBeNull()
    openAddProject()
    expect(screen.queryByRole('dialog', { name: 'Trocar projeto' })).toBeNull()
    expect(screen.getByRole('dialog', { name: 'Adicionar projeto' })).toBeTruthy()
  })

  it('Ctrl+O abre o seletor; no terminal do Líder e com modal aberto não abre', async () => {
    await renderApp(threeProjects())
    const term = await within(middle()).findByTestId('xterm')
    fireEvent.keyDown(term, { key: 'o', ctrlKey: true })
    expect(screen.queryByRole('dialog', { name: 'Trocar projeto' })).toBeNull()

    fireEvent.keyDown(document.body, { key: 'o', ctrlKey: true })
    expect(document.activeElement).toBe(search())
    fireEvent.keyDown(search(), { key: 'Escape' })

    openAddProject()
    fireEvent.keyDown(document.body, { key: 'o', ctrlKey: true })
    expect(screen.queryByRole('dialog', { name: 'Trocar projeto' })).toBeNull()
  })

  it('sem projetos mostra o estado vazio com o botão de adicionar', async () => {
    const data = mockupData()
    data.projects = []
    api = new FakeApi(data)
    render(<App store={new AppStore(api)} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Escolher projeto' }))
    expect(within(picker()).getByText('Nenhum projeto ainda')).toBeTruthy()
    expect(within(picker()).queryByRole('combobox')).toBeNull()
    const add = within(picker()).getByRole('button', { name: '+ Adicionar projeto' })
    expect(document.activeElement).toBe(add)
    fireEvent.click(add)
    expect(screen.getByRole('dialog', { name: 'Adicionar projeto' })).toBeTruthy()
  })
})

describe('modal Adicionar projeto', () => {
  it('abre o explorador, mostra a pasta e adiciona com o nome editado', async () => {
    await renderApp()
    openAddProject()
    const dialog = screen.getByRole('dialog', { name: 'Adicionar projeto' })
    const submit = within(dialog).getByRole('button', { name: 'Adicionar projeto' })
    expect((submit as HTMLButtonElement).disabled).toBe(true)

    api.nextPickedFolder = {
      path: '/data/Projects/vingsdev',
      name: 'vingsdev',
      isGitRepo: true,
      alreadyAdded: false,
    }
    fireEvent.click(within(dialog).getByRole('button', { name: /Escolher pasta/ }))
    await within(dialog).findByText('/data/Projects/vingsdev')
    expect(within(dialog).getByText('Repositório git encontrado.')).toBeTruthy()
    expect(api.callsTo('projects.pickFolder')).toHaveLength(1)

    fireEvent.change(within(dialog).getByLabelText('Nome do projeto'), {
      target: { value: 'vings.dev' },
    })
    fireEvent.click(submit)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(api.callsTo('projects.add')).toEqual([
      { rootPath: '/data/Projects/vingsdev', name: 'vings.dev' },
    ])
  })

  it('cancelar o explorador não muda nada; pasta repetida bloqueia; Esc fecha', async () => {
    await renderApp()
    openAddProject()
    const dialog = screen.getByRole('dialog', { name: 'Adicionar projeto' })

    api.nextPickedFolder = null
    fireEvent.click(within(dialog).getByRole('button', { name: /Escolher pasta/ }))
    await waitFor(() => expect(api.callsTo('projects.pickFolder')).toHaveLength(1))
    expect(within(dialog).queryByLabelText('Nome do projeto')).toBeNull()

    api.nextPickedFolder = {
      path: '/repo/ereemby',
      name: 'ereemby',
      isGitRepo: true,
      alreadyAdded: true,
    }
    fireEvent.click(within(dialog).getByRole('button', { name: /Escolher pasta/ }))
    await within(dialog).findByText('Essa pasta já é um projeto.')
    expect(
      (within(dialog).getByRole('button', { name: 'Adicionar projeto' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(api.callsTo('projects.add')).toHaveLength(0)
  })
})

describe('pergunta fechada sem resposta no card', () => {
  it('substituída sai do contador e a entrega mostra o rótulo', async () => {
    await renderApp()
    expect(screen.getByTestId('need-you').textContent).toMatch(/^1 precisa de você/)
    const q1 = api.data.questions[0]!
    act(() =>
      api.emitDomain({
        type: 'question.upserted',
        question: { ...q1, status: 'superseded', answeredAt: Date.now() },
      }),
    )
    expect(screen.getByTestId('need-you').textContent).toMatch(/^0 precisam de você/)
    fireEvent.click(screen.getByTestId('subtask-d2'))
    const note = await within(middle()).findByTestId('question-closed')
    expect(note.textContent).toBe('Pergunta ao usuário: substituída.')
    expect(within(middle()).queryByTestId('question')).toBeNull()
  })

  it('respondida no terminal também conta como fechada', async () => {
    await renderApp()
    const q1 = api.data.questions[0]!
    act(() =>
      api.emitDomain({
        type: 'question.upserted',
        question: { ...q1, status: 'answered_in_terminal', answeredAt: Date.now() },
      }),
    )
    expect(screen.getByTestId('need-you').textContent).toMatch(/^0 precisam de você/)
    fireEvent.click(screen.getByTestId('subtask-d2'))
    expect((await within(middle()).findByTestId('question-closed')).textContent).toContain(
      'respondida no terminal',
    )
  })
})

describe('painéis do rodape da coluna esquerda', () => {
  function statusRow(status: string) {
    return screen.getByTestId(`status-row-${status}`)
  }

  it('Status mostra os 6 status na ordem, com 0 nos vazios e o total de abertas', async () => {
    await renderApp()
    const panel = screen.getByRole('region', { name: 'Status' })
    const rows = within(panel).getAllByRole('button').slice(1)
    expect(rows.map((r) => r.textContent)).toEqual([
      'A fazer1',
      'Em andamento1',
      'Pergunta para você0',
      'Em revisão0',
      'Pronto pra lançar0',
      'Concluída1',
    ])
    expect(rows.every((r) => r.querySelector('.ic') !== null)).toBe(true)
    // Abertas: t1 e solo1 (old1 está lançada).
    expect(screen.getByTestId('panel-status-count').textContent).toBe('2')
    expect((statusRow('em_revisao') as HTMLButtonElement).disabled).toBe(true)

    // Contagem acompanha os eventos do main.
    act(() =>
      api.emitDomain({
        type: 'task.upserted',
        task: { ...api.data.tasks[0]!, workflowStatus: 'em_revisao', updatedAt: Date.now() },
      }),
    )
    expect(statusRow('em_andamento').textContent).toBe('Em andamento0')
    expect(statusRow('em_revisao').textContent).toBe('Em revisão1')
  })

  it('recolhe e expande cada seção e lembra no localStorage', async () => {
    const { view } = await renderApp()
    const head = within(screen.getByRole('region', { name: 'Status' })).getByRole('button', {
      name: /Status/,
    })
    expect(head.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(head)
    expect(head.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByTestId('status-row-a_fazer')).toBeNull()
    // Time continua aberto: estado é por seção.
    expect(screen.getByTestId('team-row-lead')).toBeTruthy()
    expect(JSON.parse(localStorage.getItem('eclipse.sidePanels.collapsed') ?? '{}')).toEqual({
      status: true,
    })

    view.unmount()
    await renderApp()
    expect(screen.queryByTestId('status-row-a_fazer')).toBeNull()
    fireEvent.click(
      within(screen.getByRole('region', { name: 'Status' })).getByRole('button', {
        name: /Status/,
      }),
    )
    expect(screen.getByTestId('status-row-a_fazer')).toBeTruthy()
  })

  it('localStorage quebrado não derruba a tela', async () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('bloqueado')
    })
    const setSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('bloqueado')
    })
    try {
      await renderApp()
      const head = within(screen.getByRole('region', { name: 'Time' })).getByRole('button', {
        name: /Time/,
      })
      fireEvent.click(head)
      expect(head.getAttribute('aria-expanded')).toBe('false')
    } finally {
      spy.mockRestore()
      setSpy.mockRestore()
    }
  })

  it('clicar em Concluída expande o grupo recolhido e foca o cabeçalho dele', async () => {
    await renderApp()
    expect(screen.getByTestId('group-lancado').getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(statusRow('lancado'))
    const group = screen.getByTestId('group-lancado')
    expect(group.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByTestId('task-old1')).toBeTruthy()
    expect(document.activeElement).toBe(group)

    fireEvent.click(statusRow('a_fazer'))
    expect(document.activeElement).toBe(screen.getByTestId('group-a_fazer'))
    expect(api.callsTo('tasks.setStatus')).toEqual([])
  })

  it('Time: Líder primeiro com etiqueta, depois membros em ordem alfabética', async () => {
    const data = mockupData()
    data.roles = [
      { ...data.roles[2]!, name: 'Testes', description: 'escreve testes' },
      { ...data.roles[1]!, name: 'Back' },
      { ...data.roles[0]!, name: 'Coordenador' },
    ]
    await renderApp(data)
    const panel = screen.getByRole('region', { name: 'Time' })
    const rows = within(panel).getAllByRole('listitem')
    expect(rows.map((r) => r.querySelector('.side-name')?.textContent)).toEqual([
      'Coordenador',
      'Back',
      'Testes',
    ])
    expect(rows[0]?.querySelector('.side-tag')?.textContent).toBe('Líder')
    expect(rows[1]?.querySelector('.side-tag')).toBeNull()
    expect(rows[0]?.querySelector('.side-meta')?.textContent).toBe('Claude · opus')
    expect(rows[2]?.querySelector('.side-meta')?.textContent).toBe('Codex')
    expect(rows[2]?.getAttribute('title')).toBe('escreve testes')
    expect(screen.getByTestId('panel-team-count').textContent).toBe('3')
  })

  it('Time sem papéis mostra o aviso curto', async () => {
    const data = mockupData()
    data.roles = []
    await renderApp(data)
    const panel = screen.getByRole('region', { name: 'Time' })
    expect(within(panel).getByText('Nenhum agente neste projeto.')).toBeTruthy()
    expect(screen.getByTestId('panel-team-count').textContent).toBe('0')
  })
})

describe('pergunta do Líder', () => {
  it('aparece em cima do terminal do Líder e o botão "precisa de você" leva até ela', async () => {
    api = new FakeApi(mockupData())
    const base = api.data.questions[0]!
    api.data.questions = [
      {
        ...base,
        id: 'q-lead',
        subtaskId: null,
        items: [{ ...base.items[0]!, prompt: 'Quem manda e-mail no chat?' }],
      },
    ]
    const store = new AppStore(api)
    render(<App store={store} />)
    await screen.findByTestId('task-t1')

    fireEvent.click(screen.getByTestId('need-you'))
    const card = await screen.findByTestId('leader-question')
    expect(within(card).getByText('Quem manda e-mail no chat?')).toBeTruthy()
    expect(within(middle()).getByTestId('leader-terminal')).toBeTruthy()
  })
})

describe('cartão de pergunta com 2 itens', () => {
  async function openTwoItems() {
    api = new FakeApi(mockupData())
    const base = api.data.questions[0]!
    const first = base.items[0]!
    api.data.questions = [
      {
        ...base,
        id: 'q-two',
        subtaskId: null,
        items: [
          { ...first, id: 'i1', multiSelect: true },
          { ...first, id: 'i2', prompt: 'Segunda pergunta?', allowFreeText: true },
        ],
      },
    ]
    render(<App store={new AppStore(api)} />)
    await screen.findByTestId('task-t1')
    fireEvent.click(screen.getByTestId('need-you'))
    return screen.findByTestId('leader-question')
  }

  it('Enviar no item 1 só avança; envia quando os dois têm resposta', async () => {
    const card = await openTwoItems()
    fireEvent.click(within(card).getByText('Sem origem').closest('button')!)
    fireEvent.click(within(card).getByRole('button', { name: /Próxima/ }))
    expect(api.callsTo('questions.answer')).toHaveLength(0)
    expect(within(card).getByText('Segunda pergunta?')).toBeTruthy()

    fireEvent.change(within(card).getByPlaceholderText('Outra: escreva a sua resposta'), {
      target: { value: 'minha resposta' },
    })
    fireEvent.click(within(card).getByRole('button', { name: /Enviar/ }))
    await waitFor(() =>
      expect(api.callsTo('questions.answer')).toEqual([
        {
          questionId: 'q-two',
          answers: [
            { itemId: 'i1', optionIds: ['o2'], text: null },
            { itemId: 'i2', optionIds: [], text: 'minha resposta' },
          ],
        },
      ]),
    )
  })

  it('Ctrl+Enter segue a mesma regra', async () => {
    const card = await openTwoItems()
    fireEvent.click(within(card).getByText('Sem origem').closest('button')!)
    fireEvent.keyDown(within(card).getByTitle('Ctrl+Enter'), { key: 'Enter', ctrlKey: true })
    expect(api.callsTo('questions.answer')).toHaveLength(0)
    expect(within(card).getByText('Segunda pergunta?')).toBeTruthy()

    fireEvent.change(within(card).getByPlaceholderText('Outra: escreva a sua resposta'), {
      target: { value: 'ok' },
    })
    fireEvent.keyDown(within(card).getByTitle('Ctrl+Enter'), { key: 'Enter', ctrlKey: true })
    await waitFor(() => expect(api.callsTo('questions.answer')).toHaveLength(1))
  })
})

describe('cartão de pergunta: Ctrl+Enter', () => {
  it('envia com Ctrl+Enter quando há resposta e ignora sem resposta', async () => {
    api = new FakeApi(mockupData())
    const base = api.data.questions[0]!
    api.data.questions = [
      {
        ...base,
        id: 'q-ctrl',
        subtaskId: null,
        items: [{ ...base.items[0]!, allowFreeText: true }],
      },
    ]
    const store = new AppStore(api)
    render(<App store={store} />)
    await screen.findByTestId('task-t1')
    fireEvent.click(screen.getByTestId('need-you'))
    const card = await screen.findByTestId('leader-question')
    const input = within(card).getByPlaceholderText('Outra: escreva a sua resposta')

    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true })
    expect(api.callsTo('questions.answer')).toHaveLength(0)

    fireEvent.change(input, { target: { value: 'só a entrega automática' } })
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true })
    await waitFor(() => expect(api.callsTo('questions.answer')).toHaveLength(1))
  })

  it('a coluna de subtarefas não tem mais a legenda', async () => {
    await renderApp()
    expect(screen.queryByLabelText('Legenda')).toBeNull()
  })
})

describe('subtarefa abre na aba certa', () => {
  it('membro trabalhando abre na Atividade; pronto abre na Entrega', async () => {
    await renderApp()
    fireEvent.click(screen.getByTestId('subtask-t'))
    await within(middle()).findByTestId('activity')
    fireEvent.click(screen.getByTestId('subtask-d1'))
    await within(middle()).findByTestId('delivery')
  })
})

describe('subtarefas bloqueadas e canceladas', () => {
  it('ficam num grupo recolhido que abre ao clicar', async () => {
    api = new FakeApi(mockupData())
    api.data.subtasks = api.data.subtasks.map((s) =>
      s.id === 't' ? { ...s, state: 'failed', failureCode: 'session_lost' } : s,
    )
    const store = new AppStore(api)
    render(<App store={store} />)
    await screen.findByTestId('task-t1')
    const head = await screen.findByRole('button', { name: /Bloqueadas e canceladas/ })
    expect(screen.queryByTestId('subtask-t')).toBeNull()
    expect(screen.getByTestId('subtask-d1')).toBeTruthy()
    fireEvent.click(head)
    expect(screen.getByTestId('subtask-t')).toBeTruthy()
  })
})

describe('filtros da lista de tarefas', () => {
  function list() {
    return screen.getByRole('region', { name: 'Tarefas' })
  }
  function groupLabels() {
    return within(within(list()).getByRole('tree'))
      .queryAllByRole('group')
      .map((g) => g.getAttribute('aria-label'))
  }
  function openFilters() {
    fireEvent.click(within(list()).getByRole('button', { name: /^Filtros/ }))
    return screen.getByRole('dialog', { name: 'Filtros de tarefas' })
  }

  it('atalho "Abertas" esconde Concluída, mostra chip e badge; Esc fecha', async () => {
    await renderApp()
    expect(screen.queryByTestId('filter-count')).toBeNull()
    const pop = openFilters()
    fireEvent.click(within(pop).getByRole('button', { name: 'Abertas' }))
    expect(groupLabels()).toEqual(['A fazer', 'Em andamento'])
    expect(screen.getByTestId('chip-status').textContent).toContain('Sem Concluída')
    expect(screen.getByTestId('filter-count').textContent).toBe('1')
    expect(within(pop).getByRole('button', { name: 'Abertas' }).getAttribute('aria-pressed')).toBe(
      'true',
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Filtros de tarefas' })).toBeNull()

    // Clique fora tambem fecha.
    openFilters()
    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('dialog', { name: 'Filtros de tarefas' })).toBeNull()
  })

  it('checkbox de tipo filtra e o × do chip remove o filtro', async () => {
    await renderApp()
    const pop = openFilters()
    fireEvent.click(within(pop).getByLabelText('Avulso'))
    expect(screen.queryByTestId('task-t1')).toBeNull()
    expect(screen.getByTestId('task-solo1')).toBeTruthy()
    expect(screen.getByTestId('chip-kind').textContent).toContain('Avulso')

    fireEvent.click(within(pop).getByLabelText('Só com agente rodando'))
    // solo1 nao tem membro rodando: nada sobra.
    expect(screen.getByTestId('filter-empty').textContent).toContain(
      'Nenhuma tarefa com esses filtros.',
    )
    expect(screen.getByTestId('filter-count').textContent).toBe('2')

    fireEvent.click(screen.getByRole('button', { name: 'Remover filtro Avulso' }))
    expect(screen.queryByTestId('chip-kind')).toBeNull()
    // So t1 tem subtarefa working.
    expect(screen.getByTestId('task-t1')).toBeTruthy()
    expect(screen.queryByTestId('task-solo1')).toBeNull()
  })

  it('status marcado no popover: só ele aparece', async () => {
    await renderApp()
    const pop = openFilters()
    fireEvent.click(within(pop).getByLabelText('A fazer'))
    expect(groupLabels()).toEqual(['A fazer'])
    expect(within(pop).getAllByRole('checkbox')).toHaveLength(10)
    fireEvent.click(within(pop).getByRole('button', { name: 'Limpar filtros' }))
    expect(groupLabels()).toEqual(['A fazer', 'Em andamento', 'Concluída'])
  })

  it('busca filtra enquanto digita e Esc limpa', async () => {
    await renderApp()
    const search = screen.getByLabelText('Buscar tarefa por título')
    fireEvent.change(search, { target: { value: 'CONVERSA' } })
    expect(screen.getByTestId('task-solo1')).toBeTruthy()
    expect(screen.queryByTestId('task-t1')).toBeNull()
    fireEvent.keyDown(search, { key: 'Escape' })
    expect((search as HTMLInputElement).value).toBe('')
    expect(screen.getByTestId('task-t1')).toBeTruthy()
  })

  it('estado vazio limpa filtros e busca; seleção continua', async () => {
    const { store } = await renderApp()
    expect(store.getState().selectedTaskId).toBe('t1')
    fireEvent.change(screen.getByLabelText('Buscar tarefa por título'), {
      target: { value: 'zzz' },
    })
    const empty = screen.getByTestId('filter-empty')
    expect(empty.textContent).toContain('Nenhuma tarefa com esses filtros.')
    // A tarefa selecionada some da lista mas continua aberta (centro e subtarefas).
    expect(screen.queryByTestId('task-t1')).toBeNull()
    expect(store.getState().selectedTaskId).toBe('t1')
    expect(screen.getByTestId('subtask-d1')).toBeTruthy()
    fireEvent.click(within(empty).getByRole('button', { name: 'Limpar filtros' }))
    expect(screen.getByTestId('task-t1').getAttribute('aria-selected')).toBe('true')
    expect((screen.getByLabelText('Buscar tarefa por título') as HTMLInputElement).value).toBe('')
  })

  it('filtros ficam salvos por projeto', async () => {
    const data = mockupData()
    data.projects.push({ ...data.projects[0]!, id: 'p2', name: 'outro' })
    data.tasks.push(
      makeTask('old2', 'outro antigo', {
        projectId: 'p2',
        status: 'archived',
        workflowStatus: 'lancado',
        archivedAt: 1,
      }),
    )
    const { store, view } = await renderApp(data)
    fireEvent.click(within(openFilters()).getByRole('button', { name: 'Abertas' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(
      JSON.parse(localStorage.getItem('eclipse.taskFilters.p1') ?? '{}').statuses,
    ).toHaveLength(5)

    await act(() => store.openProject('p2'))
    expect(screen.queryByTestId('chip-status')).toBeNull()
    expect(groupLabels()).toContain('Concluída')

    await act(() => store.openProject('p1'))
    expect(screen.getByTestId('chip-status')).toBeTruthy()
    expect(groupLabels()).not.toContain('Concluída')

    view.unmount()
    await renderApp(data)
    expect(screen.getByTestId('chip-status').textContent).toContain('Sem Concluída')
  })

  it('STATUS conta tudo e clicar num status escondido inclui ele no filtro', async () => {
    await renderApp()
    fireEvent.click(within(openFilters()).getByRole('button', { name: 'Abertas' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.getByTestId('status-row-lancado').textContent).toBe('Concluída1')
    expect(screen.queryByTestId('group-lancado')).toBeNull()

    fireEvent.click(screen.getByTestId('status-row-lancado'))
    const group = screen.getByTestId('group-lancado')
    expect(group.getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement).toBe(group)
    // Abertas + Concluída = todos: o filtro de status sai.
    expect(screen.queryByTestId('chip-status')).toBeNull()
  })

  it('sem localStorage os filtros funcionam igual', async () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('bloqueado')
    })
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('bloqueado')
    })
    try {
      await renderApp()
      fireEvent.click(within(openFilters()).getByRole('button', { name: 'Abertas' }))
      expect(groupLabels()).toEqual(['A fazer', 'Em andamento'])
    } finally {
      get.mockRestore()
      set.mockRestore()
    }
  })
})

describe('subtarefas encerradas na lista', () => {
  it('ficam numa linha "N encerradas" que abre; o filtro mostra todas', async () => {
    await renderApp()
    // d1 está pronta no mockup: recolhida; t (trabalhando) aparece.
    const list = screen.getByRole('region', { name: 'Tarefas' })
    expect(within(list).queryByText(/Cobrir by_offer/)).toBeTruthy()
    const toggle = within(list).getByRole('button', { name: /1 encerrada$/ })
    expect(within(list).queryByText(/group_by=offer em report.ts/)).toBeNull()
    fireEvent.click(toggle)
    expect(within(list).getByRole('button', { name: 'esconder encerradas' })).toBeTruthy()
  })
})

describe('trocar o status da tarefa', () => {
  it('pela pílula no cabeçalho do meio', async () => {
    await renderApp()
    const pill = within(screen.getByTestId('mid-status')).getByRole('button')
    fireEvent.click(pill)
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Em revisão' }))
    await waitFor(() => expect(api.callsTo('tasks.setStatus')).toHaveLength(1))
  })

  it('pelo clique direito na linha da tarefa', async () => {
    await renderApp()
    const row = screen.getByTestId('task-t1')
    fireEvent.contextMenu(row, { clientX: 40, clientY: 80 })
    const menu = await screen.findByRole('menu')
    fireEvent.click(within(menu).getByRole('menuitemradio', { name: 'Pronto pra lançar' }))
    await waitFor(() =>
      expect(api.callsTo('tasks.setStatus')).toEqual([
        expect.objectContaining({ taskId: 't1', status: 'pronto_lancar' }),
      ]),
    )
  })
})

describe('trocar o status da tarefa', () => {
  it('pela pílula no cabeçalho do meio', async () => {
    await renderApp()
    const pill = within(screen.getByTestId('mid-status')).getByRole('button')
    fireEvent.click(pill)
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Em revisão' }))
    await waitFor(() => expect(api.callsTo('tasks.setStatus')).toHaveLength(1))
  })

  it('pelo clique direito na linha da tarefa', async () => {
    await renderApp()
    fireEvent.contextMenu(screen.getByTestId('task-t1'), { clientX: 40, clientY: 80 })
    const menu = await screen.findByRole('menu')
    fireEvent.click(within(menu).getByRole('menuitemradio', { name: 'Pronto pra lançar' }))
    await waitFor(() =>
      expect(api.callsTo('tasks.setStatus')).toEqual([
        expect.objectContaining({ taskId: 't1', status: 'pronto_lancar' }),
      ]),
    )
  })
})

describe('opção sugerida', () => {
  it('vem marcada e Ctrl+Enter confirma', async () => {
    api = new FakeApi(mockupData())
    const base = api.data.questions[0]!
    api.data.questions = [
      {
        ...base,
        id: 'q-sug',
        subtaskId: null,
        items: [
          {
            ...base.items[0]!,
            options: [
              { id: 'a', label: 'A + B (Recomendado)', description: 'Todo aviso com ação.' },
              { id: 'b', label: 'Só A' },
            ],
          },
        ],
      },
    ]
    const store = new AppStore(api)
    render(<App store={store} />)
    await screen.findByTestId('task-t1')
    fireEvent.click(screen.getByTestId('need-you'))
    const card = await screen.findByTestId('leader-question')
    expect(within(card).getByText('A + B').closest('button')?.getAttribute('aria-pressed')).toBe(
      'true',
    )
    expect(within(card).getByText('sugerida')).toBeTruthy()
    expect(within(card).getByText('Todo aviso com ação.')).toBeTruthy()
    fireEvent.keyDown(within(card).getByText('Só A').closest('button')!, {
      key: 'Enter',
      ctrlKey: true,
    })
    await waitFor(() =>
      expect(api.callsTo('questions.answer')).toEqual([
        expect.objectContaining({
          answers: [expect.objectContaining({ itemId: base.items[0]!.id, optionIds: ['a'] })],
        }),
      ]),
    )
  })
})

describe('design C: topo, lista e subtarefas', () => {
  it('seletor de projeto mostra a branch da tarefa aberta', async () => {
    await renderApp()
    const btn = () => screen.getByRole('button', { name: /^Projeto: / })
    expect(btn().textContent).toContain('Ctrl O')
    fireEvent.click(screen.getByTestId('task-t1'))
    expect(btn().textContent).toContain('ereemby')
    expect(btn().textContent).toContain('/t1')
    // tarefa sem branch (avulso sem worktree): so o projeto
    fireEvent.click(screen.getByTestId('task-solo1'))
    expect(btn().textContent).not.toContain('/')
  })

  it('linha de tarefa não mostra papel nem modelo; eles vão para o tooltip', async () => {
    await renderApp()
    const row = screen.getByTestId('task-t1')
    expect(row.textContent).not.toContain('opus')
    expect(row.textContent).not.toContain('Líder')
    expect(row.querySelector('.m')?.getAttribute('title')).toBe('Líder · opus')
    expect(row.querySelector('.m')?.textContent).toMatch(/^(agora|\d+[mhd])$/)
  })

  it('barra segmentada tem um segmento por subtarefa e a linha de resumo', async () => {
    await renderApp()
    const bar = screen.getByTestId('subtask-bar')
    expect([...bar.children].map((c) => c.getAttribute('data-state'))).toEqual([
      'completed',
      'input_required',
      'working',
    ])
    expect(screen.getByTestId('subtask-summary').textContent).toMatch(
      /^1 pronta · 1 trabalhando · 1 dúvida · /,
    )
  })

  it('chips rápidos filtram por status', async () => {
    await renderApp()
    const list = screen.getByRole('region', { name: 'Tarefas' })
    fireEvent.click(within(list).getByRole('button', { name: 'Pergunta' }))
    expect(screen.queryByTestId('task-t1')).toBeNull()
    fireEvent.click(within(list).getByRole('button', { name: 'Pergunta' }))
    expect(screen.getByTestId('task-t1')).toBeTruthy()
  })
})
