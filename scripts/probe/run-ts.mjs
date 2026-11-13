// Roda um script TypeScript do repo com os mesmos aliases do app (@shared), usando o
// runnerImport do Vite. Uso: node scripts/probe/run-ts.mjs scripts/acp-probe.ts [args]
import { resolve } from 'node:path'
import { runnerImport } from 'vite'

const [file] = process.argv.slice(2)
if (!file) {
  console.error('uso: node scripts/probe/run-ts.mjs <arquivo.ts> [args]')
  process.exit(2)
}
const root = resolve(import.meta.dirname, '../..')
const { module } = await runnerImport(resolve(file), {
  root,
  configFile: false,
  logLevel: 'warn',
  resolve: { alias: { '@shared': resolve(root, 'src/shared') } },
})
if (typeof module.main === 'function') {
  process.exitCode = await module.main(process.argv.slice(3))
}
