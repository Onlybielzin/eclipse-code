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

describe('servidor MCP stdio sai quando o agente pai some', () => {
  it('fim do stdin depois do hello encerra o processo (sem órfão preso na ponte)', async () => {
    const { buildMcpServerForTests } = await import('../../../tests/helpers/buildMcpServer')
    const built = await buildMcpServerForTests()
    const dir = mkdtempSync(join(tmpdir(), 'ecn-stdio-end-'))
    const bridge = createMcpBridgeServer({ runtimeDir: join(dir, 'run'), serverScriptPath: built })
    await bridge.start({
      async callTool() {
        return { text: 'ok' }
      },
    })
    const launch = bridge.launchSpec(
      bridge.issueToken({ role: 'leader', sessionId: 's', taskId: 't', subtaskId: null }),
    )
    const { spawn } = await import('node:child_process')
    const child = spawn(launch.command, launch.args, {
      env: { ...(process.env as Record<string, string>), ...launch.env },
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    const exited = new Promise<number | null>((done) => child.once('exit', (code) => done(code)))
    try {
      let out = ''
      const listed = new Promise<void>((done) => {
        child.stdout.setEncoding('utf8')
        child.stdout.on('data', (chunk: string) => {
          out += chunk
          if (out.includes('"id":2')) done()
        })
      })
      const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`)
      send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'teste', version: '0' },
        },
      })
      send({ jsonrpc: '2.0', method: 'notifications/initialized' })
      // tools/list faz o hello: o socket da ponte fica aberto.
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
      await listed
      child.stdin.end()
      const code = await Promise.race([
        exited,
        new Promise<'vivo'>((done) => setTimeout(() => done('vivo'), 3_000)),
      ])
      expect(code).not.toBe('vivo')
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await bridge.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})
