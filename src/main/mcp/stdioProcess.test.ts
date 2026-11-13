import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { createMcpBridgeServer } from './bridgeServer'

// Processo de verdade: o build (pnpm build) gera out/main/mcp-server.js. Sem build, pula.
const script = resolve(__dirname, '../../../out/main/mcp-server.js')

describe('servidor MCP stdio como processo filho', () => {
  it.skipIf(!existsSync(script))('fala MCP por stdio e chega ao main pela ponte', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ecn-stdio-'))
    const bridge = createMcpBridgeServer({ runtimeDir: join(dir, 'run'), serverScriptPath: script })
    const seen: string[] = []
    await bridge.start({
      async callTool(caller, name) {
        seen.push(`${caller.role}:${name}`)
        return { text: 'Nenhuma subtarefa nesta tarefa.', data: { subtarefas: [] } }
      },
    })
    const token = bridge.issueToken({
      role: 'leader',
      sessionId: 's',
      taskId: 't',
      subtaskId: null,
    })
    const launch = bridge.launchSpec(token)
    const client = new Client({ name: 'cliente-falso', version: '0.0.0' })
    try {
      await client.connect(
        new StdioClientTransport({
          command: launch.command,
          args: launch.args,
          env: { ...(process.env as Record<string, string>), ...launch.env },
          stderr: 'pipe',
        }),
      )
      const tools = await client.listTools()
      expect(tools.tools.map((t) => t.name)).toContain('subtarefas_esperar')
      const result = await client.callTool({ name: 'subtarefas_ver', arguments: {} })
      expect(result.structuredContent).toEqual({ subtarefas: [] })
      expect(seen).toEqual(['leader:subtarefas_ver'])
    } finally {
      await client.close()
      await bridge.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
