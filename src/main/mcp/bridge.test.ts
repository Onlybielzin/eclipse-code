import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { ENV } from '@shared/app'
import { MCP_BRIDGE_MAX_FRAME_BYTES, type McpCaller } from '@shared/mcp'
import type { McpBridgeServer, McpToolHandler } from '@shared/ports'
import { createMcpBridgeClient } from './bridgeClient'
import { createMcpBridgeServer } from './bridgeServer'
import { createEclipseMcpServer } from './stdioServer'
import { createMcpToolHandler } from './toolHandler'
import { createFakeTaskService } from './testing/fakeTaskService'

let dir: string
let bridge: McpBridgeServer
let socketPath: string

function spyHandler() {
  const calls: { caller: McpCaller; name: string; args: unknown }[] = []
  const handler: McpToolHandler = {
    async callTool(caller, name, args) {
      calls.push({ caller, name, args })
      return { text: `ok ${name}`, data: { quem: caller.role } }
    },
  }
  return { handler, calls }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ecn-mcp-'))
  bridge = createMcpBridgeServer({
    runtimeDir: join(dir, 'run'),
    serverScriptPath: '/app/out/main/mcp-server.js',
    nodeCommand: '/usr/bin/electron',
  })
})

afterEach(async () => {
  await bridge.stop()
  rmSync(dir, { recursive: true, force: true })
})

describe('McpBridgeServer', () => {
  it('socket 0600 em pasta 0700; launchSpec leva socket e token pelo ambiente', async () => {
    ;({ socketPath } = await bridge.start(spyHandler().handler))
    expect(statSync(socketPath).mode & 0o777).toBe(0o600)
    expect(statSync(join(dir, 'run')).mode & 0o777).toBe(0o700)
    const token = bridge.issueToken({
      role: 'leader',
      sessionId: 's1',
      taskId: 't1',
      subtaskId: null,
    })
    expect(token.length).toBeGreaterThanOrEqual(43)
    expect(bridge.launchSpec(token)).toEqual({
      name: 'eclipse',
      command: '/usr/bin/electron',
      args: ['/app/out/main/mcp-server.js'],
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        [ENV.marker]: '1',
        [ENV.mcpSocket]: socketPath,
        [ENV.mcpToken]: token,
      },
    })
  })

  it('o papel vem do token: hello filtra ferramentas e tool.call chega com o caller do main', async () => {
    const { handler, calls } = spyHandler()
    ;({ socketPath } = await bridge.start(handler))
    const leaderToken = bridge.issueToken({
      role: 'leader',
      sessionId: 'sL',
      taskId: 't1',
      subtaskId: null,
    })
    const memberToken = bridge.issueToken({
      role: 'member',
      sessionId: 'sM',
      taskId: 't1',
      subtaskId: 'sub1',
    })
    const lead = createMcpBridgeClient({ socketPath, token: leaderToken })
    const mem = createMcpBridgeClient({ socketPath, token: memberToken })
    try {
      expect((await lead.hello()).tools).toContain('subtarefas_esperar')
      expect((await lead.hello()).tools).not.toContain('entregar')
      expect(await mem.hello()).toEqual({
        caller: { role: 'member', sessionId: 'sM', taskId: 't1', subtaskId: 'sub1' },
        tools: ['entregar'],
      })
      await expect(mem.callTool('subtarefa_criar', { papel: 'x' })).rejects.toMatchObject({
        code: 'forbidden',
      })
      await expect(lead.callTool('entregar', {})).rejects.toMatchObject({ code: 'forbidden' })
      expect(calls).toHaveLength(0)
      const result = await mem.callTool('entregar', { estado: 'pronto', resumo: 'r' })
      expect(result).toEqual({ text: 'ok entregar', data: { quem: 'member' } })
      expect(calls[0]?.caller).toEqual({
        role: 'member',
        sessionId: 'sM',
        taskId: 't1',
        subtaskId: 'sub1',
      })
    } finally {
      lead.close()
      mem.close()
    }
  })

  it('token desconhecido ou revogado e recusado', async () => {
    ;({ socketPath } = await bridge.start(spyHandler().handler))
    const token = bridge.issueToken({
      role: 'leader',
      sessionId: 's1',
      taskId: 't1',
      subtaskId: null,
    })
    const fake = createMcpBridgeClient({ socketPath, token: 'z'.repeat(43) })
    const good = createMcpBridgeClient({ socketPath, token })
    try {
      await expect(fake.hello()).rejects.toMatchObject({ code: 'forbidden' })
      await expect(good.hello()).resolves.toBeTruthy()
      bridge.revokeSession('s1')
      expect(bridge.resolve(token)).toBeNull()
      await expect(good.hello()).rejects.toMatchObject({ code: 'forbidden' })
    } finally {
      fake.close()
      good.close()
    }
  })

  it('membro sem subtarefa nao ganha token', () => {
    expect(() =>
      bridge.issueToken({ role: 'member', sessionId: 's', taskId: 't', subtaskId: null }),
    ).toThrow()
  })

  it('linha maior que o limite fecha a conexao; lixo recebe erro sem derrubar', async () => {
    ;({ socketPath } = await bridge.start(spyHandler().handler))
    const socket = connect(socketPath)
    await new Promise<void>((r) => socket.once('connect', () => r()))
    const firstLine = new Promise<string>((r) => socket.once('data', (d) => r(String(d))))
    socket.write('nao e json\n')
    expect(JSON.parse(await firstLine)).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
    })
    const closed = new Promise<void>((r) => socket.once('close', () => r()))
    socket.write('x'.repeat(MCP_BRIDGE_MAX_FRAME_BYTES + 10))
    await closed
  })

  it('cliente rejeita pendentes quando a ponte para', async () => {
    let release: (() => void) | null = null
    const handler: McpToolHandler = {
      callTool: () =>
        new Promise((resolve) => {
          release = () => resolve({ text: 'tarde' })
        }),
    }
    ;({ socketPath } = await bridge.start(handler))
    const token = bridge.issueToken({
      role: 'leader',
      sessionId: 's1',
      taskId: 't1',
      subtaskId: null,
    })
    const client = createMcpBridgeClient({ socketPath, token })
    const pending = client.callTool('subtarefas_ver', {})
    await vi.waitFor(() => expect(release).not.toBeNull())
    await bridge.stop()
    await expect(pending).rejects.toMatchObject({ code: 'unavailable' })
    ;(release as (() => void) | null)?.()
    client.close()
  })
})

