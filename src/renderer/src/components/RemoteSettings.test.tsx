// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EclipseApi } from '@shared/ipc'
import type { RemoteStatus } from '@shared/remote'
import { RemoteSettings } from './RemoteSettings'

afterEach(cleanup)

const base: RemoteStatus = {
  enabled: false,
  port: 47821,
  token: 'abc',
  pairUrlPath: '/pair?token=abc',
  running: false,
  error: null,
  ntfyEnabled: false,
  ntfyServer: 'https://ntfy.vings.dev',
  ntfyTopic: 'eclipse-abc',
  ntfyTokenSet: false,
  publicUrl: null,
}

function fakeApi(initial: RemoteStatus) {
  let current = initial
  const invoke = vi.fn(async (channel: string, input: unknown) => {
    if (channel === 'remote.save') current = { ...current, ...(input as object), running: true }
    if (channel === 'remote.rotateToken')
      current = { ...current, token: 'novo', pairUrlPath: '/pair?token=novo' }
    return { ok: true as const, value: current }
  })
  return { api: { invoke, on: vi.fn(), pathForFile: () => '' } as unknown as EclipseApi, invoke }
}

describe('RemoteSettings', () => {
  it('liga, salva e mostra o estado e o passo a passo com a porta real', async () => {
    const { api, invoke } = fakeApi(base)
    render(<RemoteSettings api={api} />)
    const toggle = await screen.findByRole('switch', { name: 'Ligar acesso pelo celular' })
    await waitFor(() => expect((toggle as HTMLInputElement).disabled).toBe(false))
    fireEvent.click(toggle)
    fireEvent.click(screen.getByRole('button', { name: 'Salvar celular' }))
    await screen.findByText('Ligado em 127.0.0.1:47821')
    expect(invoke).toHaveBeenCalledWith('remote.save', {
      enabled: true,
      port: 47821,
      ntfyEnabled: false,
      ntfyServer: 'https://ntfy.vings.dev',
      publicUrl: null,
    })
    expect(screen.getByText('tailscale serve --bg 47821')).toBeTruthy()
    expect(screen.getByText(/\/pair\?token=abc/)).toBeTruthy()
  })

  it('mostra o erro de porta ocupada e troca o token', async () => {
    const { api, invoke } = fakeApi({
      ...base,
      enabled: true,
      error: 'A porta 47821 já está em uso.',
    })
    render(<RemoteSettings api={api} />)
    await screen.findByText('A porta 47821 já está em uso.')
    fireEvent.click(screen.getByRole('button', { name: 'Trocar token' }))
    await screen.findByText(/token=novo/)
    expect(invoke).toHaveBeenCalledWith('remote.rotateToken', {})
  })

  it('mostra o tópico, salva o aviso com token e chama remote.testNotify', async () => {
    const { api, invoke } = fakeApi(base)
    render(<RemoteSettings api={api} />)
    await screen.findByText('eclipse-abc')
    expect(screen.getByText(/assine este tópico no servidor acima/)).toBeTruthy()
    fireEvent.click(screen.getByRole('switch', { name: 'Ligar aviso no celular' }))
    fireEvent.change(screen.getByLabelText('Token do ntfy'), { target: { value: 'tk_1' } })
    fireEvent.change(screen.getByLabelText('Endereço público'), {
      target: { value: 'https://pc.tail.ts.net' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Salvar celular' }))
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('remote.save', {
        enabled: false,
        port: 47821,
        ntfyEnabled: true,
        ntfyServer: 'https://ntfy.vings.dev',
        ntfyToken: 'tk_1',
        publicUrl: 'https://pc.tail.ts.net',
      }),
    )
    const test = screen.getByRole('button', { name: 'Mandar aviso de teste' })
    await waitFor(() => expect((test as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(test)
    await screen.findByText(/Aviso de teste enviado/)
    expect(invoke).toHaveBeenCalledWith('remote.testNotify', {})
  })
})
