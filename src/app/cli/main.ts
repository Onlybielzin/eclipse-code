import { run } from './core/run'
import { createNodeCliIo } from './core/io'

if (process.argv[2] === 'mcp') {
  // Stdio MCP server for agents inside Eclipse Code (see ./mcp/server.ts).
  const { runMcpServer } = await import('./mcp/server')
  process.exitCode = await runMcpServer()
} else {
  const io = createNodeCliIo()
  try {
    process.exitCode = await run(process.argv.slice(2), io)
  } finally {
    io.dispose?.()
  }
}
