import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { IpcEventMessage } from '@shared/ipc'
import { createUpdater, createWhatsNew, type UpdaterLike } from './updater'

class FakeUpdater extends EventEmitter {
  autoDownload = false
  autoInstallOnAppQuit = false
  autoRunAppAfterInstall = true
  checkForUpdates = vi.fn(async () => null)
  quitAndInstall = vi.fn()
}

const silent = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

function setup(enabled = true) {
  const fake = new FakeUpdater()
  const events: IpcEventMessage[] = []
  const updater = createUpdater({
    autoUpdater: fake as unknown as UpdaterLike,
    enabled,
    emit: (m) => events.push(m),
    log: silent,
    version: '0.1.3',
  })
  return { fake, events, updater }
}

describe('createUpdater', () => {
  it('não liga quando não está empacotado', () => {
    const { fake, updater } = setup(false)
    updater.start()
    expect(fake.checkForUpdates).not.toHaveBeenCalled()
    expect(fake.autoDownload).toBe(false)
    expect(updater.state()).toEqual({ status: 'idle', version: null })
  })

  it('baixa sozinho, instala ao fechar e acompanha os eventos', () => {
    const { fake, events, updater } = setup()
    updater.start()
    expect(fake.autoDownload).toBe(true)
    expect(fake.autoInstallOnAppQuit).toBe(true)
    expect(fake.autoRunAppAfterInstall).toBe(false)
    expect(fake.checkForUpdates).toHaveBeenCalledTimes(1)
    fake.emit('update-available', { version: '0.2.0' })
    expect(updater.state()).toEqual({ status: 'downloading', version: '0.2.0' })
    fake.emit('update-downloaded', { version: '0.2.0' })
    expect(updater.state()).toEqual({ status: 'ready', version: '0.2.0' })
    expect(events.map((e) => e.payload)).toEqual([
      { status: 'downloading', version: '0.2.0' },
      { status: 'ready', version: '0.2.0' },
    ])
    expect(events.every((e) => e.channel === 'update.state')).toBe(true)
    updater.dispose()
  })

  it('erro de rede vira log warn, sem mudar o estado', () => {
    const warn = vi.fn()
    const fake = new FakeUpdater()
    const updater = createUpdater({
      autoUpdater: fake as unknown as UpdaterLike,
      enabled: true,
      emit: () => undefined,
      log: { ...silent, warn },
      version: '0.1.3',
    })
    updater.start()
    fake.emit('error', new Error('offline'))
    expect(warn).toHaveBeenCalled()
    expect(updater.state().status).toBe('idle')
    updater.dispose()
  })

  it('erro durante o download volta para idle e avisa a tela', () => {
    const { fake, events, updater } = setup()
    updater.start()
    fake.emit('update-available', { version: '0.2.0' })
    fake.emit('error', new Error('rede caiu'))
    expect(updater.state()).toEqual({ status: 'idle', version: null })
    expect(events.at(-1)?.payload).toEqual({ status: 'idle', version: null })
    updater.dispose()
  })

  it('install recusa se não está pronto e chama quitAndInstall se está', () => {
    const { fake, updater } = setup()
    updater.start()
    expect(() => updater.install()).toThrow(/Não há atualização pronta/)
    expect(fake.quitAndInstall).not.toHaveBeenCalled()
    fake.emit('update-downloaded', { version: '0.2.0' })
    updater.install()
    expect(fake.quitAndInstall).toHaveBeenCalledTimes(1)
    updater.dispose()
  })
})

describe('createUpdater.checkNow', () => {
  it('desligado: erro claro, sem procurar', async () => {
    const { fake, updater } = setup(false)
    await expect(updater.checkNow()).rejects.toThrow('A atualização só funciona no app instalado.')
    expect(fake.checkForUpdates).not.toHaveBeenCalled()
  })

  it('versão nova: devolve a versão encontrada e a atual', async () => {
    const { fake, updater } = setup()
    fake.checkForUpdates.mockResolvedValue({
      isUpdateAvailable: true,
      updateInfo: { version: '0.2.0' },
    } as never)
    expect(await updater.checkNow()).toEqual({ current: '0.1.3', available: '0.2.0' })
  })

  it('já na última: available é null', async () => {
    const { fake, updater } = setup()
    fake.checkForUpdates.mockResolvedValue({
      isUpdateAvailable: false,
      updateInfo: { version: '0.1.3' },
    } as never)
    expect(await updater.checkNow()).toEqual({ current: '0.1.3', available: null })
  })

  it('falha vira erro em português', async () => {
    const { fake, updater } = setup()
    fake.checkForUpdates.mockRejectedValue(new Error('net::ERR'))
    await expect(updater.checkNow()).rejects.toThrow('Não foi possível verificar a atualização')
  })

  it('reaproveita a checagem em andamento', async () => {
    const { fake, updater } = setup()
    const [a, b] = await Promise.all([updater.checkNow(), updater.checkNow()])
    expect(fake.checkForUpdates).toHaveBeenCalledTimes(1)
    expect(a).toEqual(b)
    await updater.checkNow()
    expect(fake.checkForUpdates).toHaveBeenCalledTimes(2)
  })
})

describe('createWhatsNew', () => {
  const md = '## 0.2.0\n\n- Novidade\n\n## 0.1.0\n\nAntiga'
  function whatsNew(version: string, seen: string | null, file: string | null = md) {
    let saved = seen
    return {
      api: createWhatsNew({
        version: () => version,
        readChangelog: () => file,
        getSeen: () => saved,
        setSeen: (v) => (saved = v),
      }),
      saved: () => saved,
    }
  }

  it('mostra a versão nova e deixa de mostrar depois de vista', () => {
    const { api, saved } = whatsNew('0.2.0', '0.1.0')
    expect(api.get()).toEqual({ version: '0.2.0', notes: '- Novidade' })
    api.markSeen()
    expect(saved()).toBe('0.2.0')
    expect(api.get()).toBeNull()
  })

  it('primeira instalação (nada gravado) também mostra', () => {
    expect(whatsNew('0.1.0', null).api.get()).toEqual({ version: '0.1.0', notes: 'Antiga' })
  })

  it('sem arquivo ou sem seção da versão devolve null', () => {
    expect(whatsNew('0.2.0', null, null).api.get()).toBeNull()
    expect(whatsNew('0.9.0', null).api.get()).toBeNull()
  })
})
