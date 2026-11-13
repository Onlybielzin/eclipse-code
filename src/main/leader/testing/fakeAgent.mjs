/* global process, setTimeout */
// Agente falso (Claude ou Codex) para os testes do Lider. Nao gasta modelo.
// Le o prompt colado com bracketed paste, registra tudo em FAKE_LOG e roda os
// ganchos do --settings como o Claude faria (SessionStart, UserPromptSubmit, Stop).
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const argv = process.argv.slice(2)
const log = process.env.FAKE_LOG
const mode = process.env.FAKE_MODE || 'normal'
const write = (record) => {
  if (log) appendFileSync(log, JSON.stringify(record) + '\n')
}
const valueAfter = (flag) => {
  const index = argv.indexOf(flag)
  return index >= 0 ? argv[index + 1] : undefined
}

const settingsPath = valueAfter('--settings')
const hooks = settingsPath ? JSON.parse(readFileSync(settingsPath, 'utf8')).hooks : {}
const sessionId =
  process.env.FAKE_REPORTED_SESSION || valueAfter('--session-id') || valueAfter('--resume') || null
const runHook = (event, extra = {}) => {
  const command = hooks?.[event]?.[0]?.hooks?.[0]?.command
  if (!command) return
  spawnSync('/bin/sh', ['-c', command], {
    input: JSON.stringify({ hook_event_name: event, session_id: sessionId, ...extra }),
    stdio: ['pipe', 'ignore', 'ignore'],
  })
}

write({
  kind: 'start',
  argv,
  todo: process.env.CLAUDE_CODE_ENABLE_TODO_TOOLS ?? null,
  marker: process.env.ECLIPSE_NEXT_ENV ?? null,
  electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null,
})
// Codex falso: grava um rollout como o ~/.codex/sessions real.
let rollout = null
if (process.env.FAKE_CODEX_HOME) {
  const now = new Date()
  const dir = join(
    process.env.FAKE_CODEX_HOME,
    'sessions',
    String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  )
  mkdirSync(dir, { recursive: true })
  const id = process.env.FAKE_CODEX_ID || 'th-falso'
  rollout = join(dir, `rollout-${now.getTime()}-${id}.jsonl`)
  appendFileSync(
    rollout,
    JSON.stringify({
      type: 'session_meta',
      timestamp: now.toISOString(),
      payload: { id, cwd: process.cwd(), timestamp: now.toISOString() },
    }) + '\n',
  )
}
const rolloutEvent = (type) => {
  if (rollout)
    appendFileSync(rollout, JSON.stringify({ type: 'event_msg', payload: { type } }) + '\n')
}
process.stdout.write('agente falso pronto\r\n')
if (mode !== 'no-paste') process.stdout.write('\x1b[?2004h')
runHook('SessionStart', { source: valueAfter('--resume') ? 'resume' : 'startup' })

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
    const typed = buffer.slice(0, enter)
    buffer = buffer.slice(enter + 1)
    if (typed === 'sair') process.exit(0)
    if (pasted !== null) {
      const text = pasted
      pasted = null
      runHook('UserPromptSubmit', { prompt: text })
      rolloutEvent('task_started')
      write({ kind: 'prompt', text })
      process.stdout.write(`recebido: ${text.split('\n')[0]}\r\n`)
      setTimeout(() => {
        runHook('Stop')
        rolloutEvent('task_complete')
      }, 150)
    }
  }
})
