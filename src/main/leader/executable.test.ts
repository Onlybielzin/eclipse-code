import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveExecutableOnPath, wrapWindowsScript } from './executable'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(files: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'exe-'))
  dirs.push(dir)
  // Sem bit de execucao: no Windows X_OK nao conta.
  for (const file of files) writeFileSync(join(dir, file), '', { mode: 0o644 })
  return dir
}

describe('resolveExecutableOnPath no win32', () => {
  it('aceita alias de app que o stat nao segue (WindowsApps\\wt.exe)', () => {
    const dir = tempDir([])
    symlinkSync(join(dir, 'nao-existe'), join(dir, 'wt.exe'))
    expect(resolveExecutableOnPath('wt.exe', dir, { platform: 'win32' })).toBe(join(dir, 'wt.exe'))
    expect(resolveExecutableOnPath('wt.exe', dir, { platform: 'linux' })).toBeNull()
  })


  it('prefere .exe a .cmd pela ordem do PATHEXT e nao exige X_OK', () => {
    const dir = tempDir(['claude.cmd', 'claude.exe'])
    // PATHEXT em minusculas: o sistema de arquivos do Linux diferencia caixa; o do Windows nao.
    const found = resolveExecutableOnPath('claude', dir, {
      platform: 'win32',
      pathExt: '.com;.exe;.bat;.cmd',
    })
    expect(found).toBe(join(dir, 'claude.exe'))
  })

  it('usa o PATHEXT informado', () => {
    const dir = tempDir(['claude.cmd', 'claude.exe'])
    const found = resolveExecutableOnPath('claude', dir, {
      platform: 'win32',
      pathExt: '.cmd;.exe',
    })
    expect(found).toBe(join(dir, 'claude.cmd'))
  })

  it('aceita barra invertida como caminho e nao acha sem extensao', () => {
    const dir = tempDir(['outro'])
    expect(
      resolveExecutableOnPath('C:\\nao\\existe\\claude', dir, { platform: 'win32' }),
    ).toBeNull()
    expect(resolveExecutableOnPath('outro', dir, { platform: 'win32' })).toBeNull()
  })

  it('no Linux continua exigindo X_OK e nao tenta extensoes', () => {
    const dir = tempDir(['claude.exe'])
    expect(resolveExecutableOnPath('claude', dir, { platform: 'linux' })).toBeNull()
  })
})

const SHIM = (rel: string): string =>
  [
    '@ECHO off',
    'GOTO start',
    ':find_dp0',
    'SET dp0=%~dp0',
    'EXIT /b',
    ':start',
    'SETLOCAL',
    'CALL :find_dp0',
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ') ELSE (',
    '  SET "_prog=node"',
    ')',
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${rel}" %*`,
    '',
  ].join('\r\n')

describe('resolveExecutableOnPath: PATHEXT e aspas', () => {
  it('PATHEXT vazio usa o padrao .COM;.EXE;.BAT;.CMD', () => {
    const dir = tempDir(['a.EXE'])
    expect(resolveExecutableOnPath('a', dir, { platform: 'win32', pathExt: ';' })).toBe(
      join(dir, 'a.EXE'),
    )
  })

  it('tira aspas das entradas do PATH no win32', () => {
    const dir = tempDir(['a.exe'])
    const found = resolveExecutableOnPath('a', `"${dir}"`, { platform: 'win32', pathExt: '.exe' })
    expect(found).toBe(join(dir, 'a.exe'))
  })
})

describe('wrapWindowsScript', () => {
  const setup = () => {
    const dir = tempDir([])
    const bin = join(dir, 'Arquivos de Programa', 'npm')
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'codex.CMD'), SHIM('node_modules\\@openai\\codex\\bin\\codex.js'))
    writeFileSync(join(bin, 'node.EXE'), '')
    return { bin, cmd: join(bin, 'codex.CMD') }
  }

  it('shim do npm roda node.exe com o .js absoluto e args intactos', () => {
    const { bin, cmd } = setup()
    const args = ['-p', 'a & b | c %PATH% "x"\nlinha 2', '--mcp-config', '{"a":"&"}']
    const run = wrapWindowsScript(cmd, args, bin, 'win32')
    expect(run.command).toBe(join(bin, 'node.EXE'))
    expect(run.args).toEqual([
      join(bin, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
      ...args,
    ])
  })

  it('shim com alvo .exe roda o .exe com os args, sem node', () => {
    const { bin, cmd } = setup()
    writeFileSync(cmd, '@"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe" %*\r\n')
    expect(wrapWindowsScript(cmd, ['-p', 'a & b'], '', 'win32')).toEqual({
      command: join(bin, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
      args: ['-p', 'a & b'],
    })
  })

  it('aceita a forma %~dp0', () => {
    const { bin, cmd } = setup()
    writeFileSync(cmd, '@"%~dp0\\lib\\cli.js" %*\r\n')
    expect(wrapWindowsScript(cmd, [], bin, 'win32').args).toEqual([join(bin, 'lib', 'cli.js')])
  })

  it('.cmd que nao e shim ou sem node no PATH vira erro unavailable', () => {
    const { bin, cmd } = setup()
    writeFileSync(join(bin, 'x.CMD'), '@echo oi\r\n')
    expect(() => wrapWindowsScript(join(bin, 'x.CMD'), [], bin, 'win32')).toThrow(/versão nativa/)
    expect(() => wrapWindowsScript(cmd, [], '', 'win32')).toThrow(/node no PATH/)
    try {
      wrapWindowsScript(cmd, [], '', 'win32')
    } catch (error) {
      expect(error).toMatchObject({ code: 'unavailable' })
    }
  })

  it('deixa .exe e outras plataformas como estao', () => {
    expect(wrapWindowsScript('C:\\bin\\claude.exe', ['a'], undefined, 'win32')).toEqual({
      command: 'C:\\bin\\claude.exe',
      args: ['a'],
    })
    expect(wrapWindowsScript('/x/claude.cmd', ['a'], undefined, 'linux').command).toBe(
      '/x/claude.cmd',
    )
  })
})
