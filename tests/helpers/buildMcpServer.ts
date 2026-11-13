// Gera o servidor MCP stdio (src/main/mcp/server.ts) como o electron-vite faz no build, para os
// testes de ponta a ponta nao dependerem de um out/ antigo. Dependencias ficam externas e sao
// resolvidas pelo node_modules do repo (a saida fica em node_modules/.cache).
import { join, resolve } from 'node:path'
import { build } from 'vite'

const ROOT = resolve(__dirname, '../..')

export async function buildMcpServerForTests(): Promise<string> {
  const outDir = join(ROOT, 'node_modules/.cache/eclipse-test-mcp', String(process.pid))
  await build({
    configFile: false,
    root: ROOT,
    logLevel: 'silent',
    resolve: { alias: { '@shared': join(ROOT, 'src/shared') } },
    build: {
      ssr: join(ROOT, 'src/main/mcp/server.ts'),
      outDir,
      emptyOutDir: true,
      minify: false,
      target: 'node22',
      rollupOptions: { output: { format: 'cjs', entryFileNames: 'mcp-server.cjs' } },
    },
  })
  return join(outDir, 'mcp-server.cjs')
}
