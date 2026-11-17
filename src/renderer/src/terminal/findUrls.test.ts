import { describe, expect, it } from 'vitest'
import { findUrls } from './findUrls'

describe('findUrls', () => {
  it('acha no inicio, meio e fim com a posicao (coluna 0)', () => {
    expect(findUrls('https://a.com abc')).toEqual([{ text: 'https://a.com', start: 0, end: 13 }])
    expect(findUrls('veja http://a.com/x ok')).toEqual([{ text: 'http://a.com/x', start: 5, end: 19 }])
    expect(findUrls('fim https://a.com/p?q=1')).toEqual([{ text: 'https://a.com/p?q=1', start: 4, end: 23 }])
  })
  it('deixa a pontuacao final fora da URL', () => {
    expect(findUrls('(https://a.com/x).')[0]?.text).toBe('https://a.com/x')
    expect(findUrls('ver https://a.com, e')[0]?.text).toBe('https://a.com')
    expect(findUrls('ver https://a.com.')[0]?.text).toBe('https://a.com')
  })
  it('acha varias e ignora linha sem URL', () => {
    expect(findUrls('http://a.com e https://b.com').map((u) => u.text)).toEqual(['http://a.com', 'https://b.com'])
    expect(findUrls('nada aqui ftp://x')).toEqual([])
  })
})
