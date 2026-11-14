/** Parser de Server-Sent Events: linhas event:/data:, eventos partidos entre pedacos. */
export interface SseMessage {
  event: string
  data: string
}

export function createSseParser(onMessage: (message: SseMessage) => void) {
  let buffer = ''
  let event = ''
  let data: string[] = []

  const line = (raw: string) => {
    if (raw === '') {
      // Linha vazia fecha o evento; so `:` (ping) ou nada = nada a entregar.
      if (data.length > 0) onMessage({ event: event || 'message', data: data.join('\n') })
      event = ''
      data = []
      return
    }
    if (raw.startsWith(':')) return
    const i = raw.indexOf(':')
    const field = i === -1 ? raw : raw.slice(0, i)
    let value = i === -1 ? '' : raw.slice(i + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') event = value
    else if (field === 'data') data.push(value)
  }

  return {
    feed(chunk: string): void {
      buffer += chunk
      const lines = buffer.split(/\r\n|\n|\r/)
      // A ultima parte pode estar incompleta (ou um \r que espera o \n): fica no buffer.
      buffer = lines.pop() ?? ''
      for (const l of lines) line(l)
    },
  }
}
