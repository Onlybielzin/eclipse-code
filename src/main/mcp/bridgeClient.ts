import { connect, type Socket } from 'node:net'
import { DomainError, type DomainErrorPayload } from '@shared/domain'
import {
  MCP_BRIDGE_PROTOCOL_VERSION,
  type McpBridgeRequest,
  type McpHelloResult,
  type McpToolName,
  type McpToolResult,
} from '@shared/mcp'
import type { McpBridgeClient } from '@shared/ports'
import { readLines, writeLine } from './ndjson'

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: DomainError) => void
}

/**
 * Lado do servidor MCP stdio: fala com o main pelo socket unix. Conecta na primeira
 * chamada e reconecta se o socket cair (o main pode reiniciar a ponte).
 */
export function createMcpBridgeClient(options: {
  socketPath: string
  token: string
}): McpBridgeClient {
  let socket: Socket | null = null
  let connecting: Promise<Socket> | null = null
  let nextId = 1
  let closed = false
  const pending = new Map<number, Pending>()

  const rejectAll = (error: DomainError) => {
    for (const entry of pending.values()) entry.reject(error)
    pending.clear()
  }

  const onLine = (line: string) => {
    let message: { id?: unknown; ok?: unknown; result?: unknown; error?: DomainErrorPayload }
    try {
      message = JSON.parse(line) as typeof message
    } catch {
      return
    }
    if (typeof message.id !== 'number') return
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    if (message.ok === true) entry.resolve(message.result)
    else {
      const error = message.error ?? { code: 'internal', message: 'resposta sem erro' }
      entry.reject(new DomainError(error.code, error.message, error.details))
    }
  }

  const ensure = (): Promise<Socket> => {
    if (closed) return Promise.reject(new DomainError('unavailable', 'cliente da ponte fechado'))
    if (socket && !socket.destroyed) return Promise.resolve(socket)
    if (connecting) return connecting
    connecting = new Promise<Socket>((resolve, reject) => {
      const next = connect(options.socketPath)
      next.once('connect', () => {
        socket = next
        connecting = null
        resolve(next)
      })
      next.once('error', (error) => {
        connecting = null
        reject(new DomainError('unavailable', `ponte MCP indisponivel: ${error.message}`))
      })
      next.on('close', () => {
        if (socket === next) socket = null
        rejectAll(new DomainError('unavailable', 'conexao com o app caiu'))
      })
      readLines(next, onLine, () => next.destroy())
    })
    return connecting
  }

  const send = async <T>(build: (id: number) => McpBridgeRequest): Promise<T> => {
    const conn = await ensure()
    const id = nextId++
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
      writeLine(conn, build(id))
    })
  }

  return {
    hello() {
      return send<McpHelloResult>((id) => ({
        v: MCP_BRIDGE_PROTOCOL_VERSION,
        id,
        token: options.token,
        method: 'hello',
      }))
    },
    callTool(name: McpToolName, args: unknown) {
      return send<McpToolResult>((id) => ({
        v: MCP_BRIDGE_PROTOCOL_VERSION,
        id,
        token: options.token,
        method: 'tool.call',
        params: { name, arguments: args ?? {} },
      }))
    },
    close() {
      closed = true
      rejectAll(new DomainError('unavailable', 'cliente da ponte fechado'))
      socket?.destroy()
      socket = null
    },
  }
}
