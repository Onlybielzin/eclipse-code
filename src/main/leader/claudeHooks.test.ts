import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildClaudeHookSettings, claudeHookPaths, writeClaudeHookFiles } from './claudeHooks'
import { writeInbox } from './inbox'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const commandOf = (settings: object): string =>
  (settings as { hooks: Record<string, { hooks: { command: string }[] }[]> }).hooks['Stop']![0]!
    .hooks[0]!.command

describe('ganchos do Claude', () => {
  const paths = claudeHookPaths('/run/hooks', 's1')

  it('no Linux usa /usr/bin/env com aspas POSIX', () => {
    const command = commandOf(buildClaudeHookSettings('/opt/app', paths, 'linux'))
    expect(command).toBe(
      `'/usr/bin/env' 'ELECTRON_RUN_AS_NODE=1' '/opt/app' '${paths.script}' '${paths.events}'`,
    )
  })

  it('no win32 aponta para o .cmd, sem /usr/bin/env', () => {
    const command = commandOf(buildClaudeHookSettings('C:\\app\\Eclipse.exe', paths, 'win32'))
    expect(command).not.toContain('/usr/bin/env')
    expect(command).toBe(`"${paths.launcher}"`)
  })

  it('no win32 escreve o caminho do .cmd com barra normal', () => {
    const winPaths = { ...paths, launcher: 'C:\\Users\\Jo\u00e3o\\hooks\\hook.cmd' }
    expect(commandOf(buildClaudeHookSettings('C:\\app\\E.exe', winPaths, 'win32'))).toBe(
      '"C:/Users/Jo\u00e3o/hooks/hook.cmd"',
    )
  })

  it('dobra % nos caminhos do .cmd e mantem acento', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hooks-'))
    dirs.push(root)
    const win = claudeHookPaths(root, 'p')
    await writeClaudeHookFiles(win, 'C:\\Users\\Jo\u00e3o\\100%\\E.exe', 'win32')
    const text = readFileSync(win.launcher, 'utf8')
    expect(text).toContain('"C:\\Users\\Jo\u00e3o\\100%%\\E.exe"')
    expect(text.startsWith('@echo off\r\n@chcp 65001 >nul\r\n')).toBe(true)
  })

  it('grava o .cmd so no win32, com a variavel e o executavel entre aspas duplas', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hooks-'))
    dirs.push(root)
    const win = claudeHookPaths(root, 'w')
    await writeClaudeHookFiles(win, 'C:\\Program Files\\Eclipse\\Eclipse.exe', 'win32')
    expect(readFileSync(win.launcher, 'utf8')).toBe(
      `@echo off\r\n@chcp 65001 >nul\r\n@set ELECTRON_RUN_AS_NODE=1\r\n"C:\\Program Files\\Eclipse\\Eclipse.exe" "${win.script}" "${win.events}"\r\n`,
    )
    const linux = claudeHookPaths(root, 'l')
    await writeClaudeHookFiles(linux, '/opt/app', 'linux')
    expect(() => readFileSync(linux.launcher)).toThrow()
  })

  it('SessionStart entrega a caixa como additionalContext e grava NoticesDelivered', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hooks-'))
    dirs.push(root)
    const linux = claudeHookPaths(root, 'ss')
    await writeClaudeHookFiles(linux, process.execPath, 'linux')
    await writeInbox(linux, [{ id: 7, text: '[eclipse] o app reiniciou' }])
    const run = spawnSync(process.execPath, [linux.script, linux.events], {
      input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 's', source: 'resume' }),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      encoding: 'utf8',
    })
    expect(JSON.parse(run.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: '[eclipse] o app reiniciou',
      },
    })
    const lines = readFileSync(linux.events, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { event: string; ids?: number[] })
    expect(lines.map((l) => l.event)).toEqual(['NoticesDelivered', 'SessionStart'])
    expect(lines[0]?.ids).toEqual([7])
  })
})
