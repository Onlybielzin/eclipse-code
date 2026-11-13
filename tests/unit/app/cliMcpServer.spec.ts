import { afterEach, describe, expect, it } from 'vitest'
import { TOOLS, handleRequest } from '../../../src/app/cli/mcp/server'

const ORIGINAL_ENV = process.env['ECLIPSE_CODE_ENV']

afterEach(() => {
  if (ORIGINAL_ENV === undefined) {
    delete process.env['ECLIPSE_CODE_ENV']
  } else {
    process.env['ECLIPSE_CODE_ENV'] = ORIGINAL_ENV
  }
})

describe('eclipse-code mcp server', () => {
  it('answers initialize with the tools capability and the client protocol version', async () => {
    const result = await handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26' },
    })
    expect(result).toMatchObject({
      protocolVersion: '2025-03-26',
      capabilities: { tools: {} },
      serverInfo: { name: 'eclipse-code' },
    })
  })

  it('lists every team tool with an object input schema', async () => {
    const result = (await handleRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list' })) as {
      tools: Array<{ name: string; inputSchema: { type: string } }>
    }
    expect(result.tools.map(tool => tool.name)).toEqual(TOOLS.map(tool => tool.name))
    expect(result.tools.map(tool => tool.name)).toEqual(
      expect.arrayContaining(['agente_criar', 'agentes_esperar', 'feature_criar_space']),
    )
    for (const tool of result.tools) {
      expect(tool.inputSchema.type).toBe('object')
    }
  })

  it('ignores notifications and rejects unknown methods and tools', async () => {
    expect(await handleRequest({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull()
    await expect(
      handleRequest({ jsonrpc: '2.0', id: 3, method: 'resources/list' }),
    ).rejects.toThrow(/não suportado/)
    await expect(
      handleRequest({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nada' } }),
    ).rejects.toThrow(/desconhecida/)
  })

  it('refuses tool calls outside an Eclipse Code terminal without running the CLI', async () => {
    delete process.env['ECLIPSE_CODE_ENV']
    const result = await handleRequest({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: {
        name: 'agente_criar',
        arguments: { titulo: 'Dev', prompt: 'x', provedor: 'codex' },
      },
    })
    expect(result).toMatchObject({ isError: true })
    expect(JSON.stringify(result)).toContain('Fora do Eclipse Code')
  })
})
