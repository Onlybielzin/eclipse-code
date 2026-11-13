import { describe, expect, it } from 'vitest'
import {
  deliveryFromEntregar,
  isMcpToolName,
  MCP_TOOL_NAMES,
  MCP_TOOL_ROLES,
  mcpBridgeRequestSchema,
  mcpToolInputSchemas,
} from './mcp'

describe('ferramentas MCP', () => {
  it('membro so entrega; Lider faz o resto', () => {
    expect(MCP_TOOL_NAMES.filter((n) => MCP_TOOL_ROLES[n].includes('member'))).toEqual(['entregar'])
    expect(isMcpToolName('entregar')).toBe(true)
    expect(isMcpToolName('constructor')).toBe(false)
  })

  it('entregar mapeia para Delivery', () => {
    const input = mcpToolInputSchemas.entregar.parse({ estado: 'duvida', resumo: 'qual banco?' })
    expect(deliveryFromEntregar(input)).toEqual({
      state: 'input_required',
      summary: 'qual banco?',
      files: [],
      tests: [],
      questions: [],
    })
  })

  it('ponte recusa pedido sem token valido', () => {
    expect(
      mcpBridgeRequestSchema.safeParse({ v: 1, id: 1, token: 'curto', method: 'hello' }).success,
    ).toBe(false)
    expect(
      mcpBridgeRequestSchema.safeParse({ v: 1, id: 1, token: 'x'.repeat(43), method: 'hello' })
        .success,
    ).toBe(true)
  })
})
