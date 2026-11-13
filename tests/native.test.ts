// Prova que os modulos nativos carregam na ABI do Electron. O vitest roda dentro
// do Node do Electron (scripts/vitest-electron.mjs), sem janela.
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import type BetterSqlite3 from 'better-sqlite3'
import type * as NodePty from 'node-pty'

const require = createRequire(import.meta.url)

describe('modulos nativos no Electron', () => {
  it('roda dentro do Node do Electron', () => {
    expect(process.versions.electron).toMatch(/^41\./)
  })

  it('better-sqlite3 abre banco e grava', () => {
    const Database = require('better-sqlite3') as typeof BetterSqlite3
    const db = new Database(':memory:')
    db.exec('create table t (id integer primary key, v text not null)')
    db.prepare('insert into t (v) values (?)').run('ok')
    expect(db.prepare('select v from t').get()).toEqual({ v: 'ok' })
    db.close()
  })

  it('node-pty abre um shell e le a saida', async () => {
    const pty = require('node-pty') as typeof NodePty
    const p = pty.spawn('/bin/sh', ['-c', 'printf eclipse-ok'], { cols: 80, rows: 24 })
    let out = ''
    p.onData((d) => {
      out += d
    })
    const exitCode = await new Promise<number>((resolve) => p.onExit((e) => resolve(e.exitCode)))
    expect(exitCode).toBe(0)
    expect(out).toContain('eclipse-ok')
  })
})
