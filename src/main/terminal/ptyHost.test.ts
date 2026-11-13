import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { PtyExit, PtyHost } from '@shared/ports'
import { DomainError } from '@shared/domain'
import { createPtyHost, waitForPtyExit } from './ptyHost'

const hosts: PtyHost[] = []
const dirs: string[] = []

function makeHost(options: Parameters<typeof createPtyHost>[0] = {}): PtyHost {
  const host = createPtyHost({ killGraceMs: 500, disposeTimeoutMs: 2000, ...options })
  hosts.push(host)
  return host
}

function baseEnv(): Record<string, string> {
  return { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: process.env['HOME'] ?? '/tmp' }
}

function waitForOutput(
  host: PtyHost,
  ptyId: string,
  needle: string,
  timeoutMs = 5000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const check = (): boolean => {
      const text = host.scrollback(ptyId)
      if (text.includes(needle)) {
        resolve(text)
        return true
      }
      return false
    }
    if (check()) return
    const timer = setTimeout(() => {
      stop()
      reject(
        new Error(
          `timeout esperando "${needle}"; saida: ${JSON.stringify(host.scrollback(ptyId))}`,
        ),
      )
    }, timeoutMs)
    const stop = host.onData((id) => {
      if (id === ptyId && check()) {
        clearTimeout(timer)
        stop()
      }
    })
  })
}

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.dispose()))
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('createPtyHost com /bin/sh', () => {
  it('abre, recebe escrita, devolve saida e registra a saida do processo', async () => {
    const host = makeHost()
    const cwd = mkdtempSync(join(tmpdir(), 'pty-host-'))
    dirs.push(cwd)
    const seen: string[] = []
    host.onData((_id, data) => seen.push(data))
    const exits: Array<[string, PtyExit]> = []
    host.onExit((id, exit) => exits.push([id, exit]))

    const { ptyId, pid } = await host.spawn({
      command: '/bin/sh',
      args: [],
      cwd,
      env: { ...baseEnv(), PS1: '$ ' },
      cols: 100,
      rows: 30,
      label: 'teste',
    })
    expect(pid).toBeGreaterThan(0)
    expect(host.isAlive(ptyId)).toBe(true)
    expect(host.liveCount()).toBe(1)
    expect(host.size(ptyId)).toEqual({ cols: 100, rows: 30 })

    host.write(ptyId, 'echo "ola-$((20+22))"; pwd; echo fim-$((1+1))\r')
    const output = await waitForOutput(host, ptyId, 'fim-2')
    expect(output).toContain('ola-42')
    expect(output).toContain(cwd)
    expect(seen.join('')).toContain('ola-42')

    host.resize(ptyId, 120, 40)
    expect(host.size(ptyId)).toEqual({ cols: 120, rows: 40 })
    host.write(ptyId, 'stty size\r')
    await waitForOutput(host, ptyId, '40 120')

    const exitPromise = waitForPtyExit(host, ptyId, 5000)
    host.write(ptyId, 'exit 7\r')
    const exit = await exitPromise
    expect(exit).toEqual({ exitCode: 7, signal: null })
    expect(host.isAlive(ptyId)).toBe(false)
    expect(host.liveCount()).toBe(0)
    expect(exits).toEqual([[ptyId, { exitCode: 7, signal: null }]])
    // scrollback continua disponivel depois da saida
    expect(host.scrollback(ptyId)).toContain('ola-42')
    // escrita depois da saida e ignorada sem erro
    expect(() => host.write(ptyId, 'nada\r')).not.toThrow()
  })

  it('passa o ambiente limpo ao processo', async () => {
    const host = makeHost()
    const { ptyId } = await host.spawn({
      command: '/bin/sh',
      args: ['-c', 'echo "marca=$ECLIPSE_NEXT_ENV pai=${CLAUDECODE:-nao} term=$TERM"'],
      cwd: tmpdir(),
      env: { ...baseEnv(), ECLIPSE_NEXT_ENV: '1', CLAUDECODE: '1' },
      cols: 80,
      rows: 24,
    })
    await waitForOutput(host, ptyId, 'term=xterm-256color')
    expect(host.scrollback(ptyId)).toContain('marca=1 pai=nao')
  })

  it('kill encerra o grupo inteiro e conta como nao vivo', async () => {
    const host = makeHost()
    const { ptyId } = await host.spawn({
      command: '/bin/sh',
      // O filho ignora SIGHUP: o host precisa escalar para SIGKILL.
      args: ['-c', "trap '' HUP; echo pronto; sleep 30"],
      cwd: tmpdir(),
      env: baseEnv(),
      cols: 80,
      rows: 24,
    })
    await waitForOutput(host, ptyId, 'pronto')
    expect(host.liveCount()).toBe(1)
    const exitPromise = waitForPtyExit(host, ptyId, 5000)
    host.kill(ptyId)
    const exit = await exitPromise
    expect(exit).not.toBeNull()
    expect(exit?.signal).toBe('SIGKILL')
    expect(host.liveCount()).toBe(0)
  })

  it('kill escala para SIGKILL no grupo mesmo depois que o processo principal saiu', async () => {
    const host = makeHost()
    const { ptyId } = await host.spawn({
      command: '/bin/sh',
      // O sh sai com SIGTERM; o neto no mesmo grupo ignora TERM e HUP (servidor de dev,
      // `pnpm test` aberto pelo agente).
      args: ['-c', `sh -c "trap '' TERM HUP; exec sleep 30" & echo "neto:$!"; wait`],
      cwd: tmpdir(),
      env: baseEnv(),
      cols: 80,
      rows: 24,
    })
    const out = await waitForOutput(host, ptyId, 'neto:')
    await new Promise((r) => setTimeout(r, 100))
    const pid = Number(/neto:(\d+)/.exec(host.scrollback(ptyId) || out)?.[1])
    expect(pid).toBeGreaterThan(0)
    const alive = () => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    try {
      const exitPromise = waitForPtyExit(host, ptyId, 5000)
      host.kill(ptyId, 'SIGTERM')
      expect(await exitPromise).not.toBeNull()
      // killGraceMs = 500: o neto precisa receber SIGKILL logo depois.
      const until = Date.now() + 2_000
      while (alive() && Date.now() < until) await new Promise((r) => setTimeout(r, 25))
      expect(alive()).toBe(false)
    } finally {
      if (alive()) process.kill(pid, 'SIGKILL')
    }
  })

  it('conta varios vivos e dispose encerra todos', async () => {
    const host = makeHost()
    const spawned = await Promise.all(
      [1, 2, 3].map(() =>
        host.spawn({
          command: '/bin/sh',
          args: ['-c', 'sleep 30'],
          cwd: tmpdir(),
          env: baseEnv(),
          cols: 80,
          rows: 24,
        }),
      ),
    )
    expect(host.liveCount()).toBe(3)
    await host.dispose()
    for (const { ptyId } of spawned) expect(host.isAlive(ptyId)).toBe(false)
    expect(host.liveCount()).toBe(0)
    await expect(
      host.spawn({
        command: '/bin/sh',
        args: [],
        cwd: tmpdir(),
        env: baseEnv(),
        cols: 80,
        rows: 24,
      }),
    ).rejects.toBeInstanceOf(DomainError)
  })

  it('erro de spawn vira DomainError unavailable', async () => {
    const host = makeHost({
      spawnPty: () => {
        throw new Error('falhou')
      },
    })
    await expect(
      host.spawn({
        command: 'nao-existe',
        args: [],
        cwd: tmpdir(),
        env: baseEnv(),
        cols: 80,
        rows: 24,
      }),
    ).rejects.toMatchObject({ code: 'unavailable' })
  })

  it('id desconhecido nao quebra', () => {
    const host = makeHost()
    expect(host.scrollback('x')).toBe('')
    expect(host.size('x')).toBeNull()
    expect(host.isAlive('x')).toBe(false)
    expect(() => {
      host.write('x', 'a')
      host.resize('x', 10, 10)
      host.kill('x')
    }).not.toThrow()
  })
})
