import { describe, expect, it, vi } from 'vitest'
import { attachExternalLinks, isExternalUrl } from './externalLinks'

describe('isExternalUrl', () => {
  it('aceita http, https e mailto', () => {
    expect(isExternalUrl('http://a.com/x')).toBe(true)
    expect(isExternalUrl('https://a.com/x?y=1#z')).toBe(true)
    expect(isExternalUrl('mailto:a@b.com')).toBe(true)
  })
  it('recusa outros protocolos e texto invalido', () => {
    for (const u of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x', 'foo://bar', 'lixo', '', 'ssh://h'])
      expect(isExternalUrl(u)).toBe(false)
  })
})

function fakeContents() {
  const handlers: Record<string, (...a: never[]) => void> = {}
  let open: (d: { url: string }) => { action: string } = () => ({ action: 'allow' })
  return {
    handlers,
    runOpen: (url: string) => open({ url }),
    contents: {
      setWindowOpenHandler: (fn: typeof open) => (open = fn),
      on: (ev: string, fn: (...a: never[]) => void) => (handlers[ev] = fn),
    },
  }
}

describe('attachExternalLinks', () => {
  it('window.open externo vai ao navegador e nunca abre janela', () => {
    const f = fakeContents()
    const openExternal = vi.fn()
    attachExternalLinks(f.contents, { openExternal, isAppUrl: () => false })
    expect(f.runOpen('https://a.com')).toEqual({ action: 'deny' })
    expect(openExternal).toHaveBeenCalledWith('https://a.com')
    expect(f.runOpen('file:///x')).toEqual({ action: 'deny' })
    expect(openExternal).toHaveBeenCalledTimes(1)
  })
  it('will-navigate: URL do app passa; outra e barrada e, se externa, aberta fora', () => {
    const f = fakeContents()
    const openExternal = vi.fn()
    attachExternalLinks(f.contents, { openExternal, isAppUrl: (u) => u.startsWith('http://localhost:5173') })
    const nav = f.handlers['will-navigate'] as (d: unknown) => void
    const ok = { url: 'http://localhost:5173/', preventDefault: vi.fn() }
    nav(ok)
    expect(ok.preventDefault).not.toHaveBeenCalled()
    const ext = { url: 'https://a.com', preventDefault: vi.fn() }
    nav(ext)
    expect(ext.preventDefault).toHaveBeenCalled()
    expect(openExternal).toHaveBeenCalledWith('https://a.com')
    const bad = { url: 'javascript:1', preventDefault: vi.fn() }
    nav(bad)
    expect(bad.preventDefault).toHaveBeenCalled()
    expect(openExternal).toHaveBeenCalledTimes(1)
  })
})
