import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { claudeHookPaths, writeClaudeHookFiles, type ClaudeHookPaths } from './claudeHooks'
import { claimInbox, fitInbox, MAX_INBOX_CHARS, writeInbox } from './inbox'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function setup(): Promise<ClaudeHookPaths> {
  const root = mkdtempSync(join(tmpdir(), 'inbox-'))
  dirs.push(root)
  const paths = claudeHookPaths(root, 's1')
  await writeClaudeHookFiles(paths, process.execPath)
  return paths
}

/** Roda o hook.mjs de verdade, como o Claude: JSON no stdin, stdout e codigo de saida. */
function runHook(
  paths: ClaudeHookPaths,
  input: object,
): Promise<{ stdout: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [paths.script, paths.events], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    })
    let stdout = ''
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
    child.on('close', (code) => resolve({ stdout, code }))
    child.stdin.end(JSON.stringify(input))
  })
}

function eventLines(paths: ClaudeHookPaths): Array<Record<string, unknown>> {
  return readFileSync(paths.events, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

const NOTICES = [
  { id: 4, text: '[eclipse] Subtarefa a terminou' },
  { id: 5, text: '[eclipse] Subtarefa b terminou' },
]
const TEXT = '[eclipse] Subtarefa a terminou\n[eclipse] Subtarefa b terminou'

describe('hook.mjs entrega a caixa', () => {
  it('PostToolUse: additionalContext e NoticesDelivered', async () => {
    const paths = await setup()
    await writeInbox(paths, NOTICES)
    expect((statSync(paths.inbox).mode & 0o777).toString(8)).toBe('600')
    const result = await runHook(paths, { hook_event_name: 'PostToolUse', session_id: 'x' })
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: TEXT },
    })
    expect(existsSync(paths.inbox)).toBe(false)
    expect(readdirSync(paths.directory).filter((n) => n.startsWith('inbox'))).toEqual([])
    const lines = eventLines(paths)
    expect(lines.map((l) => l['event'])).toEqual(['NoticesDelivered', 'PostToolUse'])
    expect(lines[0]).toMatchObject({ ids: [4, 5] })
  })

  it('dentro de subagente (agent_id): nao reivindica a caixa e so observa', async () => {
    const paths = await setup()
    await writeInbox(paths, NOTICES)
    for (const event of ['PostToolUse', 'Stop']) {
      const result = await runHook(paths, { hook_event_name: event, agent_id: 'sub-1' })
      expect(result).toEqual({ stdout: '', code: 0 })
    }
    expect(existsSync(paths.inbox)).toBe(true)
    expect(eventLines(paths).map((l) => l['event'])).toEqual(['PostToolUse', 'Stop'])
    // agent_id vazio nao e subagente: entrega como antes.
    const main = await runHook(paths, { hook_event_name: 'PostToolUse', agent_id: '' })
    expect(JSON.parse(main.stdout)).toMatchObject({
      hookSpecificOutput: { additionalContext: TEXT },
    })
  })

  it('UserPromptSubmit: igual, com o nome do evento', async () => {
    const paths = await setup()
    await writeInbox(paths, NOTICES)
    const result = await runHook(paths, { hook_event_name: 'UserPromptSubmit' })
    expect(JSON.parse(result.stdout)).toEqual({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: TEXT },
    })
  })

  it('Stop: bloqueia com os avisos, mesmo com stop_hook_active, e nao grava Stop', async () => {
    const paths = await setup()
    await writeInbox(paths, NOTICES)
    const result = await runHook(paths, { hook_event_name: 'Stop', stop_hook_active: true })
    expect(JSON.parse(result.stdout)).toEqual({ decision: 'block', reason: TEXT })
    expect(eventLines(paths).map((l) => l['event'])).toEqual(['NoticesDelivered'])
  })

  it('caixa vazia: nada no stdout, Stop registrado, codigo 0', async () => {
    const paths = await setup()
    const result = await runHook(paths, { hook_event_name: 'Stop' })
    expect(result).toEqual({ stdout: '', code: 0 })
    expect(eventLines(paths).map((l) => l['event'])).toEqual(['Stop'])
  })

  it('outros eventos nao tocam na caixa', async () => {
    const paths = await setup()
    await writeInbox(paths, NOTICES)
    const result = await runHook(paths, { hook_event_name: 'PreToolUse' })
    expect(result.stdout).toBe('')
    expect(existsSync(paths.inbox)).toBe(true)
  })

  it('caixa corrompida: sai com 0, sem entregar', async () => {
    const paths = await setup()
    await import('node:fs/promises').then((fs) => fs.writeFile(paths.inbox, '{nao e lista'))
    const result = await runHook(paths, { hook_event_name: 'PostToolUse' })
    expect(result).toEqual({ stdout: '', code: 0 })
  })

  it('limite de 9000 caracteres por entrega', async () => {
    const paths = await setup()
    await writeInbox(paths, [{ id: 1, text: 'x'.repeat(20_000) }])
    const result = await runHook(paths, { hook_event_name: 'PostToolUse' })
    const out = JSON.parse(result.stdout) as { hookSpecificOutput: { additionalContext: string } }
    expect(out.hookSpecificOutput.additionalContext).toHaveLength(MAX_INBOX_CHARS)
  })
})

describe('caixa do app', () => {
  it('fitInbox corta no limite e mantem ao menos um aviso', () => {
    const big = { id: 1, text: 'x'.repeat(8_000) }
    expect(fitInbox([big, { id: 2, text: 'y'.repeat(2_000) }])).toEqual([big])
    expect(fitInbox([{ id: 3, text: 'z'.repeat(20_000) }])).toHaveLength(1)
  })

  it('corrida: app e gancho reivindicam a mesma caixa e so um leva', async () => {
    for (const delayMs of [0, 15, 30, 45, 60, 75]) {
      const paths = await setup()
      await writeInbox(paths, NOTICES)
      const hook = runHook(paths, { hook_event_name: 'PostToolUse' })
      await new Promise((resolve) => setTimeout(resolve, delayMs))
      const app = await claimInbox(paths)
      const hookOut = await hook
      expect((app.length > 0 ? 1 : 0) + (hookOut.stdout !== '' ? 1 : 0)).toBe(1)
      if (app.length > 0) expect(app).toEqual(NOTICES)
    }
  })

  it('reabrir a sessao apaga caixa antiga', async () => {
    const paths = await setup()
    await writeInbox(paths, NOTICES)
    await writeClaudeHookFiles(paths, process.execPath)
    expect(existsSync(paths.inbox)).toBe(false)
  })
})
