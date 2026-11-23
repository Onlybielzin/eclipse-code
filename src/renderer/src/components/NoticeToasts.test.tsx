// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UserNotice } from '@shared/ipc'
import { AppStore } from '../store/appStore'
import { StoreProvider } from '../store/context'
import { FakeApi, mockupData } from '../test/fakeApi'
import { NoticeToasts, NOTICE_TIMEOUT_MS } from './NoticeToasts'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function notice(id: string, extra: Partial<UserNotice> = {}): UserNotice {
  return {
    id,
    taskId: 't1',
    taskName: 'Login',
    projectId: 'p1',
    projectName: 'ereemby',
    text: `texto ${id}`,
    createdAt: 1,
    ...extra,
  }
}

async function setup() {
  const api = new FakeApi(mockupData())
  const store = new AppStore(api)
  await store.start()
  render(
    <StoreProvider store={store}>
      <NoticeToasts />
    </StoreProvider>,
  )
  vi.useFakeTimers()
  const send = (n: UserNotice) => act(() => api.emit('notice.created', n))
  return { api, store, send }
}

describe('NoticeToasts', () => {
  it('mostra projeto, tarefa e texto, e some sozinho em 8 s', async () => {
    const { send } = await setup()
    send(notice('a'))
    expect(screen.getByText('ereemby')).toBeTruthy()
    expect(screen.getByText('Login')).toBeTruthy()
    expect(screen.getByText('texto a')).toBeTruthy()
    act(() => void vi.advanceTimersByTime(NOTICE_TIMEOUT_MS - 1))
    expect(screen.queryByText('texto a')).toBeTruthy()
    act(() => void vi.advanceTimersByTime(1))
    expect(screen.queryByText('texto a')).toBeNull()
  })

  it('o mouse em cima segura o aviso', async () => {
    const { send } = await setup()
    send(notice('a'))
    const toast = screen.getByTestId('notice-a')
    fireEvent.mouseEnter(toast)
    act(() => void vi.advanceTimersByTime(NOTICE_TIMEOUT_MS * 3))
    expect(screen.queryByText('texto a')).toBeTruthy()
    fireEvent.mouseLeave(toast)
    act(() => void vi.advanceTimersByTime(NOTICE_TIMEOUT_MS))
    expect(screen.queryByText('texto a')).toBeNull()
  })

  it('o foco dentro do toast segura o aviso; sair do foco recomeça a contagem', async () => {
    const { send } = await setup()
    send(notice('a'))
    const [open, close] = [
      screen.getByText('texto a').closest('button')!,
      screen.getByRole('button', { name: 'Fechar aviso' }),
    ]
    act(() => open.focus())
    act(() => void vi.advanceTimersByTime(NOTICE_TIMEOUT_MS * 3))
    expect(screen.queryByText('texto a')).toBeTruthy()
    // Mover o foco entre elementos do mesmo toast não solta.
    act(() => close.focus())
    act(() => void vi.advanceTimersByTime(NOTICE_TIMEOUT_MS * 3))
    expect(screen.queryByText('texto a')).toBeTruthy()
    act(() => close.blur())
    act(() => void vi.advanceTimersByTime(NOTICE_TIMEOUT_MS - 1))
    expect(screen.queryByText('texto a')).toBeTruthy()
    act(() => void vi.advanceTimersByTime(1))
    expect(screen.queryByText('texto a')).toBeNull()
  })

  it('Fechar aviso remove só aquele', async () => {
    const { send } = await setup()
    send(notice('a'))
    send(notice('b'))
    fireEvent.click(screen.getAllByRole('button', { name: 'Fechar aviso' })[0]!)
    expect(screen.queryByText('texto a')).toBeNull()
    expect(screen.queryByText('texto b')).toBeTruthy()
  })

  it('no máximo 3 na tela: o mais antigo sai', async () => {
    const { send } = await setup()
    for (const id of ['a', 'b', 'c', 'd']) send(notice(id))
    expect(screen.queryByText('texto a')).toBeNull()
    expect(screen.getAllByRole('status')).toHaveLength(3)
  })

  it('clicar abre a tarefa do aviso e fecha o toast', async () => {
    const { send, store } = await setup()
    expect(store.getState().selectedTaskId).not.toBe('solo1')
    send(notice('a', { taskId: 'solo1', taskName: 'conversa solta' }))
    await act(async () => {
      fireEvent.click(screen.getByText('texto a'))
    })
    expect(store.getState().selectedTaskId).toBe('solo1')
    expect(screen.queryByText('texto a')).toBeNull()
  })

  it('clique na notificação do sistema (notice.open) abre a tarefa', async () => {
    const { api, store } = await setup()
    await act(async () => {
      api.emit('notice.open', { taskId: 'solo1', projectId: 'p1' })
    })
    expect(store.getState().selectedTaskId).toBe('solo1')
  })
})
