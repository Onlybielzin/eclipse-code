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
