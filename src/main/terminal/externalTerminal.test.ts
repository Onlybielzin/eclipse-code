import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { DomainError } from '@shared/domain'
import { createExternalTerminalService, type SpawnExternal } from './externalTerminal'

function setup(opts: { platform?: NodeJS.Platform; found?: string[]; failSpawn?: boolean } = {}) {
  const settings = new Map<string, string>()
  const calls: { command: string; args: string[]; cwd: string | undefined }[] = []
  const spawn: SpawnExternal = (command, args, options) => {
    calls.push({ command, args, cwd: options.cwd })
    const child = Object.assign(new EventEmitter(), { unref: () => undefined })
    queueMicrotask(() =>
      opts.failSpawn ? child.emit('error', new Error('ENOENT')) : child.emit('spawn'),
    )
    return child
  }
  const found = opts.found ?? []
  const service = createExternalTerminalService({
    settings: {
      getSetting: (k) => settings.get(k) ?? null,
      setSetting: (k, v) => void settings.set(k, v),
    },
    tasks: {
      getTask: (id) => ({
        id,
        projectId: 'p1',
        worktreePath: id === 'com-worktree' ? '/wt/a b' : null,
      }),
      getProject: () => ({ rootPath: '/repo' }),
    },
    platform: opts.platform ?? 'linux',
    env: { PATH: '/bin' },
    spawn,
    resolveExecutable: (command) => (found.includes(command) ? `/bin/${command}` : null),
  })
  return { service, calls, settings }
}

describe('externalTerminal', () => {
  it('lista só os da plataforma e marca os achados no PATH', () => {
    const { service } = setup({ found: ['konsole'] })
    const { selected, options } = service.get()
    expect(selected).toBeNull()
    expect(options.map((o) => o.id)).toEqual([
      'kitty',
      'konsole',
      'gnome-terminal',
      'alacritty',
      'wezterm',
      'xterm',
    ])
    expect(options.filter((o) => o.available).map((o) => o.id)).toEqual(['konsole'])
  })

  it('abre o escolhido na worktree, sem shell, com a pasta como argumento', async () => {
    const { service, calls } = setup({ found: ['kitty', 'konsole'] })
    service.save('konsole')
    await service.open('com-worktree')
    expect(calls).toEqual([{ command: '/bin/konsole', args: ['--workdir', '/wt/a b'], cwd: '/wt/a b' }])
  })

  it('automático usa o primeiro disponível e a pasta do projeto sem worktree', async () => {
    const { service, calls } = setup({ found: ['konsole', 'xterm'] })
    await service.open('sem-worktree')
    expect(calls).toEqual([{ command: '/bin/konsole', args: ['--workdir', '/repo'], cwd: '/repo' }])
  })

  it('escolhido ausente do PATH dá erro unavailable em português', async () => {
    const { service, calls } = setup({ found: ['konsole'] })
    service.save('kitty')
    await expect(service.open('t')).rejects.toMatchObject({
      code: 'unavailable',
      message: expect.stringContaining('kitty'),
    })
    expect(calls).toEqual([])
  })

  it('nenhum terminal disponível dá erro unavailable', async () => {
    const { service } = setup()
    await expect(service.open('t')).rejects.toBeInstanceOf(DomainError)
  })

  it('erro do spawn vira DomainError em vez de derrubar o main', async () => {
    const { service } = setup({ found: ['kitty'], failSpawn: true })
    await expect(service.open('t')).rejects.toMatchObject({ code: 'unavailable' })
  })

  it('win32: usa wt.exe e id gravado desconhecido vira automático', async () => {
    const { service, calls, settings } = setup({ platform: 'win32', found: ['cmd.exe', 'wt.exe'] })
    settings.set('externalTerminal', JSON.stringify('kitty'))
    expect(service.get().selected).toBeNull()
    expect(service.get().options.map((o) => o.id)).toEqual([
      'windows-terminal',
      'pwsh',
      'powershell',
      'cmd',
    ])
    await service.open('t')
    expect(calls[0]).toMatchObject({ command: '/bin/wt.exe', args: ['-d', '/repo'] })
  })

  it('save recusa id de outra plataforma e aceita null', () => {
    const { service } = setup()
    expect(() => service.save('cmd')).toThrow(DomainError)
    expect(service.save(null).selected).toBeNull()
  })
})
