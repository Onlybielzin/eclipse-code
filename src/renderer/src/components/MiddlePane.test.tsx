// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { App } from '../App'
import { AppStore } from '../store/appStore'
import { FakeApi, mockupData } from '../test/fakeApi'

afterEach(cleanup)

// jsdom nao tem canvas/WebGL: o xterm do Lider vira um <pre>.
vi.mock('../terminal/createXterm', () => ({
  createXterm: (container: HTMLElement) => {
    const pre = document.createElement('pre')
    container.appendChild(pre)
    return {
      write: () => undefined,
      onData: () => () => undefined,
      fit: () => ({ cols: 100, rows: 30 }),
      focus: () => undefined,
      dispose: () => pre.remove(),
    }
  },
}))

describe('Tarefa em espera no meio', () => {
  it('não abre o Líder ao selecionar; o Retomar chama leader.ensure', async () => {
    const data = mockupData()
    data.tasks = data.tasks.map((t) => (t.id === 't1' ? { ...t, workflowStatus: 'em_espera' } : t))
    const api = new FakeApi(data)
    const store = new AppStore(api)
    render(<App store={store} />)
    fireEvent.click(await screen.findByTestId('task-t1'))

    await screen.findByText('Tarefa em espera. Os agentes estão fechados.')
    expect(api.callsTo('leader.ensure')).toHaveLength(0)
    expect(screen.queryByTestId('leader-terminal')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Retomar' }))
    await waitFor(() => expect(api.callsTo('leader.ensure')).toHaveLength(1))
    expect(screen.queryByText('Tarefa em espera. Os agentes estão fechados.')).toBeNull()
  })
})

describe('Tarefa esperando outra no meio', () => {
  function open(otherStatus: 'em_andamento' | 'cancelado') {
    const data = mockupData()
    data.tasks = data.tasks.map((t) =>
      t.id === 't1'
        ? { ...t, workflowStatus: 'esperando_outra', waitForTaskId: 'solo1' }
        : t.id === 'solo1'
          ? { ...t, workflowStatus: otherStatus }
          : t,
    )
    const api = new FakeApi(data)
    render(<App store={new AppStore(api)} />)
    return api
  }

  it('mostra a linha de espera no lugar do terminal e Iniciar agora manda para A fazer', async () => {
    const api = open('em_andamento')
    fireEvent.click(await screen.findByTestId('task-t1'))
    const line = await screen.findByText(/^Esperando: .* \(Em andamento\)$/)
    expect(line).toBeTruthy()
    expect(screen.queryByTestId('leader-terminal')).toBeNull()
    expect(api.callsTo('leader.ensure')).toHaveLength(0)

    fireEvent.click(screen.getByRole('button', { name: 'Iniciar agora' }))
    await waitFor(() =>
      expect(api.callsTo('tasks.setStatus')).toEqual([{ taskId: 't1', status: 'a_fazer' }]),
    )
    await waitFor(() => expect(api.callsTo('leader.ensure')).toHaveLength(1))
    expect(screen.queryByTestId('task-waiting')).toBeNull()
  })

  it('A cancelada: a linha pede para iniciar ou cancelar', async () => {
    open('cancelado')
    fireEvent.click(await screen.findByTestId('task-t1'))
    expect(
      await screen.findByText(/foi cancelada\. Inicie esta tarefa ou cancele\.$/),
    ).toBeTruthy()
  })

  it('o menu de status da tarefa não oferece Esperando outra', async () => {
    open('em_andamento')
    fireEvent.click(await screen.findByTestId('task-t1'))
    await screen.findByTestId('task-waiting')
    fireEvent.click(screen.getByTestId('mid-status').querySelector('button') as HTMLElement)
    const options = screen.getAllByRole('menuitemradio').map((o) => o.textContent)
    expect(options).toContain('Lançada')
    expect(options).not.toContain('Esperando outra')
  })
})
