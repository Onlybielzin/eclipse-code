import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { APP_PRODUCT_NAME, ENV } from '@shared/app'
import { DomainError } from '@shared/domain'
import {
  isMcpToolName,
  MCP_SERVER_NAME,
  MCP_TOOL_DESCRIPTIONS,
  mcpToolInputSchemas,
  type McpHelloResult,
  type McpToolName,
} from '@shared/mcp'
import type { McpBridgeClient } from '@shared/ports'
import { createMcpBridgeClient } from './bridgeClient'

export const MCP_SERVER_VERSION = '1.0.0'

/** JSON Schema de entrada de uma ferramenta, gerado do zod compartilhado. */
export function toolInputJsonSchema(name: McpToolName): { type: 'object'; [key: string]: unknown } {
  const schema = z.toJSONSchema(mcpToolInputSchemas[name], { io: 'input' }) as Record<
    string,
    unknown
  >
  delete schema['$schema']
  return { ...schema, type: 'object' }
}

/**
 * Servidor MCP que o Lider e os membros recebem. Nao decide nada: lista as
 * ferramentas que o main diz que o token pode ver e repassa cada chamada pela ponte.
 */
export function createEclipseMcpServer(client: McpBridgeClient): Server {
  const server = new Server(
    { name: MCP_SERVER_NAME, title: APP_PRODUCT_NAME, version: MCP_SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        'Ferramentas do time do Eclipse Code. O Lider cria e acompanha subtarefas; o membro termina cada turno com entregar.',
    },
  )
  let hello: Promise<McpHelloResult> | null = null
  const getHello = () => {
    hello ??= client.hello().catch((error: unknown) => {
      hello = null
      throw error
    })
    return hello
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const { tools } = await getHello()
    return {
      tools: tools.map((name) => ({
        name,
        description: MCP_TOOL_DESCRIPTIONS[name],
        inputSchema: toolInputJsonSchema(name),
      })),
    }
  })

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const { name, arguments: args } = request.params
    if (!isMcpToolName(name)) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Ferramenta desconhecida: ${name}` }],
      }
    }
    try {
      const result = await client.callTool(name, args ?? {})
      return {
        content: [{ type: 'text', text: result.text }],
        ...(result.data ? { structuredContent: result.data } : {}),
        ...(result.isError ? { isError: true } : {}),
      }
    } catch (error) {
      const message =
        error instanceof DomainError
          ? `${error.code}: ${error.message}`
          : error instanceof Error
            ? error.message
            : String(error)
      return { isError: true, content: [{ type: 'text', text: message }] }
    }
  })

  return server
}

/** Entrada do processo filho: le socket e token do ambiente e serve por stdio. */
export async function runStdioMcpServer(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const socketPath = env[ENV.mcpSocket]
  const token = env[ENV.mcpToken]
  if (!socketPath || !token) {
    process.stderr.write(`${ENV.mcpSocket} e ${ENV.mcpToken} sao obrigatorios\n`)
    process.exitCode = 2
    return
  }
  const client = createMcpBridgeClient({ socketPath, token })
  const server = createEclipseMcpServer(client)
  server.onclose = () => client.close()
  await server.connect(new StdioServerTransport())
}
