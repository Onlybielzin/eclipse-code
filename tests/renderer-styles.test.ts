import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(resolve(__dirname, '../src/renderer/src/styles.css'), 'utf8')

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
