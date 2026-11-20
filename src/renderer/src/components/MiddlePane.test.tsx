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
