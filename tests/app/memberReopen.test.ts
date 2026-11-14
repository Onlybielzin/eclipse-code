// Membro reaberto depois do reinicio, com o MemberRuntime ACP de verdade contra o agente ACP
// falso (tests/fixtures/fake-acp-agent.mjs). TaskService em SQLite em memoria; Lider, pty e
// ponte MCP falsos. Nenhum modelo real e nenhuma janela.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AcpMemberRuntime } from '../../src/main/acp'
import { AppTeamCoordinator } from '../../src/main/app/teamCoordinator'
import type { LeaderModule } from '../../src/main/leader'
import { startTeamTurnRelay } from '../../src/main/mcp'
import { createHarness, seedTeam } from '../../src/main/tasks/testing'
import type { McpCaller } from '../../src/shared/mcp'
import type { McpBridgeServer, PtyHost, WorktreeService } from '../../src/shared/ports'

const FAKE_AGENT = resolve(__dirname, '../fixtures/fake-acp-agent.mjs')

let dir: string
const cleanups: (() => Promise<void>)[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'eclipse-reopen-'))
  mkdirSync(join(dir, 'wt'))
})

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  rmSync(dir, { recursive: true, force: true })
})

function recorded(file: string): { method: string; params: Record<string, unknown> }[] {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

async function setup(agentEnv: Record<string, string>) {
  const record = join(dir, 'acp.jsonl')
  const { service: tasks } = createHarness()
  const fx = seedTeam(tasks, join(dir, 'repo'))
  const task = tasks.createTask({
    projectId: fx.project.id,
    title: 'Reabrir membro',
    kind: 'team',
    worktreePath: join(dir, 'wt'),
    branch: 'feat/reabrir',
    baseBranch: 'main',
    leadRoleId: null,
    soloProvider: null,
  })
  const members = new AcpMemberRuntime(
    {
      clock: { now: () => Date.now() },
      timeouts: { turnTimeoutMs: 20_000, silenceTimeoutMs: 10_000 },
      deliveries: { forTurn: (turnId) => tasks.listTurnDeliveries(turnId) },
    },
    {
      resolveCommand: () => ({
        command: process.execPath,
        args: [FAKE_AGENT],
        env: {
          ELECTRON_RUN_AS_NODE: '1',
          FAKE_ACP_MODE: 'normal',
          FAKE_ACP_RECORD: record,
          ...agentEnv,
        },
      }),
      startTimeoutMs: 10_000,
      cancelGraceMs: 300,
      killGraceMs: 500,
      textFlushMs: 20,
    },
  )
  const delivered: string[] = []
  const leader = {
    relay: {
      async deliver(_sessionId: string, text: string) {
        delivered.push(text)
        return { delivered: true, attempts: 1 }
      },
    },
    sessions: { onEvent: () => () => undefined, get: () => null, noteUserInput: () => undefined },
    dispose: async () => undefined,
  } as unknown as LeaderModule
  const bridge = {
    issueToken: () => 'tok',
    revokeSession: () => undefined,
    launchSpec: () => ({
      name: 'eclipse',
      command: process.execPath,
      args: ['/fake/mcp.js'],
      env: {},
    }),
  } as unknown as McpBridgeServer
  const turnRelay = startTeamTurnRelay({
    tasks,
    relay: leader.relay,
    notices: tasks,
    retryIntervalMs: 0,
  })
  const coordinator = new AppTeamCoordinator({
    tasks,
    ptyHost: { isAlive: () => false } as unknown as PtyHost,
    leader,
    members,
    worktrees: {} as WorktreeService,
    bridge,
    worktreesRoot: join(dir, 'wts'),
    leaderNotices: turnRelay,
  })
  cleanups.push(async () => {
    turnRelay.stop()
    await coordinator.shutdown()
  })

  // Partida 1 (simulada): membro no meio do turno com a conversa 'antiga-123' no provedor.
  const subtask = tasks.createSubtask({
    taskId: task.id,
    roleId: fx.dev.id,
    title: 'Implementar rota',
    instructions: 'faça a rota /login',
    referenceTaskIds: [],
  })
  const old = tasks.openSession({
    taskId: task.id,
    subtaskId: subtask.id,
    roleId: fx.dev.id,
    kind: 'member-acp',
    provider: fx.dev.provider,
    model: null,
    cwd: join(dir, 'wt'),
    providerSessionId: 'antiga-123',
  })
  tasks.attachSubtaskSession(subtask.id, old.id)
  tasks.transitionSubtask(subtask.id, 'working')
  const turn = tasks.startTurn({
    sessionId: old.id,
    subtaskId: subtask.id,
    author: 'leader',
    parts: [{ kind: 'text', text: 'faça a rota /login' }],
  })
  tasks.appendActivity([
    {
      sessionId: old.id,
      subtaskId: subtask.id,
      turnId: turn.id,
      at: 5,
      payload: { kind: 'text', text: 'Criei src/login.ts; faltam os testes.' },
    },
  ])

  // Partida 2: recuperacao.
  await coordinator.recover()
  const caller: McpCaller = { role: 'leader', sessionId: 'lider', taskId: task.id, subtaskId: null }
  const settle = async () => {
    for (let i = 0; i < 3; i++) {
      await coordinator.idle()
      await turnRelay.idle()
    }
  }
  return { tasks, coordinator, members, subtask, old, caller, record, settle, taskId: task.id }
}

describe('membro reaberto pelo Líder depois do reinício (agente ACP falso)', () => {
  it('retoma a conversa com session/load e roda o turno com a resposta do Líder', async () => {
    const h = await setup({})
    expect(h.tasks.getSubtask(h.subtask.id).statusMessage).toBe('parada: o app reiniciou')

    await h.coordinator.answerSubtask(h.caller, h.subtask.id, 'Agora escreva os testes.')
    await h.settle()

    const calls = recorded(h.record)
    expect(calls.filter((c) => c.method === 'session/new')).toEqual([])
    expect(calls.find((c) => c.method === 'session/load')?.params['sessionId']).toBe('antiga-123')
    const prompt = calls.find((c) => c.method === 'session/prompt')
    expect(prompt?.params['sessionId']).toBe('antiga-123')
    expect(String(prompt?.params['text'])).toContain('Agora escreva os testes.')

    const after = h.tasks.getSubtask(h.subtask.id)
    expect(after.state).toBe('completed')
    const detail = h.tasks.getSubtaskDetail(h.subtask.id)
    expect(detail.turns).toHaveLength(2)
    expect(detail.turns[1]!.stopReason).toBe('end_turn')
    expect(h.tasks.getSession(after.sessionId!)).toMatchObject({
      providerSessionId: 'antiga-123',
      endReason: 'closed',
    })
    expect(h.members.liveCount()).toBe(0)
  }, 30_000)

  it('agente sem loadSession: abre conversa nova com o contexto no primeiro prompt', async () => {
    const h = await setup({ FAKE_ACP_NO_LOAD: '1' })
    await h.coordinator.answerSubtask(h.caller, h.subtask.id, 'Agora escreva os testes.')
    await h.settle()

    const calls = recorded(h.record)
    expect(calls.filter((c) => c.method === 'session/load')).toEqual([])
    expect(calls.filter((c) => c.method === 'session/new')).toHaveLength(1)
    const text = String(calls.find((c) => c.method === 'session/prompt')?.params['text'])
    expect(text).toContain(`Subtarefa ${h.subtask.id}: Implementar rota`)
    expect(text).toContain('faça a rota /login')
    expect(text).toContain('Criei src/login.ts; faltam os testes.')
    expect(text).toContain('Agora escreva os testes.')
    expect(h.tasks.getSubtask(h.subtask.id).state).toBe('completed')
    expect(h.members.liveCount()).toBe(0)
  }, 30_000)
})
