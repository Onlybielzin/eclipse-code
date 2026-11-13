import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, rmSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import { ENV } from '@shared/app'
import { DomainError, toDomainErrorPayload, type SessionId } from '@shared/domain'
import {
  isMcpToolName,
  MCP_BRIDGE_PROTOCOL_VERSION,
  MCP_SERVER_NAME,
  MCP_TOOL_NAMES,
  MCP_TOOL_ROLES,
  mcpBridgeRequestSchema,
  type McpBridgeResponse,
  type McpCaller,
  type McpHelloResult,
} from '@shared/mcp'
import type { McpBridgeServer, McpServerLaunch, McpTokenGrant, McpToolHandler } from '@shared/ports'
import { readLines, writeLine } from './ndjson'

export interface McpBridgeServerOptions {
  /** AppPaths.runtime. Criada com 0700 se nao existir. */
  runtimeDir: string
  /** Nome do arquivo do socket dentro de runtimeDir. */
  socketName?: string
  /** Caminho do script do servidor MCP stdio (out/main/mcp-server.js). */
  serverScriptPath: string
  /** Executavel que roda o script. Padrao: process.execPath com ELECTRON_RUN_AS_NODE=1. */
  nodeCommand?: string
}

/**
 * Lado main da ponte. Socket unix 0600 em AppPaths.runtime; tokens aleatorios de
 * 32 bytes, so em memoria, um por sessao. O papel do chamador vem do token, nunca
 * do pedido.
 */
export function createMcpBridgeServer(options: McpBridgeServerOptions): McpBridgeServer {
  const socketPath = join(options.runtimeDir, options.socketName ?? 'mcp.sock')
  const tokens = new Map<string, McpCaller>()
  const sockets = new Set<Socket>()
  let server: Server | null = null
  let handler: McpToolHandler | null = null

  const respond = (socket: Socket, response: McpBridgeResponse) => writeLine(socket, response)

  const fail = (socket: Socket, id: number, error: unknown) =>
    respond(socket, {
      v: MCP_BRIDGE_PROTOCOL_VERSION,
      id,
      ok: false,
      error: toDomainErrorPayload(error),
    })

  const onLine = (socket: Socket, line: string) => {
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch {
      fail(socket, 0, new DomainError('invalid_input', 'linha nao e JSON'))
      return
    }
    const parsed = mcpBridgeRequestSchema.safeParse(raw)
    if (!parsed.success) {
      const id =
        typeof (raw as { id?: unknown } | null)?.id === 'number' ? (raw as { id: number }).id : 0
      fail(socket, id, new DomainError('invalid_input', 'pedido fora do protocolo da ponte'))
      return
    }
    const request = parsed.data
    const caller = tokens.get(request.token)
    if (!caller) {
      fail(socket, request.id, new DomainError('forbidden', 'token desconhecido ou revogado'))
      return
    }
    if (request.method === 'hello') {
      const result: McpHelloResult = {
        caller: { ...caller },
        tools: MCP_TOOL_NAMES.filter((name) => MCP_TOOL_ROLES[name].includes(caller.role)),
      }
      respond(socket, { v: MCP_BRIDGE_PROTOCOL_VERSION, id: request.id, ok: true, result })
      return
    }
    const { name, arguments: args } = request.params
    if (!isMcpToolName(name)) {
      fail(socket, request.id, new DomainError('not_found', `ferramenta desconhecida: ${name}`))
      return
    }
    // Autorizacao pelo papel do token; o handler confere de novo.
    if (!MCP_TOOL_ROLES[name].includes(caller.role)) {
      fail(
        socket,
        request.id,
        new DomainError('forbidden', `${name} nao e permitida para ${caller.role}`),
      )
      return
    }
    const current = handler
    if (!current) {
      fail(socket, request.id, new DomainError('unavailable', 'ponte parada'))
      return
    }
    current
      .callTool({ ...caller }, name, args)
      .then((result) =>
        respond(socket, { v: MCP_BRIDGE_PROTOCOL_VERSION, id: request.id, ok: true, result }),
      )
      .catch((error: unknown) => fail(socket, request.id, error))
  }

  return {
    async start(toolHandler) {
      if (server) throw new DomainError('conflict', 'ponte MCP ja iniciada')
      handler = toolHandler
      mkdirSync(options.runtimeDir, { recursive: true, mode: 0o700 })
      // Socket velho de uma execucao anterior: nao ha dono vivo (tokens morreram com ele).
      rmSync(socketPath, { force: true })
      const next = createServer((socket) => {
        sockets.add(socket)
        socket.on('close', () => sockets.delete(socket))
        socket.on('error', () => socket.destroy())
        readLines(
          socket,
          (line) => onLine(socket, line),
          () => socket.destroy(),
        )
      })
      await new Promise<void>((resolve, reject) => {
        next.once('error', reject)
        next.listen(socketPath, () => {
          next.off('error', reject)
          resolve()
        })
      })
      chmodSync(socketPath, 0o600)
      server = next
      return { socketPath }
    },

    async stop() {
      const current = server
      server = null
      handler = null
      tokens.clear()
      for (const socket of sockets) socket.destroy()
      sockets.clear()
      if (current) await new Promise<void>((resolve) => current.close(() => resolve()))
      rmSync(socketPath, { force: true })
    },

    issueToken(grant: McpTokenGrant) {
      if (grant.role === 'member' && grant.subtaskId === null) {
        throw new DomainError('invalid_input', 'token de membro precisa da subtarefa')
      }
      const token = randomBytes(32).toString('base64url')
      tokens.set(token, {
        role: grant.role,
        sessionId: grant.sessionId,
        taskId: grant.taskId,
        subtaskId: grant.role === 'leader' ? null : grant.subtaskId,
      })
      return token
    },

    revokeSession(sessionId: SessionId) {
      for (const [token, caller] of tokens) {
        if (caller.sessionId === sessionId) tokens.delete(token)
      }
    },

    resolve(token: string) {
      const caller = tokens.get(token)
      return caller ? { ...caller } : null
    },

    launchSpec(token: string): McpServerLaunch {
      return {
        name: MCP_SERVER_NAME,
        command: options.nodeCommand ?? process.execPath,
        args: [options.serverScriptPath],
        env: {
          ELECTRON_RUN_AS_NODE: '1',
          [ENV.marker]: '1',
          [ENV.mcpSocket]: socketPath,
          [ENV.mcpToken]: token,
        },
      }
    },
  }
}
