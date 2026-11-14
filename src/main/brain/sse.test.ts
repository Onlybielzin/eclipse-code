import { describe, expect, it } from 'vitest'
import { createSseParser, type SseMessage } from './sse'

function parse(chunks: string[]): SseMessage[] {
  const out: SseMessage[] = []
  const parser = createSseParser((m) => out.push(m))
  for (const c of chunks) parser.feed(c)
  return out
}

describe('createSseParser', () => {
  it('junta evento partido entre pedaços, inclusive no meio de uma linha', () => {
    expect(parse(['event: activ', 'ity\nda', 'ta: {"a":1}\n', '\n'])).toEqual([
      { event: 'activity', data: '{"a":1}' },
    ])
  })

  it('ignora ping (comentário) e evento sem data', () => {
    expect(parse([': ping\n\n', 'event: x\n\n', 'event: activity\ndata: 1\n\n'])).toEqual([
      { event: 'activity', data: '1' },
    ])
  })

  it('junta várias linhas data: com quebra de linha e aceita CRLF', () => {
    expect(parse(['event: history\r\ndata: [1,\r\ndata: 2]\r\n\r\n'])).toEqual([
      { event: 'history', data: '[1,\n2]' },
    ])
  })

  it('sem linha event: o nome é message; dois eventos seguidos saem em ordem', () => {
    expect(parse(['data: a\n\ndata: b\n\n'])).toEqual([
      { event: 'message', data: 'a' },
      { event: 'message', data: 'b' },
    ])
  })
})
