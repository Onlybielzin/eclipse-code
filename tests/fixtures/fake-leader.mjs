/* global process, setTimeout */
// Lider FALSO (no lugar do `claude` no PATH) para o teste de ponta a ponta. Nunca chama modelo.
//
// - Le --mcp-config como o Claude Code e abre o servidor MCP do app (stdio).
// - Cria as subtarefas do plano com subtarefa_criar e espera com subtarefas_esperar.
//   Plano: FAKE_LEADER_PLAN (JSON [{papel,titulo,instrucoes}]); ao retomar (--resume),
//   FAKE_LEADER_PLAN_RESUME.
// - Liga o bracketed paste, roda os ganchos do --settings (SessionStart, UserPromptSubmit,
//   Stop) e registra cada texto colado no terminal em FAKE_LOG ({kind:'prompt'}).
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const argv = process.argv.slice(2)
const log = process.env.FAKE_LOG
const write = (record) => {
  if (log) appendFileSync(log, JSON.stringify({ pid: process.pid, ...record }) + '\n')
}
const valueAfter = (flag) => {
  const index = argv.indexOf(flag)
  return index >= 0 ? argv[index + 1] : undefined
}

const resumed = valueAfter('--resume') !== undefined
const settingsPath = valueAfter('--settings')
const hooks = settingsPath ? JSON.parse(readFileSync(settingsPath, 'utf8')).hooks : {}
const sessionId = valueAfter('--session-id') || valueAfter('--resume') || null
const runHook = (event, extra = {}) => {
  const command = hooks?.[event]?.[0]?.hooks?.[0]?.command
  if (!command) return
  spawnSync('/bin/sh', ['-c', command], {
    input: JSON.stringify({ hook_event_name: event, session_id: sessionId, ...extra }),
    stdio: ['pipe', 'ignore', 'ignore'],
  })
}

// Como o Claude: transcript em <config>/projects/<cwd codificado>/<id>.jsonl, que o app
// confere antes de --resume. Sem a pasta, a retomada falha como "No conversation found".
const claudeConfig = process.env.FAKE_CLAUDE_CONFIG_DIR
if (claudeConfig && sessionId) {
  const dir = join(claudeConfig, 'projects', resolve(process.cwd()).replace(/[^A-Za-z0-9]/g, '-'))
  const transcript = join(dir, `${sessionId}.jsonl`)
  if (resumed) {
    try {
      readFileSync(transcript)
    } catch {
      process.stderr.write(`No conversation found with session ID: ${sessionId}\n`)
      process.exit(1)
    }
  } else {
    mkdirSync(dir, { recursive: true })
    writeFileSync(transcript, '{}\n')
  }
}

write({
  kind: 'start',
  argv,
  resumed,
  marker: process.env.ECLIPSE_NEXT_ENV ?? null,
  tokenInEnv: Boolean(process.env.ECLIPSE_NEXT_MCP_TOKEN),
})
process.stdout.write('lider falso pronto\r\n')
process.stdout.write('\x1b[?2004h')
runHook('SessionStart', { source: resumed ? 'resume' : 'startup' })

// Terminal: le o que o app cola (avisos de fim de turno).
if (process.stdin.isTTY) process.stdin.setRawMode(true)
let buffer = ''
let pasted = null
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  for (;;) {
    const start = buffer.indexOf('\x1b[200~')
    const end = buffer.indexOf('\x1b[201~')
    if (start !== -1 && end > start) {
      pasted = buffer.slice(start + 6, end)
      buffer = buffer.slice(end + 6)
      continue
    }
    const enter = buffer.indexOf('\r')
    if (enter === -1) break
    buffer = buffer.slice(enter + 1)
    if (pasted !== null) {
      const text = pasted
      pasted = null
      runHook('UserPromptSubmit', { prompt: text })
      write({ kind: 'prompt', text })
      process.stdout.write(`recebido: ${text.split('\n')[0]}\r\n`)
      setTimeout(() => runHook('Stop'), 50)
    }
  }
})

// MCP: o mesmo JSON que o Claude Code recebe em --mcp-config.
async function runPlan() {
  const raw = valueAfter('--mcp-config')
  if (!raw) throw new Error('sem --mcp-config')
  const servers = JSON.parse(raw).mcpServers
  const [name, server] = Object.entries(servers)[0]
  const transport = new StdioClientTransport({
    command: server.command,
    args: server.args,
    env: { ...process.env, ...server.env },
    stderr: 'pipe',
  })
  const client = new Client({ name: 'fake-leader', version: '0.0.0' })
  await client.connect(transport)
  const tools = (await client.listTools()).tools.map((t) => t.name)
  write({ kind: 'mcp', server: name, tools })

  const plan = JSON.parse(
    (resumed ? process.env.FAKE_LEADER_PLAN_RESUME : process.env.FAKE_LEADER_PLAN) || '[]',
  )
  const ids = []
  for (const step of plan) {
    const result = await client.callTool({ name: 'subtarefa_criar', arguments: step })
    const text = (result.content ?? []).map((c) => c.text ?? '').join(' ')
    write({ kind: 'tool', name: 'subtarefa_criar', isError: result.isError ?? false, text })
    const id = result.structuredContent?.id
    if (id) ids.push(id)
  }
  if (ids.length > 0) {
    const result = await client.callTool({
      name: 'subtarefas_esperar',
      arguments: { subtarefa_ids: ids, timeout_segundos: 60 },
    })
    const text = (result.content ?? []).map((c) => c.text ?? '').join(' ')
    write({ kind: 'tool', name: 'subtarefas_esperar', isError: result.isError ?? false, text })
  }
  write({ kind: 'plan-done', ids })
}

runPlan().catch((error) => write({ kind: 'plan-error', message: String(error?.stack ?? error) }))