describe('servidor MCP com cliente MCP falso (ponta a ponta sem modelo)', () => {
  async function connectMcp(token: string) {
    const server = createEclipseMcpServer(createMcpBridgeClient({ socketPath, token }))
    const client = new Client({ name: 'cliente-falso', version: '0.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    return { client, server }
  }

  it('Lider ve as ferramentas dele; membro ve so entregar e grava a entrega', async () => {
    const tasks = createFakeTaskService()
    tasks.seedSubtask({ id: 'sub1', state: 'working' })
    const handler = createMcpToolHandler({
      tasks,
      actions: {
        createSubtask: async () => tasks.seedSubtask({ id: 'n1' }),
        answerSubtask: async (_c, id) => tasks.getSubtask(id),
        cancelSubtask: async (_c, id) => tasks.getSubtask(id),
      },
    })
    ;({ socketPath } = await bridge.start(handler))
    const leaderToken = bridge.issueToken({
      role: 'leader',
      sessionId: 'sL',
      taskId: 'task1',
      subtaskId: null,
    })
    const memberToken = bridge.issueToken({
      role: 'member',
      sessionId: 'sM',
      taskId: 'task1',
      subtaskId: 'sub1',
    })

    const lead = await connectMcp(leaderToken)
    const mem = await connectMcp(memberToken)
    try {
      const leaderTools = (await lead.client.listTools()).tools
      expect(leaderTools.map((t) => t.name).sort()).toEqual(
        [
          'pergunta_repassar',
          'subtarefa_cancelar',
          'subtarefa_criar',
          'subtarefa_responder',
          'subtarefas_esperar',
          'subtarefas_ver',
          'tarefa_concluir',
        ].sort(),
      )
      const criar = leaderTools.find((t) => t.name === 'subtarefa_criar')
      expect(criar?.inputSchema).toMatchObject({
        type: 'object',
        required: expect.arrayContaining(['papel', 'titulo', 'instrucoes']),
      })

      const memberTools = (await mem.client.listTools()).tools
      expect(memberTools.map((t) => t.name)).toEqual(['entregar'])

      const created = await lead.client.callTool({
        name: 'subtarefa_criar',
        arguments: { papel: 'Dev', titulo: 'Login', instrucoes: 'Faça o login' },
      })
      expect(created.isError).toBeFalsy()
      expect(created.structuredContent).toMatchObject({ id: 'n1', papel: 'Dev' })

      const delivered = await mem.client.callTool({
        name: 'entregar',
        arguments: {
          estado: 'pronto',
          resumo: 'login feito',
          testes: [{ command: 'pnpm test', result: '5 passed', passed: true }],
        },
      })
      expect(delivered.isError).toBeFalsy()
      expect(tasks.deliveries[0]).toMatchObject({
        sessionId: 'sM',
        delivery: { state: 'completed' },
      })

      // Membro tentando criar: o servidor MCP repassa e o main recusa.
      const denied = await mem.client.callTool({
        name: 'subtarefa_criar',
        arguments: { papel: 'Dev', titulo: 'x', instrucoes: 'y' },
      })
      expect(denied.isError).toBe(true)
      expect(JSON.stringify(denied.content)).toContain('forbidden')

      const invalid = await lead.client.callTool({ name: 'subtarefas_ver', arguments: { foo: 1 } })
      expect(invalid.isError).toBe(true)
      expect(JSON.stringify(invalid.content)).toContain('invalid_input')
    } finally {
      await lead.client.close()
      await mem.client.close()
      handler.dispose()
    }
  })
})
