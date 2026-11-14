import { describe, expect, it } from 'vitest'
import { buildExternalTerminalCommand, externalTerminalIdSchema } from './externalTerminal'
import { parseIpcInvokeRequest } from './ipc'

describe('buildExternalTerminalCommand', () => {
  it('kitty recebe a pasta com espaço como argumento separado', () => {
    expect(buildExternalTerminalCommand('kitty', '/home/a b/proj')).toEqual({
      command: 'kitty',
      args: ['--directory', '/home/a b/proj'],
    })
  })

  it('wt, cmd e open -a Terminal', () => {
    expect(buildExternalTerminalCommand('windows-terminal', 'C:\\Meus Projetos\\x')).toEqual({
      command: 'wt.exe',
      args: ['-d', 'C:\\Meus Projetos\\x'],
    })
    expect(buildExternalTerminalCommand('cmd', 'C:\\x')).toEqual({ command: 'cmd.exe', args: [] })
    expect(buildExternalTerminalCommand('terminal', '/Users/a b')).toEqual({
      command: 'open',
      args: ['-a', 'Terminal', '/Users/a b'],
    })
    expect(buildExternalTerminalCommand('gnome-terminal', '/a b').args).toEqual([
      '--working-directory=/a b',
    ])
  })

  it('recusa id desconhecido', () => {
    expect(() => buildExternalTerminalCommand('rm', '/x')).toThrow()
    expect(externalTerminalIdSchema.safeParse('rm').success).toBe(false)
  })
})

describe('IPC do terminal externo', () => {
  const ok = (channel: string, input: unknown) => parseIpcInvokeRequest({ channel, input }).ok
  it('externalTerminal.save aceita id da lista ou null e recusa o resto', () => {
    expect(ok('externalTerminal.save', { id: 'kitty' })).toBe(true)
    expect(ok('externalTerminal.save', { id: null })).toBe(true)
    expect(ok('externalTerminal.save', { id: 'bash -c x' })).toBe(false)
    expect(ok('externalTerminal.save', { id: 'kitty', extra: 1 })).toBe(false)
  })
  it('externalTerminal.open pede taskId e externalTerminal.get não pede nada', () => {
    expect(ok('externalTerminal.open', { taskId: 't1' })).toBe(true)
    expect(ok('externalTerminal.open', {})).toBe(false)
    expect(ok('externalTerminal.get', {})).toBe(true)
    expect(ok('externalTerminal.get', { x: 1 })).toBe(false)
  })
})
