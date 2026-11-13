import type { Socket } from 'node:net'
import { MCP_BRIDGE_MAX_FRAME_BYTES } from '@shared/mcp'

/**
 * Le linhas NDJSON de um socket. Uma linha maior que MCP_BRIDGE_MAX_FRAME_BYTES
 * (sem '\n' ate la) chama onOverflow e para de ler: quem chama fecha a conexao.
 */
export function readLines(
  socket: Socket,
  onLine: (line: string) => void,
  onOverflow: () => void,
  maxBytes = MCP_BRIDGE_MAX_FRAME_BYTES,
): void {
  let chunks: Buffer[] = []
  let pending = 0
  let dead = false
  socket.on('data', (data: Buffer) => {
    if (dead) return
    let start = 0
    for (let i = data.indexOf(10); i !== -1; i = data.indexOf(10, start)) {
      const piece = data.subarray(start, i)
      if (pending + piece.length > maxBytes) {
        dead = true
        onOverflow()
        return
      }
      const line = Buffer.concat([...chunks, piece]).toString('utf8')
      chunks = []
      pending = 0
      start = i + 1
      if (line.trim() !== '') onLine(line)
    }
    const rest = data.subarray(start)
    if (rest.length > 0) {
      pending += rest.length
      if (pending > maxBytes) {
        dead = true
        onOverflow()
        return
      }
      chunks.push(Buffer.from(rest))
    }
  })
}

export function writeLine(socket: Socket, message: unknown): void {
  if (socket.destroyed || !socket.writable) return
  socket.write(`${JSON.stringify(message)}\n`)
}
