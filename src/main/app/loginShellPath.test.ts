import { describe, expect, it, vi } from 'vitest'
import { applyLoginShellPath, mergePaths } from './loginShellPath'

describe('mergePaths', () => {
  it('põe as pastas do shell primeiro e mantém as do processo que faltam, sem duplicar', () => {
    expect(mergePaths('/home/u/.local/bin:/usr/bin', '/usr/local/bin:/usr/bin:/bin')).toBe(
      '/home/u/.local/bin:/usr/bin:/usr/local/bin:/bin',
    )
  })

  it('ignora entradas vazias', () => {
    expect(mergePaths('/a::/b', ':/b:/c')).toBe('/a:/b:/c')
  })
})

describe('applyLoginShellPath', () => {
  const log = { info: vi.fn(), warn: vi.fn() }

  it('lê o PATH depois do marcador e ignora lixo do rc', async () => {
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin', SHELL: '/bin/zsh' }
    const exec = vi.fn(async () => 'bem-vindo\n__ECLIPSE_PATH__/home/u/.local/bin:/usr/bin')
    await applyLoginShellPath({ env, platform: 'linux', exec, log })
    expect(env['PATH']).toBe('/home/u/.local/bin:/usr/bin')
    expect(exec).toHaveBeenCalledWith('/bin/zsh', ['-ilc', expect.stringContaining('$PATH')], 3000)
  })

  it('em erro ou timeout mantém o PATH e registra no log', async () => {
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin' }
    const exec = vi.fn(async () => {
      throw new Error('timeout')
    })
    await applyLoginShellPath({ env, platform: 'linux', exec, log })
    expect(env['PATH']).toBe('/usr/bin')
    expect(log.warn).toHaveBeenCalled()
  })

  it('sem marcador na saída mantém o PATH', async () => {
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin' }
    await applyLoginShellPath({ env, platform: 'linux', exec: async () => 'nada', log })
    expect(env['PATH']).toBe('/usr/bin')
  })

  it('no win32 não faz nada', async () => {
    const env: NodeJS.ProcessEnv = { PATH: 'C:\\Windows' }
    const exec = vi.fn(async () => '__ECLIPSE_PATH__/x')
    await applyLoginShellPath({ env, platform: 'win32', exec, log })
    expect(exec).not.toHaveBeenCalled()
    expect(env['PATH']).toBe('C:\\Windows')
  })
})
