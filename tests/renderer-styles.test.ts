import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(resolve(__dirname, '../src/renderer/src/styles.css'), 'utf8')

const rule = (sel: string): string => {
  const all = [...css.matchAll(new RegExp(`(?:^|\\n)${sel.replace(/[.]/g, '\\.')}\\s*\\{([^}]*)\\}`, 'g'))]
  // A última regra com o mesmo seletor é a que vence na cascata.
  return all.at(-1)?.[1] ?? ''
}

describe('opção 1: fundos em camadas', () => {
  it('define os tokens de camada', () => {
    expect(css).toMatch(/--term:\s*#07090e;/)
    expect(css).toMatch(/--panel:\s*#0f131c;/)
    expect(css).toMatch(/--head:\s*#131824;/)
    expect(css).toMatch(/--on-ic:\s*#0f131c;/)
  })

  it('usa as camadas nos seletores que vencem', () => {
    expect(rule('.titlebar')).toContain('background: var(--head)')
    expect(rule('.side-head')).toContain('background: var(--head)')
    expect(rule('.colhead')).toContain('background: var(--head)')
    expect(rule('.side-panel')).toContain('background: var(--panel)')
    expect(rule('.col-left')).toContain('background: var(--panel)')
    expect(rule('.col-subs')).toContain('background: var(--panel)')
    expect(rule('.mid')).toContain('background: var(--term)')
    expect(rule('.task-search-box')).toContain('background: var(--term)')
    expect(rule('.modal')).toContain('background: var(--raised)')
    expect(rule('.sub-item.sel')).toContain('background: var(--raised)')
  })

  it('o ícone de revisão tem furo transparente e o xterm o fundo do terminal', () => {
    expect(css).toContain("fill-rule='evenodd'")
    expect(css).not.toContain("r='2' fill='%230f131c'")
    expect(readFileSync(resolve(__dirname, '../src/renderer/src/terminal/createXterm.ts'), 'utf8')).toContain(
      "background: '#07090e'"
    )
  })
})

describe('design C: tokens e movimento', () => {
  it('cada status tem um desenho próprio (não só cor)', () => {
    // Seletores .st-*/.ts-* no mesmo bloco dividem o SVG de propósito; blocos diferentes não.
    const re = /((?:\.(?:st|ts)-[a-z]+,\s*)*\.(?:st|ts)-[a-z]+)\s*\{[^}]*url\("data:image\/svg\+xml,([^"]+)"\)/g
    const svgs = [...css.matchAll(re)].map((m) => m[2])
    expect(svgs.length).toBeGreaterThanOrEqual(8)
    expect(new Set(svgs).size).toBe(svgs.length)
  })

  it('desliga animação e transição com prefers-reduced-motion', () => {
    expect(css).toMatch(/prefers-reduced-motion: reduce\)\s*\{\s*\*/)
  })
})
