// Ponta a ponta sem modelo real e sem janela:
//   Lider falso no pty (tests/fixtures/fake-leader.mjs no lugar do `claude`) fala MCP com o
//   servidor do app -> subtarefa_criar x2 -> membros pelo agente ACP falso (modo 'mcp', chama
//   `entregar` de verdade) -> entregas gravadas -> 2 avisos colados no terminal do Lider ->
//   membros encerrados. Depois reinicia os servicos no mesmo SQLite: o Lider volta com --resume
//   e cria um membro novo sem erro (o limite nao conta as sessoes ja encerradas).
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { IpcEventMessage } from '@shared/ipc'
import { startAppServices, type AppServices, type AppServicesOptions } from '../../src/main/app'
import { buildMcpServerForTests } from '../helpers/buildMcpServer'

const FAKE_LEADER = resolve(__dirname, '../fixtures/fake-leader.mjs')
const FAKE_ACP = resolve(__dirname, '../fixtures/fake-acp-agent.mjs')

interface LogRecord {
  pid: number
  kind: string
  [key: string]: unknown
}

let dir: string
let mcpServerScript: string

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ecn-e2e-'))
  mcpServerScript = await buildMcpServerForTests()
}, 60_000)

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

function makeRepo(): string {
  const repo = join(dir, 'repo')
  mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 'teste@example.com')
  git(repo, 'config', 'user.name', 'Teste')
  writeFileSync(join(repo, 'README.md'), 'teste\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'inicio')
  return repo
}

function fakeBin(): string {
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  writeFileSync(
    join(bin, 'claude'),
    `#!/bin/sh\nexec /usr/bin/env ELECTRON_RUN_AS_NODE=1 '${process.execPath}' '${FAKE_LEADER}' "$@"\n`,
    { mode: 0o755 },
  )
  return bin
}

function readLog(file: string): LogRecord[] {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LogRecord)
}

