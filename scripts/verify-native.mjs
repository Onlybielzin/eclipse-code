// Prova que node-pty e better-sqlite3 carregam no Node do Electron, sem janela.
// Uso: pnpm verify:native
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const electronBinary = require('electron')

const probe = `
const Database = require('better-sqlite3')
const db = new Database(':memory:')
const row = db.prepare("select sqlite_version() as v").get()
const pty = require('node-pty')
const p = pty.spawn('/bin/sh', ['-c', 'printf ok'], { cols: 80, rows: 24 })
let out = ''
p.onData((d) => { out += d })
p.onExit(({ exitCode }) => {
  console.log(JSON.stringify({ electron: process.versions.electron, modules: process.versions.modules, sqlite: row.v, ptyOutput: out.trim(), exitCode }))
  process.exit(out.includes('ok') && exitCode === 0 ? 0 : 1)
})
`
const r = spawnSync(electronBinary, ['-e', probe], {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
})
process.exit(r.status ?? 1)
