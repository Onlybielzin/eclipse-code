// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from './App'
import { AppStore } from './store/appStore'
import { FakeApi, mockupData } from './test/fakeApi'

// jsdom nao tem canvas/WebGL: o xterm vira um <pre>.
vi.mock('./terminal/createXterm', () => ({
  createXterm: (container: HTMLElement) => {
    const pre = document.createElement('pre')
    container.appendChild(pre)
    return {
      write: (data: string) => {
        pre.textContent = (pre.textContent ?? '') + data
      },
      onData: () => () => undefined,
      fit: () => ({ cols: 100, rows: 30 }),
      resize: () => undefined,
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
  await screen.findByTestId('task-t1')
  return store
}

function setPhone(matches: boolean) {
  window.matchMedia = ((query: string) => ({
    matches,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia
}

beforeEach(() => {
  window.history.replaceState(null, '')
})
afterEach(() => {
  cleanup()
  delete window.eclipseRemote
  // @ts-expect-error limpa o mock de matchMedia
  delete window.matchMedia
})

describe('modo remoto', () => {
  beforeEach(() => {
    window.eclipseRemote = true
  })

  it('a barra de digitar escreve o texto e depois Enter', async () => {
    await renderApp()
    fireEvent.click(screen.getByTestId('task-t1'))
    const field = await screen.findByLabelText('Texto para o terminal')
    await waitFor(() => expect(api.callsTo('terminal.resize')).toHaveLength(0))
    fireEvent.change(field, { target: { value: 'oi líder' } })
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }))
    await waitFor(() => expect(api.callsTo('terminal.write')).toHaveLength(2))
    expect(api.callsTo('terminal.write')).toEqual([
      { sessionId: 'lead-t1', data: 'oi líder' },
      { sessionId: 'lead-t1', data: '\r' },
    ])
    expect((field as HTMLInputElement).value).toBe('')
  })

  it('Ctrl+C só envia depois de confirmar', async () => {
    await renderApp()
    fireEvent.click(screen.getByTestId('task-t1'))
    await screen.findByLabelText('Texto para o terminal')
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false)
    fireEvent.click(screen.getByRole('button', { name: 'Ctrl+C' }))
    expect(api.callsTo('terminal.write')).toHaveLength(0)
    confirm.mockReturnValueOnce(true)
    fireEvent.click(screen.getByRole('button', { name: 'Ctrl+C' }))
    await waitFor(() =>
      expect(api.callsTo('terminal.write')).toEqual([{ sessionId: 'lead-t1', data: '\x03' }]),
    )
    confirm.mockRestore()
  })

  it('teclas extras mandam Esc, setas e Enter', async () => {
    await renderApp()
    fireEvent.click(screen.getByTestId('task-t1'))
    await screen.findByLabelText('Texto para o terminal')
    for (const name of ['Esc', 'Subir', 'Descer', 'Enter'])
      fireEvent.click(screen.getByRole('button', { name }))
    await waitFor(() => expect(api.callsTo('terminal.write')).toHaveLength(4))
    expect(api.callsTo('terminal.write').map((c) => (c as { data: string }).data)).toEqual([
      '\x1b',
      '\x1b[A',
      '\x1b[B',
      '\r',
    ])
  })

  it('nunca manda terminal.resize', async () => {
    await renderApp()
    fireEvent.click(screen.getByTestId('task-t1'))
    await screen.findByLabelText('Texto para o terminal')
    await act(async () => {})
    expect(api.callsTo('terminal.resize')).toHaveLength(0)
  })

  it('esconde projeto, Configurações e atualização', async () => {
    await renderApp()
    expect(screen.queryByRole('button', { name: 'Configurações' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /^Projeto: / }))
    const picker = screen.getByRole('dialog', { name: 'Trocar projeto' })
    expect(within(picker).queryByRole('button', { name: '+ Adicionar projeto' })).toBeNull()
    expect(within(picker).queryByRole('button', { name: /Editar projeto/ })).toBeNull()
    expect(within(picker).queryByTitle('Editar projeto')).toBeNull()
  })
})

describe('desktop', () => {
  it('sem remoto e sem celular não mostra a barra de digitar nem a navegação', async () => {
    await renderApp()
    fireEvent.click(screen.getByTestId('task-t1'))
    await screen.findByTestId('leader-terminal')
    expect(screen.queryByLabelText('Texto para o terminal')).toBeNull()
    expect(screen.queryByRole('navigation', { name: 'Colunas' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Configurações' })).toBeTruthy()
  })
})

describe('layout de celular', () => {
  beforeEach(() => setPhone(true))

  const cols = () => document.querySelector('.cols') as HTMLElement

  it('mostra uma coluna por vez e troca pela barra de abas', async () => {
    await renderApp()
    expect(cols().dataset.col).toBe('tasks')
    const nav = screen.getByRole('navigation', { name: 'Colunas' })
    fireEvent.click(screen.getByTestId('task-t1'))
    expect(cols().dataset.col).toBe('middle')
    fireEvent.click(within(nav).getByRole('button', { name: 'Subtarefas' }))
    expect(cols().dataset.col).toBe('subtasks')
    fireEvent.click(within(nav).getByRole('button', { name: 'Tarefas' }))
    expect(cols().dataset.col).toBe('tasks')
  })

  it('o botão voltar do navegador volta da tarefa para a lista', async () => {
    await renderApp()
    fireEvent.click(screen.getByTestId('task-t1'))
    expect(cols().dataset.col).toBe('middle')
    expect(window.history.state).toEqual({ eclipseCol: true })
    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate', { state: null }))
    })
    expect(cols().dataset.col).toBe('tasks')
  })
})