async function waitFor<T>(what: string, check: () => T | null | undefined | false, ms = 45_000) {
  const until = Date.now() + ms
  for (;;) {
    const value = check()
    if (value) return value
    if (Date.now() > until) throw new Error(`prazo esgotado esperando: ${what}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

describe('time de ponta a ponta (Lider falso + membros ACP falsos)', () => {
  it('Lider cria 2 subtarefas, recebe 2 avisos e os membros fecham; reinicia e cria mais um', async () => {
    const repo = makeRepo()
    const bin = fakeBin()
    const leaderLog = join(dir, 'leader.jsonl')
    const acpRecord = join(dir, 'acp.jsonl')
    const empty = join(dir, 'vazio')
    mkdirSync(empty)

    const options: AppServicesOptions = {
      paths: {
        userData: join(dir, 'data'),
        database: join(dir, 'data', 'eclipse.sqlite'),
        runtime: join(dir, 'run'),
        worktrees: join(dir, 'wt'),
      },
      mcpServerScript,
      // Leader + 2 membros. Se sessoes encerradas contassem, o reinicio estouraria o limite.
      limits: { maxLiveAgents: 3, maxLiveMembersPerTask: 2 },
      memberTimeouts: { turnTimeoutMs: 30_000, silenceTimeoutMs: 20_000 },
      acp: {
        resolveCommand: () => ({
          command: process.execPath,
          args: [FAKE_ACP],
          env: { ELECTRON_RUN_AS_NODE: '1', FAKE_ACP_MODE: 'mcp', FAKE_ACP_RECORD: acpRecord },
        }),
        startTimeoutMs: 15_000,
        cancelGraceMs: 300,
        killGraceMs: 500,
        textFlushMs: 50,
      },
      leader: {
        dirs: { claudeConfigDirs: [empty], codexHomes: [empty] },
        launcher: {
          baseEnv: {
            PATH: `${bin}:/usr/bin:/bin`,
            HOME: process.env['HOME'] ?? '/tmp',
            FAKE_LOG: leaderLog,
            FAKE_CLAUDE_CONFIG_DIR: empty,
            FAKE_LEADER_PLAN: JSON.stringify([
              { papel: 'Dev', titulo: 'Primeira parte', instrucoes: 'Faça a primeira parte.' },
              { papel: 'dev', titulo: 'Segunda parte', instrucoes: 'Faça a segunda parte.' },
            ]),
            FAKE_LEADER_PLAN_RESUME: JSON.stringify([
              { papel: 'Dev', titulo: 'Depois do reinício', instrucoes: 'Continue.' },
            ]),
          },
        },
        sessions: { quietMs: 300, settleMs: 50, tailPollMs: 30, promptAckTimeoutMs: 3_000 },
        relay: { retryDelayMs: 50, submitDelayMs: 50, maxAttempts: 600 },
      },
      ptyHost: { killGraceMs: 500, disposeTimeoutMs: 3_000 },
    }

    // ---------------------------------------------------------------- partida 1
    let services: AppServices = await startAppServices(options)
    const ui: IpcEventMessage[] = []
    services.onUiEvent((m) => ui.push(m))
    const { tasks } = services
    const project = tasks.addProject({ rootPath: repo })
    tasks.saveRole({
      projectId: project.id,
      name: 'Líder',
      description: '',
      provider: 'claude',
      model: null,
      promptTemplate: 'Lidere a tarefa {{tarefa}} em {{worktree}}.',
      isLead: true,
    })
    tasks.saveRole({
      projectId: project.id,
      name: 'Dev',
      description: '',
      provider: 'claude',
      model: 'haiku',
      promptTemplate: 'Você é dev. Subtarefa: {{subtarefa}}.',
      isLead: false,
    })

    const task = await services.coordinator.createTask({
      projectId: project.id,
      title: 'Tarefa de ponta a ponta',
      kind: 'team',
      useWorktree: true,
    })
    expect(task.worktreePath).toBeTruthy()
    expect(existsSync(task.worktreePath!)).toBe(true)
    expect(task.branch).toBe('feat/tarefa-de-ponta-a-ponta')

    const notices = () =>
      readLog(leaderLog).filter(
        (r) => r.kind === 'prompt' && String(r['text']).startsWith('[eclipse] Subtarefa'),
      )
    await waitFor('2 avisos no terminal do Líder', () => notices().length >= 2 || null)
    await waitFor('plano do Líder terminou', () =>
      readLog(leaderLog).some((r) => r.kind === 'plan-done'),
    )
    await services.idle()

    const first = readLog(leaderLog)
    expect(first.filter((r) => r.kind === 'plan-error')).toEqual([])
    const start = first.find((r) => r.kind === 'start')!
    expect(start['resumed']).toBe(false)
    expect(start['marker']).toBe('1')
    expect((start['argv'] as string[]).includes('--mcp-config')).toBe(true)
    // O token MCP do Líder vai no ambiente, nunca no argv (ps/proc/cmdline).
    expect(start['tokenInEnv']).toBe(true)
    expect((start['argv'] as string[]).join(' ')).not.toContain('ECLIPSE_NEXT_MCP_TOKEN')
    const mcp = first.find((r) => r.kind === 'mcp')!
    expect(mcp['tools']).toContain('subtarefa_criar')
    expect(mcp['tools']).not.toContain('entregar')
    const toolCalls = first.filter((r) => r.kind === 'tool')
    expect(toolCalls.map((r) => r['isError'])).toEqual([false, false, false])

    const subtasks = tasks.listSubtasks(task.id)
    expect(subtasks.map((s) => s.state)).toEqual(['completed', 'completed'])
    for (const subtask of subtasks) {
      const detail = tasks.getSubtaskDetail(subtask.id)
      expect(detail.artifacts).toHaveLength(1)
      expect(detail.artifacts[0]!.format).toBe('structured')
      expect(detail.artifacts[0]!.delivery.summary).toContain(subtask.id)
      expect(detail.artifacts[0]!.delivery.files).toEqual([
        { path: 'src/falso.ts', change: 'modified' },
      ])
      expect(detail.turns).toHaveLength(1)
      expect(detail.turns[0]!.stopReason).toBe('end_turn')
      // Atividade sem 'prompt' repetido (o TaskService grava um; o runtime nao duplica).
      const activity = tasks.listActivity(subtask.id, null, 100).events
      expect(activity.filter((e) => e.payload.kind === 'prompt')).toHaveLength(1)
      expect(activity.some((e) => e.payload.kind === 'turn_end')).toBe(true)
      // O aviso ao Lider leva o id e o estado.
      expect(notices().some((n) => String(n['text']).includes(subtask.id))).toBe(true)
      expect(notices().every((n) => String(n['text']).includes('pronto'))).toBe(true)
    }

    // Membros encerrados: sessao fechada pelo app, nenhum processo vivo.
    const memberSessions = tasks.listSessions(task.id).filter((s) => s.kind === 'member-acp')
    expect(memberSessions).toHaveLength(2)
    expect(memberSessions.map((s) => [s.status, s.endReason])).toEqual([
      ['exited', 'closed'],
      ['exited', 'closed'],
    ])
    expect(services.members.liveCount()).toBe(0)
    // Os membros abriram na worktree da tarefa, com o MCP do app.
    const acpStarts = readLog(acpRecord).filter((r) => r['method'] === 'session/new')
    expect(acpStarts).toHaveLength(2)
    for (const r of acpStarts) {
      expect(r['cwd']).toBe(task.worktreePath)
      expect((r['params'] as { mcpServers: { name: string }[] }).mcpServers[0]!.name).toBe(
        'eclipse',
      )
    }
    expect(
      readLog(acpRecord)
        .filter((r) => r['method'] === 'entregar')
        .map((r) => (r['params'] as { isError: boolean }).isError),
    ).toEqual([false, false])

    // A tela recebeu dominio e terminal do Lider.
    const leaderSession = tasks.getLiveLeaderSession(task.id)!
    expect(leaderSession.providerSessionId).toBeTruthy()
    expect(ui.some((m) => m.channel === 'domain.event')).toBe(true)
    expect(
      ui.some(
        (m) =>
          m.channel === 'terminal.data' &&
          (m.payload as { sessionId: string }).sessionId === leaderSession.id,
      ),
    ).toBe(true)
    expect(services.coordinator.attachTerminal(leaderSession.id).scrollback).toContain(
      'lider falso pronto',
    )

    await services.dispose()

    // ---------------------------------------------------------------- partida 2
    services = await startAppServices(options)
    try {
      expect(services.recovery.leadersToResume.map((s) => s.id)).toEqual([leaderSession.id])
      expect(services.recovery.lostSubtasks).toEqual([])

      await waitFor('Líder retomado criou e esperou o membro novo', () =>
        readLog(leaderLog).some((r) => r.kind === 'plan-done' && r['pid'] !== start.pid),
      )
      await waitFor('3º aviso', () => notices().length >= 3 || null)
      await services.idle()

      const second = readLog(leaderLog).filter((r) => r.pid !== start.pid)
      const resumedStart = second.find((r) => r.kind === 'start')!
      expect(resumedStart['resumed']).toBe(true)
      expect(resumedStart['argv']).toContain(leaderSession.providerSessionId)
      expect(second.filter((r) => r.kind === 'plan-error')).toEqual([])
      expect(second.filter((r) => r.kind === 'tool').map((r) => r['isError'])).toEqual([
        false,
        false,
      ])

      const all = services.tasks.listSubtasks(task.id)
      expect(all.map((s) => s.state)).toEqual(['completed', 'completed', 'completed'])
      expect(all[2]!.title).toBe('Depois do reinício')
      // Os membros antigos continuam 'closed' (nao viraram sessao perdida).
      const members = services.tasks.listSessions(task.id).filter((s) => s.kind === 'member-acp')
      expect(members.map((s) => s.endReason)).toEqual(['closed', 'closed', 'closed'])
      // O Lider antigo foi encerrado como perdido e o novo esta vivo.
      const leaders = services.tasks.listSessions(task.id).filter((s) => s.kind === 'leader-pty')
      expect(leaders.map((s) => s.status)).toEqual(['exited', 'running'])
      expect(leaders[0]!.endReason).toBe('lost_on_restart')
      expect(services.members.liveCount()).toBe(0)
    } finally {
      await services.dispose()
    }
  }, 120_000)
})
