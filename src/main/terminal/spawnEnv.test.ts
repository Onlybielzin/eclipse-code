import { describe, expect, it } from 'vitest'
import { sanitizeInheritedEnv } from './spawnEnv'

describe('sanitizeInheritedEnv com PATH', () => {
  it('tira a pasta de shim do PATH no formato do Windows', () => {
    const env = sanitizeInheritedEnv(
      {
        Path: 'C:\\shim\\;C:\\Windows;C:\\Users\\u\\bin',
        ECLIPSE_CODE_CLI_SHIM_DIRECTORY: 'C:\\shim',
      },
      { platform: 'win32', delimiter: ';' },
    )
    expect(env['Path']).toBe('C:\\Windows;C:\\Users\\u\\bin')
  })

  it('no Linux separa por dois pontos', () => {
    const env = sanitizeInheritedEnv(
      { PATH: '/shim/:/usr/bin', ECLIPSE_CODE_CLI_SHIM_DIRECTORY: '/shim' },
      { platform: 'linux', delimiter: ':' },
    )
    expect(env['PATH']).toBe('/usr/bin')
  })
})
