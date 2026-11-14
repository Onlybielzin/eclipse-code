// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WallSnapshot, WallTask } from '@shared/wall'
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

const task = (id: string, extra: Partial<WallTask> = {}): WallTask => ({
  id, projectId: 'p1', projectName: 'ereemby', title: `Tarefa ${id}`, workflowStatus: 'em_andamento',
  branch: id, updatedAt: 1, members: [{ subtaskId: 's', role: 'Dev', title: 'x', state: 'working' }],
  linesAdded: 1234, linesRemoved: 5, lastFile: 'src/a.ts', lastLines: ['+const a = 1', '-const b = 2'],
  openQuestions: 0, ...extra,
})
const snapshot: WallSnapshot = {
  at: 1, tasks: [task('a'), task('b', { openQuestions: 1 })], workingAgents: 2, maxLiveAgents: 12,
  doneToday: 7, inReview: 1, openQuestions: 1,
}

async function setup() {
  const api = new FakeApi(mockupData())
  api.wallSnapshot = snapshot
  const store = new AppStore(api)
  render(<App store={store} />)
  await screen.findByTestId('task-t1')
  return { api, store }
}

describe('Parede', () => {
  it('o botão abre e fecha, Esc fecha e o seletor mostra Todos os projetos', async () => {
    const { api } = await setup()
    const btn = screen.getByRole('button', { name: 'Parede' })
    expect(btn.getAttribute('title')).toBe('Parede')
    expect(screen.queryByTestId('wall-view')).toBeNull()

    fireEvent.click(btn)
    await screen.findByTestId('wall-view')
    expect(screen.getByRole('button', { name: 'Projeto: Todos os projetos' })).toBeTruthy()
    await waitFor(() => expect(api.callsTo('wall.snapshot').length).toBeGreaterThan(0))

    fireEvent.click(btn)
    expect(screen.queryByTestId('wall-view')).toBeNull()
    expect(screen.queryByText('Todos os projetos')).toBeNull()

    fireEvent.click(btn)
    await screen.findByTestId('wall-view')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByTestId('wall-view')).toBeNull()

    fireEvent.click(btn)
    await screen.findByTestId('wall-view')
    fireEvent.click(screen.getByRole('button', { name: 'Fechar' }))
    expect(screen.queryByTestId('wall-view')).toBeNull()
  })

  it('renderiza o retrato: contador, números, cartões e a pergunta pulsando', async () => {
    const { store } = await setup()
    act(() => store.setWallOpen(true))
    await screen.findByText('Tarefa a')
    expect(screen.getByRole('img', { name: '2.468 linhas' })).toBeTruthy()
    expect(screen.getByText('limite do app: 12')).toBeTruthy()
    expect(screen.getByText('subtarefas prontas hoje').parentElement?.textContent).toContain('7')
    expect(screen.getByLabelText(/Tarefa b\. /).className).toContain('ask')
    expect(screen.getAllByText('+1.234').length).toBe(2)
  })

  it('Esc não fecha com modal aberto nem com o foco no terminal ou num campo', async () => {
    const { store } = await setup()
    act(() => store.setWallOpen(true))
    await screen.findByTestId('wall-view')

    const modal = document.body.appendChild(document.createElement('div'))
    modal.setAttribute('aria-modal', 'true')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByTestId('wall-view')).not.toBeNull()
    modal.remove()

    const term = document.body.appendChild(document.createElement('div'))
    term.className = 'xterm'
    const helper = term.appendChild(document.createElement('textarea'))
    fireEvent.keyDown(helper, { key: 'Escape' })
    expect(screen.queryByTestId('wall-view')).not.toBeNull()
    term.remove()

    act(() => store.setSettingsOpen(true))
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(screen.queryByTestId('wall-view')).not.toBeNull()
    act(() => store.setSettingsOpen(false))

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByTestId('wall-view')).toBeNull()
  })

  it('retrato lento não gera chamada em paralelo e fechar para o laço', async () => {
    const { store } = await setup()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      let running = 0
      let peak = 0
      let calls = 0
      vi.spyOn(store, 'loadWallSnapshot').mockImplementation(async () => {
        calls++
        running++
        peak = Math.max(peak, running)
        await new Promise((r) => setTimeout(r, 10_000)) // mais lento que o intervalo de 3 s
        running--
        return snapshot
      })
      act(() => store.setWallOpen(true))
      await act(() => vi.advanceTimersByTimeAsync(25_000))
      expect(peak).toBe(1)
      expect(calls).toBeGreaterThanOrEqual(2)

      act(() => store.setWallOpen(false))
      const before = calls
      await act(() => vi.advanceTimersByTimeAsync(60_000))
      expect(calls).toBe(before)
    } finally {
      vi.useRealTimers()
    }
  })

  it('avisa quantas tarefas ficaram fora da grade', async () => {
    const { api, store } = await setup()
    api.wallSnapshot = { ...snapshot, tasks: Array.from({ length: 12 }, (_, i) => task(`t${i}`)) }
    act(() => store.setWallOpen(true))
    expect((await screen.findByTestId('wall-hidden')).textContent).toBe('+2 tarefas fora da grade')
  })
})
