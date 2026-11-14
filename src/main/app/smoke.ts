/**
 * Modo --smoke: prova que o app (inclusive o empacotado) sobe de verdade, sem janela
 * visivel. Confere o SQLite aberto, um pty real do node-pty e o servidor MCP stdio
 * (ELECTRON_RUN_AS_NODE=1 + script dentro do app.asar) respondendo a initialize e
 * tools/list pela ponte. Sem Electron aqui: o index.ts so chama e sai com o codigo.
 */
import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type { AppPaths } from '@shared/app'
import { waitForPtyExit } from '../terminal'
import type { AppServices } from './services'

export interface SmokeCheck {
  name: 'sqlite' | 'node-pty' | 'mcp-server'
  ok: boolean
  detail: Record<string, unknown>
}

export interface SmokeReport {
  ok: boolean
  checks: SmokeCheck[]
}

const PTY_MARKER = 'eclipse-pty-ok'
const STEP_TIMEOUT_MS = 15_000

export async function runSmokeChecks(
  services: AppServices,
  paths: Pick<AppPaths, 'database'>,
): Promise<SmokeReport> {
  const checks = [
    await guard('sqlite', () => checkSqlite(services, paths)),
    await guard('node-pty', () => checkPty(services)),
    await guard('mcp-server', () => checkMcpServer(services)),
  ]
  return { ok: checks.every((check) => check.ok), checks }
}

async function guard(
  name: SmokeCheck['name'],
  run: () => Promise<Record<string, unknown>> | Record<string, unknown>,
): Promise<SmokeCheck> {
  try {
    return { name, ok: true, detail: await run() }
  } catch (error) {
    return {
      name,
      ok: false,
      detail: { error: error instanceof Error ? error.message : String(error) },
    }
  }
}

function checkSqlite(services: AppServices, paths: Pick<AppPaths, 'database'>) {
  if (!existsSync(paths.database)) throw new Error(`banco ausente: ${paths.database}`)
  // Consulta de verdade no store aberto (migracoes ja rodaram na partida).
  const pendingNotices = services.tasks.listTasksWithPendingLeaderNotices().length
  return { database: paths.database, bytes: statSync(paths.database).size, pendingNotices }
}

async function checkPty(services: AppServices) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] != null),
  )
  delete env['ELECTRON_RUN_AS_NODE']
  const win = process.platform === 'win32'
  const info = await services.ptyHost.spawn({
    command: win ? 'cmd.exe' : '/bin/sh',
    args: win ? ['/d', '/c', `echo ${PTY_MARKER}`] : ['-c', `printf ${PTY_MARKER}`],
    cwd: tmpdir(),
    env,
    cols: 80,
    rows: 24,
    label: 'smoke',
  })
  const exit = await waitForPtyExit(services.ptyHost, info.ptyId, STEP_TIMEOUT_MS)
  const output = services.ptyHost.scrollback(info.ptyId).trim()
  if (!output.includes(PTY_MARKER)) {
    services.ptyHost.kill(info.ptyId, 'SIGKILL')
    throw new Error(`pty nao devolveu o marcador (saida: ${JSON.stringify(output)})`)
  }
  return { pid: info.pid, output, exitCode: exit?.exitCode ?? null }
}

async function checkMcpServer(services: AppServices) {
  const sessionId = 'smoke-session'
  const token = services.bridge.issueToken({
    role: 'leader',
    sessionId,
    taskId: 'smoke-task',
    subtaskId: null,
  })
  const launch = services.bridge.launchSpec(token)
  const child = spawn(launch.command, launch.args, {
    env: { ...process.env, ...launch.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
  const responses = new Map<number, (message: Record<string, unknown>) => void>()
  let buffer = ''
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString()
    let newline = buffer.indexOf('\n')
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      newline = buffer.indexOf('\n')
      if (!line) continue
      const message = JSON.parse(line) as Record<string, unknown>
      if (typeof message.id === 'number') responses.get(message.id)?.(message)
    }
  })
  const exited = new Promise<never>((_, reject) =>
    child.once('exit', (code, signal) =>
      reject(new Error(`servidor MCP saiu (code ${code}, signal ${signal}): ${stderr.trim()}`)),
    ),
  )
  exited.catch(() => undefined)
  const request = (id: number, method: string, params: Record<string, unknown>) => {
    const reply = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`${method} sem resposta em ${STEP_TIMEOUT_MS} ms: ${stderr}`)),
        STEP_TIMEOUT_MS,
      )
      responses.set(id, (message) => {
        clearTimeout(timer)
        if (message.error) reject(new Error(`${method}: ${JSON.stringify(message.error)}`))
        else resolve(message.result as Record<string, unknown>)
      })
    })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    return Promise.race([reply, exited])
  }
  try {
    const init = await request(1, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'eclipse-smoke', version: '0.0.0' },
    })
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
    )
    const list = await request(2, 'tools/list', {})
    const tools = ((list.tools as { name: string }[] | undefined) ?? []).map((tool) => tool.name)
    if (tools.length === 0) throw new Error('tools/list voltou vazio')
    return {
      command: launch.command,
      script: launch.args[0],
      serverInfo: init.serverInfo,
      protocolVersion: init.protocolVersion,
      tools,
    }
  } finally {
    child.stdin.end()
    if (child.exitCode === null) child.kill('SIGKILL')
    services.bridge.revokeSession(sessionId)
  }
}
