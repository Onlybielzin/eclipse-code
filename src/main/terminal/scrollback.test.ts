import { describe, expect, it } from 'vitest'
import { ScrollbackBuffer } from './scrollback'
import { resolvePtySpawnEnv } from './spawnEnv'

describe('ScrollbackBuffer', () => {
  it('guarda tudo enquanto cabe', () => {
    const buffer = new ScrollbackBuffer(10)
    buffer.append('abc')
    buffer.append('def')
    expect(buffer.toString()).toBe('abcdef')
    expect(buffer.size).toBe(6)
  })

  it('descarta o inicio quando passa do limite', () => {
    const buffer = new ScrollbackBuffer(5)
    buffer.append('abc')
    buffer.append('defg')
    expect(buffer.toString()).toBe('cdefg')
    expect(buffer.size).toBe(5)
  })

  it('pedaco maior que o limite fica so com o final', () => {
    const buffer = new ScrollbackBuffer(4)
    buffer.append('x')
    buffer.append('0123456789')
    expect(buffer.toString()).toBe('6789')
  })

  it('aguenta muitos pedacos pequenos sem crescer', () => {
    const buffer = new ScrollbackBuffer(100)
    for (let index = 0; index < 1000; index += 1) buffer.append(`${index % 10}`)
    expect(buffer.size).toBe(100)
    expect(buffer.toString()).toHaveLength(100)
  })
})

describe('resolvePtySpawnEnv', () => {
  it('limpa marcas da sessao pai, cor desligada e ELECTRON_RUN_AS_NODE', () => {
    const env = resolvePtySpawnEnv({
      PATH: '/bin',
      CLAUDECODE: '1',
      CLAUDE_CODE_SESSION_ID: 'pai',
      CLAUDE_CODE_ENABLE_TODO_TOOLS: '1',
      NO_COLOR: '1',
      ELECTRON_RUN_AS_NODE: '1',
      VAZIO: undefined,
    })
    expect(env).toMatchObject({
      PATH: '/bin',
      CLAUDE_CODE_ENABLE_TODO_TOOLS: '1',
      TERM: 'xterm-256color',
    })
    expect(env).not.toHaveProperty('CLAUDECODE')
    expect(env).not.toHaveProperty('CLAUDE_CODE_SESSION_ID')
    expect(env).not.toHaveProperty('NO_COLOR')
    expect(env).not.toHaveProperty('ELECTRON_RUN_AS_NODE')
    expect(env).not.toHaveProperty('VAZIO')
  })
})
