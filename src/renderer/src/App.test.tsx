// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from './App'
import { AppStore } from './store/appStore'
import { FakeApi, makeActivity, makeSubtask, mockupData } from './test/fakeApi'

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

async function renderApp() {
  api = new FakeApi(mockupData())
  const store = new AppStore(api)
  render(<App store={store} />)
  await screen.findByText('feat-orfer-e-up')
  return store
}

function middle() {
  return screen.getByRole('region', { name: 'Centro' })
}

beforeEach(() => {
  xtermInputs.length = 0
})
afterEach(() => {
  vi.clearAllMocks()
})

describe('tela de 3 colunas', () => {
  it('mostra tarefas, Avulsos, subtarefas e o contador "precisa de você"', async () => {
    await renderApp()
    const list = screen.getByRole('region', { name: 'Tarefas' })
    expect(within(list).getByText('Em andamento')).toBeTruthy()
    expect(within(list).getByText('Avulsos')).toBeTruthy()
    expect(within(list).getByText('conversa solta')).toBeTruthy()
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
    await waitFor(() => expect(api.callsTo('leader.ensure')).toContainEqual({ taskId: 't-new-3' }))
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
