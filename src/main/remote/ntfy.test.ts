import { describe, expect, it, vi } from 'vitest'
import type { IpcEventMessage } from '@shared/ipc'
import type { UserQuestion } from '@shared/domain'
import { createNtfy } from './ntfy'
import type { RemoteSettings } from './remoteSettings'

const base: RemoteSettings = {
  enabled: false,
  port: 47821,
  token: 'token-de-teste-com-mais-de-20-letras',
  ntfyEnabled: true,
  ntfyServer: 'https://ntfy.exemplo.dev/',
  ntfyTopic: 'eclipse-abc',
  ntfyToken: null,
  publicUrl: 'https://pc.tail.ts.net/',
}

const question = (over: Partial<UserQuestion> = {}): IpcEventMessage => ({
  channel: 'domain.event',
  payload: {
    revision: 1,
    at: 1,
    event: {
      type: 'question.upserted',
      question: {
        id: 'q1',
        taskId: 't1',
        subtaskId: null,
        items: [
          { id: 'i', prompt: 'Qual banco?', options: [], multiSelect: false, allowFreeText: true },
        ],
        status: 'open',
        answers: null,
        createdAt: 1,
        answeredAt: null,
        ...over,
      },
    },
  },
})
const notice = (text: string): IpcEventMessage => ({
  channel: 'notice.created',
  payload: {
    id: 'n',
    taskId: 't1',
    taskName: 'Tarefa',
    projectId: 'p',
    projectName: 'Proj',
    text,
    createdAt: 1,
  },
})

function setup(settings: Partial<RemoteSettings> = {}, fetchImpl?: typeof fetch) {
  const fetchMock = vi.fn(fetchImpl ?? (async () => new Response('{}', { status: 200 })))
  const warn = vi.fn()
  const ntfy = createNtfy({
    getSettings: () => ({ ...base, ...settings }),
    fetch: fetchMock as unknown as typeof fetch,
    lookup: () => ({ taskName: 'Tarefa', projectName: 'Proj' }),
    log: { info: vi.fn(), warn, error: vi.fn() },
  })
  const body = (i = 0) => JSON.parse((fetchMock.mock.calls[i]![1] as RequestInit).body as string)
  return { ntfy, fetchMock, warn, body }
}

describe('aviso por ntfy', () => {
  it('pergunta aberta nova manda 1 POST com prioridade 4 e a mesma pergunta atualizada não repete', async () => {
    const { ntfy, fetchMock, body } = setup()
    await ntfy.handle(question())
    await ntfy.handle(question({ createdAt: 2 }))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]![0]).toBe('https://ntfy.exemplo.dev')
    expect(body()).toMatchObject({
      topic: 'eclipse-abc',
      title: 'Proj: Tarefa',
      message: 'Qual banco?',
      click: 'https://pc.tail.ts.net/',
      priority: 4,
    })
  })

  it('pergunta respondida não manda', async () => {
    const { ntfy, fetchMock } = setup()
    await ntfy.handle(question({ status: 'answered' }))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('notice.created manda com prioridade 3, corta o texto e omite click sem publicUrl', async () => {
    const { ntfy, body } = setup({ publicUrl: null })
    await ntfy.handle(notice('x'.repeat(500)))
    expect(body().priority).toBe(3)
    expect(body().message.length).toBeLessThanOrEqual(300)
    expect(body()).not.toHaveProperty('click')
  })

  it('desligado não manda nada', async () => {
    const { ntfy, fetchMock } = setup({ ntfyEnabled: false })
    await ntfy.handle(notice('oi'))
    await ntfy.handle(question())
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('erro do fetch só loga e não repete', async () => {
    const { ntfy, fetchMock, warn } = setup({}, async () => {
      throw new Error('rede caiu')
    })
    await expect(ntfy.handle(notice('oi'))).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalled()
  })

  it('status HTTP de erro também só loga', async () => {
    const { ntfy, warn } = setup({}, async () => new Response('no', { status: 403 }))
    await ntfy.handle(notice('oi'))
    expect(warn).toHaveBeenCalled()
  })

  it('Authorization só quando há token', async () => {
    const a = setup()
    await a.ntfy.handle(notice('oi'))
    expect((a.fetchMock.mock.calls[0]![1] as RequestInit).headers).not.toHaveProperty(
      'Authorization',
    )
    const b = setup({ ntfyToken: 'tk_123' })
    await b.ntfy.handle(notice('oi'))
    expect((b.fetchMock.mock.calls[0]![1] as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer tk_123',
    })
  })

  it('aviso de teste manda e propaga o erro legível', async () => {
    const ok = setup({ ntfyEnabled: false })
    await ok.ntfy.test()
    expect(ok.fetchMock).toHaveBeenCalledTimes(1)
    const bad = setup({}, async () => new Response('no', { status: 403 }))
    await expect(bad.ntfy.test()).rejects.toThrow(/403/)
  })
})
