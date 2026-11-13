// Servidor MCP stdio minimo para o scripts/acp-probe.ts: expoe so a ferramenta
// `entregar` e grava cada chamada (uma linha JSON) em PROBE_DELIVERIES_FILE.
// Nao e o servidor MCP do app; serve so para provar que o membro ACP chama ferramentas.
import { appendFileSync } from 'node:fs'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const out = process.env.PROBE_DELIVERIES_FILE
const server = new McpServer({ name: 'eclipse', version: '0.0.0' })
server.registerTool(
  'entregar',
  {
    description: 'Entrega o resultado do turno ao Líder.',
    inputSchema: {
      estado: z.enum(['pronto', 'duvida', 'bloqueado']),
      resumo: z.string(),
    },
  },
  async (args) => {
    if (out) appendFileSync(out, `${JSON.stringify(args)}\n`)
    return { content: [{ type: 'text', text: 'Entrega gravada.' }] }
  },
)
await server.connect(new StdioServerTransport())
