// Roda o vitest dentro do Node embutido no Electron (ELECTRON_RUN_AS_NODE=1).
// Assim os modulos nativos (node-pty, better-sqlite3) usam a mesma ABI do app
// e nenhum teste precisa de uma segunda compilacao para o Node do sistema.
// ELECTRON_RUN_AS_NODE nao cria janela nem precisa de display.
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const electronBinary = require('electron')
const vitestEntry = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs')

const child = spawn(electronBinary, [vitestEntry, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ECLIPSE_CODE_ENV: 'test' },
})
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  process.exit(code ?? 1)
})
