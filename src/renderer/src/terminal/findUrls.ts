export interface FoundUrl {
  text: string
  /** Indice do primeiro caractere. */
  start: number
  /** Indice depois do ultimo caractere. */
  end: number
}

// shortcut: so http(s) em uma linha; URL quebrada em duas linhas nao e unida.
const URL_RE = /https?:\/\/[^\s<>"'`]+/g

export function findUrls(line: string): FoundUrl[] {
  const found: FoundUrl[] = []
  for (const m of line.matchAll(URL_RE)) {
    let text = m[0]
    // Pontuacao final e ")" sem "(" na URL pertencem a frase, nao ao link.
    for (;;) {
      const last = text.at(-1)
      if (last && /[.,;:!?'"\]}]/.test(last)) text = text.slice(0, -1)
      else if (last === ')' && !text.includes('(')) text = text.slice(0, -1)
      else break
    }
    if (/^https?:\/\/$/.test(text)) continue
    found.push({ text, start: m.index, end: m.index + text.length })
  }
  return found
}
