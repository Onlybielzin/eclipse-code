// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from './App'
import { AppStore } from './store/appStore'
import { FakeApi, makeActivity, makeSubtask, mockupData, type FakeData } from './test/fakeApi'

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
  await screen.findByText('feat-orfer-e-up')
  return { store, view }
}

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
    expect(within(list).getByTestId('task-solo1').textContent).toContain('avulso')
    expect(screen.getByTestId('need-you').textContent).toBe('1 precisa de você')

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
    fireEvent.click(screen.getByText('feat-orfer-e-up'))
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

  it('responde a dúvida repassada pelo Líder com um clique', async () => {
    await renderApp()
    fireEvent.click(screen.getByTestId('need-you'))
    const question = await within(middle()).findByTestId('question')
    fireEvent.click(within(question).getByText('Sem origem'))
    await waitFor(() =>
      expect(api.callsTo('questions.answer')).toEqual([
        { questionId: 'q1', answers: [{ itemId: 'i1', optionIds: ['o2'], text: null }] },
      ]),
    )
    await waitFor(() =>
      expect(screen.getByTestId('need-you').textContent).toBe('0 precisam de você'),
    )
  })

  it('cria tarefa pelo nome e abre o terminal dela', async () => {
    await renderApp()
    fireEvent.click(screen.getByText('+ nova'))
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
    fireEvent.click(screen.getByText('+ nova'))
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

  it('agrupa na ordem dos status, com contador, sem grupo vazio e Lançado recolhido', async () => {
    await renderApp()
    expect(groupLabels()).toEqual(['A fazer', 'Em andamento', 'Lançado'])
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
      'Lançado',
    ])
    expect(options[1]?.getAttribute('aria-checked')).toBe('true')
    // Abrir o menu nao seleciona a tarefa nem muda nada.
    expect(api.callsTo('tasks.setStatus')).toEqual([])

    fireEvent.click(within(menu).getByText('Em revisão'))
    expect(screen.queryByRole('menu')).toBeNull()
    await waitFor(() =>
      expect(api.callsTo('tasks.setStatus')).toEqual([{ taskId: 't1', status: 'em_revisao' }]),
    )
    await waitFor(() => expect(groupLabels()).toEqual(['A fazer', 'Em revisão', 'Lançado']))
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

  it('marcar Lançado arquiva e o centro mostra a tarefa lançada', async () => {
    await renderApp()
    fireEvent.click(
      within(screen.getByTestId('task-t1')).getByRole('button', { name: /Status de/ }),
    )
    fireEvent.click(within(screen.getByRole('menu')).getByText('Lançado'))
    await waitFor(() => expect(within(middle()).getByTestId('task-launched')).toBeTruthy())
    expect(groupLabels()).toEqual(['A fazer', 'Lançado'])
    expect(within(screen.getByTestId('group-lancado')).getByText('2')).toBeTruthy()
  })
})

describe('modal Adicionar projeto', () => {
  it('abre o explorador, mostra a pasta e adiciona com o nome editado', async () => {
    await renderApp()
    fireEvent.click(screen.getByRole('button', { name: '+ projeto' }))
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
    fireEvent.click(screen.getByRole('button', { name: '+ projeto' }))
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
    expect(screen.getByTestId('need-you').textContent).toBe('1 precisa de você')
    const q1 = api.data.questions[0]!
    act(() =>
      api.emitDomain({
        type: 'question.upserted',
        question: { ...q1, status: 'superseded', answeredAt: Date.now() },
      }),
    )
    expect(screen.getByTestId('need-you').textContent).toBe('0 precisam de você')
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
    expect(screen.getByTestId('need-you').textContent).toBe('0 precisam de você')
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
      'Lançado1',
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

  it('clicar em Lançado expande o grupo recolhido e foca o cabeçalho dele', async () => {
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
    await screen.findByText('feat-orfer-e-up')

    fireEvent.click(screen.getByTestId('need-you'))
    const card = await screen.findByTestId('leader-question')
    expect(within(card).getByText('Quem manda e-mail no chat?')).toBeTruthy()
    expect(within(middle()).getByTestId('leader-terminal')).toBeTruthy()
  })
})
