import { describe, expect, it } from 'vitest'
import { dropPathsText } from './dropPaths'

describe('dropPathsText', () => {
  it('caminho simples vai cru, com espaco no fim', () => {
    expect(dropPathsText(['/home/vings/a.png'])).toBe('/home/vings/a.png ')
  })
  it('caminho com espaco vai entre aspas simples', () => {
    expect(dropPathsText(['/tmp/minha foto.png'])).toBe("'/tmp/minha foto.png' ")
  })
  it("aspas simples sao escapadas como '\\''", () => {
    expect(dropPathsText(["/tmp/it's.txt"])).toBe("'/tmp/it'\\''s.txt' ")
  })
  it('varios arquivos separados por espaco', () => {
    expect(dropPathsText(['/a/b.txt', '/c d/e.txt'])).toBe("/a/b.txt '/c d/e.txt' ")
  })
  it('lista vazia devolve vazio', () => {
    expect(dropPathsText([])).toBe('')
  })
})
