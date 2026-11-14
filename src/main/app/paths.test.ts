import { describe, expect, it } from 'vitest'
import { resolveAppPaths } from './paths'

describe('resolveAppPaths', () => {
  it('usa pasta propria, separada do app antigo', () => {
    const p = resolveAppPaths({ XDG_RUNTIME_DIR: '/run/user/1000' }, '/home/u/.config')
    expect(p.userData).toBe('/home/u/.config/eclipse-code-next')
    expect(p.database).toBe('/home/u/.config/eclipse-code-next/eclipse-code.sqlite')
    expect(p.runtime).toBe('/run/user/1000/eclipse-code-next')
    expect(p.userData).not.toContain('Eclipse Code')
  })
})

describe('resolveAppPaths com --user-data-dir', () => {
  it('poe dados na pasta pedida e separa o socket da instalacao normal', () => {
    const env = { XDG_RUNTIME_DIR: '/run/user/1000' }
    const normal = resolveAppPaths(env, '/home/u/.config')
    const p = resolveAppPaths(env, '/home/u/.config', '/tmp/smoke-data')
    expect(p.userData).toBe('/tmp/smoke-data')
    expect(p.database).toBe('/tmp/smoke-data/eclipse-code.sqlite')
    expect(p.runtime).toMatch(/^\/run\/user\/1000\/eclipse-code-next-[0-9a-f]{8}$/)
    expect(p.runtime).not.toBe(normal.runtime)
    expect(resolveAppPaths(env, '/x', '/tmp/smoke-data').runtime).toBe(p.runtime)
  })
})

describe('resolveAppPaths no win32', () => {
  it('usa APPDATA e uma pasta de runtime sem uid', () => {
    const p = resolveAppPaths({ APPDATA: '/u/AppData/Roaming' }, undefined, undefined, 'win32')
    expect(p.userData).toBe('/u/AppData/Roaming/eclipse-code-next')
    expect(p.runtime).toMatch(/eclipse-code-next$/)
    expect(p.runtime).not.toMatch(/-\d+$/)
  })

  it('sem APPDATA cai em AppData/Roaming da home', () => {
    const p = resolveAppPaths({}, undefined, undefined, 'win32')
    expect(p.userData).toMatch(/AppData[\\/]Roaming[\\/]eclipse-code-next$/)
  })
})
