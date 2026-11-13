/**
 * Entrada do build do servidor MCP stdio (out/main/mcp-server.js). Roda como
 * processo filho do agente com ELECTRON_RUN_AS_NODE=1; nao importa Electron.
 */
import { runStdioMcpServer } from './stdioServer'

void runStdioMcpServer().catch((error: unknown) => {
  process.stderr.write(
    `servidor MCP do Eclipse falhou: ${error instanceof Error ? error.message : String(error)}\n`,
  )
  process.exit(1)
})
