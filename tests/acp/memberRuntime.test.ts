// MemberRuntime ACP contra o agente ACP falso (tests/fixtures/fake-acp-agent.mjs).
// Nenhum modelo real e nenhuma janela: o agente roda no Node do Electron (ELECTRON_RUN_AS_NODE).
import { mkdtempSync, readFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AcpMemberRuntime } from '../../src/main/acp'
import type { ActivityEventDraft, Artifact, TurnId } from '../../src/shared/domain'
import type { MemberSessionStart, MemberTurnTimeouts } from '../../src/shared/ports'

const FAKE_AGENT = resolve(__dirname, '../fixtures/fake-acp-agent.mjs')

let workdir: string
let runtime: AcpMemberRuntime | null = null
let counter = 0
/** Conta ativa do rodizio vista pelo runtime nos testes. */
let account: string | null = null

beforeEach(() => {
  account = null
  workdir = mkdtempSync(join(tmpdir(), 'eclipse-acp-'))
  mkdirSync(join(workdir, 'worktree'))
})

afterEach(async () => {
  await runtime?.dispose()
  runtime = null
  rmSync(workdir, { recursive: true, force: true })
})

interface Harness {
  runtime: AcpMemberRuntime
  activity: ActivityEventDraft[]
  deliveries: Map<TurnId, Artifact[]>
  exits: { sessionId: string; exitCode: number | null; signal: string | null }[]
}

function makeRuntime(
  timeouts: Partial<MemberTurnTimeouts> = {},
  options: { cancelGraceMs?: number } = {},
): Harness {
  const activity: ActivityEventDraft[] = []
  const deliveries = new Map<TurnId, Artifact[]>()
  const exits: Harness['exits'] = []
  const rt = new AcpMemberRuntime(
    {
      clock: { now: () => Date.now() },
      timeouts: { turnTimeoutMs: 20_000, silenceTimeoutMs: 10_000, ...timeouts },
      deliveries: { forTurn: (turnId) => deliveries.get(turnId) ?? [] },
    },
    {
      // O agente falso no lugar do claude-agent-acp/codex-acp.
      resolveCommand: () => ({
        command: process.execPath,
        args: [FAKE_AGENT],
        env: { ELECTRON_RUN_AS_NODE: '1' },
      }),
      startTimeoutMs: 10_000,
      cancelGraceMs: options.cancelGraceMs ?? 300,
      killGraceMs: 500,
      textFlushMs: 50,
      accountStamp: () => account,
    },
  )
  rt.onActivity((draft) => {
    activity.push(draft)
    // Simula o TaskService: o "entregar" do membro grava uma entrega no turno ativo.
    const p = draft.payload
    if (p.kind === 'tool_call' && p.title.endsWith('entregar') && p.status === 'pending') {
      const list = deliveries.get(draft.turnId) ?? []
      list.push({
        id: `art-${draft.turnId}`,
        taskId: 'task-1',
        subtaskId: draft.subtaskId,
        sessionId: draft.sessionId,
        turnId: draft.turnId,
        format: 'structured',
        delivery: { state: 'completed', summary: 'ok', files: [], tests: [], questions: [] },
        parts: [],
        createdAt: Date.now(),
      })
      deliveries.set(draft.turnId, list)
    }
  })
  rt.onSessionExit((sessionId, exit) => exits.push({ sessionId, ...exit }))
  runtime = rt
  return { runtime: rt, activity, deliveries, exits }
}

function startRequest(mode: string, extra: Partial<MemberSessionStart> = {}): MemberSessionStart {
  counter += 1
  return {
    sessionId: `sess-${counter}`,
    taskId: 'task-1',
    subtaskId: `sub-${counter}`,
    provider: 'claude',
    model: null,
    cwd: join(workdir, 'worktree'),
    systemPrompt: 'Você é o Revisor.',
    access: 'full',
    mcpServer: {
      name: 'eclipse',
      command: process.execPath,
      args: ['/fake/mcp.js'],
      env: { ECLIPSE_NEXT_MCP_TOKEN: 'tok' },
    },
    env: { FAKE_ACP_MODE: mode, FAKE_ACP_RECORD: join(workdir, 'record.jsonl') },
    resumeProviderSessionId: null,
    ...extra,
  }
}

function recorded(): {
  method: string
  params: Record<string, unknown>
  cwd: string
  env: Record<string, string>
}[] {
  return readFileSync(join(workdir, 'record.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
}

describe('AcpMemberRuntime com agente falso', () => {
  it('abre a sessão com cwd da worktree, MCP do app e configurações do usuário', async () => {
    const { runtime } = makeRuntime()
    const request = startRequest('normal')
    const handle = await runtime.startSession(request)
    expect(handle.providerSessionId).toMatch(/^fake-/)
    expect(handle.pid).toBeGreaterThan(0)
    expect(runtime.isAlive(request.sessionId)).toBe(true)
    expect(runtime.liveCount()).toBe(1)

    const calls = recorded()
    const created = calls.find((c) => c.method === 'session/new')!
    expect(created.cwd).toBe(request.cwd)
    expect(created.env.ECLIPSE_NEXT_ENV).toBe('1')
    expect(created.params.cwd).toBe(request.cwd)
    expect(created.params.mcpServers).toEqual([
      {
        name: 'eclipse',
        command: process.execPath,
        args: ['/fake/mcp.js'],
        env: [{ name: 'ECLIPSE_NEXT_MCP_TOKEN', value: 'tok' }],
      },
    ])
    expect(created.params._meta).toEqual({
      claudeCode: { options: { settingSources: ['user', 'project', 'local'] } },
      systemPrompt: { append: 'Você é o Revisor.' },
    })
  })

  it('40 turnos seguidos geram 40 resultados, cada um com texto final e entrega', async () => {
    const h = makeRuntime()
    const request = startRequest('normal')
    await h.runtime.startSession(request)
    const results = []
    for (let i = 1; i <= 40; i++) {
      results.push(
        await h.runtime.prompt(request.sessionId, { turnId: `turn-${i}`, text: `faça ${i}` }),
      )
    }
    expect(results).toHaveLength(40)
    results.forEach((result, index) => {
      const n = index + 1
      expect(result.turnId).toBe(`turn-${n}`)
      expect(result.outcome).toEqual({ kind: 'stopped', stopReason: 'end_turn' })
      // Texto depois da ultima ferramenta, com os pedacos juntados.
      expect(result.finalText).toBe(
        `Turno ${n} feito (${`faça ${n}`.length} chars).\nSTATUS: PRONTO`,
      )
      expect(result.deliveries.map((d) => d.id)).toEqual([`art-turn-${n}`])
      expect(result.endedAt).toBeGreaterThanOrEqual(result.startedAt)
    })
    const turnEnds = h.activity.filter((a) => a.payload.kind === 'turn_end')
    expect(turnEnds).toHaveLength(40)
    // Atividade de um turno: prompt, raciocinio, texto, ferramenta, resultado, texto, fim.
    // (Um bloco de texto pode sair em mais de um evento se a maquina estiver lenta.)
    const kinds = h.activity
      .filter((a) => a.turnId === 'turn-1')
      .map((a) => a.payload.kind)
      .filter((kind, i, all) => kind !== all[i - 1])
    expect(kinds).toEqual([
      'prompt',
      'thought',
      'text',
      'tool_call',
      'tool_result',
      'text',
      'turn_end',
    ])
    expect(h.runtime.isAlive(request.sessionId)).toBe(true)
  }, 60_000)

  it('turno sem entregar resolve com o texto e sem entregas', async () => {
    const h = makeRuntime()
    const request = startRequest('sem-entregar')
    await h.runtime.startSession(request)
    const result = await h.runtime.prompt(request.sessionId, { turnId: 't1', text: 'oi' })
    expect(result.outcome).toEqual({ kind: 'stopped', stopReason: 'end_turn' })
    expect(result.deliveries).toEqual([])
    expect(result.finalText).toBe('Fiz uma parte do turno 1.\nSTATUS: DÚVIDA')
  })

  it('processo que morre no meio do turno resolve com erro process_exited', async () => {
    const h = makeRuntime()
    const request = startRequest('morre-no-meio')
    await h.runtime.startSession(request)
    const result = await h.runtime.prompt(request.sessionId, { turnId: 't1', text: 'oi' })
    expect(result.outcome.kind).toBe('error')
    if (result.outcome.kind !== 'error') throw new Error('esperava erro')
    expect(result.outcome.error.code).toBe('process_exited')
    expect(result.outcome.error.exitCode).toBe(3)
    expect(result.finalText).toBe('começando...')
    expect(h.runtime.isAlive(request.sessionId)).toBe(false)
    expect(h.runtime.liveCount()).toBe(0)
    expect(h.exits).toEqual([{ sessionId: request.sessionId, exitCode: 3, signal: null }])
    const last = h.activity.at(-1)!.payload
    expect(last.kind).toBe('turn_end')

    // Prompt numa sessao morta tambem resolve (nunca fica pendente).
    const again = await h.runtime.prompt(request.sessionId, { turnId: 't2', text: 'oi' })
    expect(again.outcome.kind === 'error' && again.outcome.error.code).toBe('process_exited')
  })

  it('agente calado dispara o vigia de silêncio e o processo é encerrado', async () => {
    const h = makeRuntime({ silenceTimeoutMs: 300 })
    const request = startRequest('calado')
    await h.runtime.startSession(request)
    const started = Date.now()
    const result = await h.runtime.prompt(request.sessionId, { turnId: 't1', text: 'oi' })
    expect(result.outcome.kind === 'error' && result.outcome.error.code).toBe('silent_timeout')
    expect(Date.now() - started).toBeLessThan(5_000)
    // Ignorou o session/cancel: depois da carencia o processo morre (nao fica orfao).
    await expect.poll(() => h.runtime.isAlive(request.sessionId), { timeout: 5_000 }).toBe(false)
    expect(h.exits).toHaveLength(1)
  })

  it('tempo máximo do turno resolve com turn_timeout mesmo com o agente falando', async () => {
    const h = makeRuntime({ turnTimeoutMs: 400, silenceTimeoutMs: 5_000 })
    const request = startRequest('gotejando')
    await h.runtime.startSession(request)
    const result = await h.runtime.prompt(request.sessionId, { turnId: 't1', text: 'oi' })
    expect(result.outcome.kind === 'error' && result.outcome.error.code).toBe('turn_timeout')
    expect(result.finalText).toMatch(/^\.0\.1/)
    // O agente atendeu ao cancel: o processo segue vivo e aceita outro turno.
    expect(h.runtime.isAlive(request.sessionId)).toBe(true)
  })

  it('cancel manda session/cancel e o turno fecha com stopReason cancelled', async () => {
    const h = makeRuntime()
    const request = startRequest('gotejando')
    await h.runtime.startSession(request)
    const pending = h.runtime.prompt(request.sessionId, { turnId: 't1', text: 'oi' })
    await expect
      .poll(() => h.activity.some((a) => a.payload.kind === 'text'), { timeout: 3_000 })
      .toBe(true)
    await h.runtime.cancel(request.sessionId)
    const result = await pending
    expect(result.outcome).toEqual({ kind: 'stopped', stopReason: 'cancelled' })
    expect(h.runtime.isAlive(request.sessionId)).toBe(true)
  })

  it('segundo prompt simultâneo é recusado com conflict', async () => {
    const h = makeRuntime()
    const request = startRequest('gotejando')
    await h.runtime.startSession(request)
    const first = h.runtime.prompt(request.sessionId, { turnId: 't1', text: 'oi' })
    await expect(
      h.runtime.prompt(request.sessionId, { turnId: 't2', text: 'oi' }),
    ).rejects.toMatchObject({
      code: 'conflict',
    })
    await h.runtime.cancel(request.sessionId)
    await first
  })

  it('close no meio do turno resolve com session_closed e mata o processo', async () => {
    const h = makeRuntime()
    const request = startRequest('calado')
    await h.runtime.startSession(request)
    const pending = h.runtime.prompt(request.sessionId, { turnId: 't1', text: 'oi' })
    await h.runtime.close(request.sessionId)
    const result = await pending
    expect(result.outcome.kind === 'error' && result.outcome.error.code).toBe('session_closed')
    expect(h.runtime.isAlive(request.sessionId)).toBe(false)
    expect(h.runtime.liveCount()).toBe(0)
  })

  it('aceita sozinho tudo, dentro e fora da worktree (permissão total)', async () => {
    const h = makeRuntime()
    const request = startRequest('permissao')
    await h.runtime.startSession(request)
    const result = await h.runtime.prompt(request.sessionId, { turnId: 't1', text: 'oi' })
    expect(result.finalText).toBe('dentro=sim fora=sim terminal=sim')
  })

  it('retoma com session/load e ignora o histórico repetido', async () => {
    const h = makeRuntime()
    const request = startRequest('normal', { resumeProviderSessionId: 'antiga-123' })
    const handle = await h.runtime.startSession(request)
    expect(handle.providerSessionId).toBe('antiga-123')
    expect(
      recorded().some((c) => c.method === 'session/load' && c.params.sessionId === 'antiga-123'),
    ).toBe(true)
    expect(h.activity).toEqual([])
    const result = await h.runtime.prompt(request.sessionId, { turnId: 't1', text: 'oi' })
    expect(result.outcome).toEqual({ kind: 'stopped', stopReason: 'end_turn' })
  })

  it('rodízio trocou de conta: o próximo turno reabre o membro com session/load', async () => {
    account = 'conta-a'
    const h = makeRuntime()
    const request = startRequest('normal')
    const handle = await h.runtime.startSession(request)
    await h.runtime.prompt(request.sessionId, { turnId: 't1', text: 'oi' })
    expect(recorded().filter((c) => c.method === 'session/load')).toEqual([])

    account = 'conta-b'
    const result = await h.runtime.prompt(request.sessionId, { turnId: 't2', text: 'de novo' })
    expect(result.outcome).toEqual({ kind: 'stopped', stopReason: 'end_turn' })
    const loads = recorded().filter((c) => c.method === 'session/load')
    expect(loads.map((c) => c.params.sessionId)).toEqual([handle.providerSessionId])
    // A troca nao parece queda do membro para o coordenador.
    expect(h.exits).toEqual([])
    expect(h.runtime.liveCount()).toBe(1)

    // Mesma conta: nao reabre de novo.
    await h.runtime.prompt(request.sessionId, { turnId: 't3', text: 'mais' })
    expect(recorded().filter((c) => c.method === 'session/load')).toHaveLength(1)
  })

  it('falha na partida vira DomainError unavailable e não deixa sessão viva', async () => {
    const rt = new AcpMemberRuntime(
      {
        clock: { now: () => Date.now() },
        timeouts: { turnTimeoutMs: 1_000, silenceTimeoutMs: 1_000 },
        deliveries: { forTurn: () => [] },
      },
      {
        resolveCommand: () => ({ command: '/caminho/que/nao/existe', args: [], env: {} }),
        startTimeoutMs: 2_000,
      },
    )
    runtime = rt
    await expect(rt.startSession(startRequest('normal'))).rejects.toMatchObject({
      code: 'unavailable',
    })
    expect(rt.liveCount()).toBe(0)
  })

  describe('neto que ignora SIGTERM no grupo do membro', () => {
    const grandchildPid = async (file: string): Promise<number> => {
      const until = Date.now() + 5_000
      for (;;) {
        try {
          const pid = Number(readFileSync(file, 'utf8'))
          if (pid > 0) return pid
        } catch {
          // ainda nao gravou
        }
        if (Date.now() > until) throw new Error('neto nao abriu')
        await new Promise((r) => setTimeout(r, 20))
      }
    }
    const isAlive = (pid: number) => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    const waitDead = async (pid: number, ms: number) => {
      const until = Date.now() + ms
      while (isAlive(pid) && Date.now() < until) await new Promise((r) => setTimeout(r, 25))
      return !isAlive(pid)
    }

    it('close manda SIGKILL ao grupo mesmo depois que o adaptador já saiu', async () => {
      const h = makeRuntime()
      const pidFile = join(workdir, 'neto.pid')
      const request = startRequest('normal', {
        env: { FAKE_ACP_MODE: 'normal', FAKE_ACP_GRANDCHILD: pidFile },
      })
      await h.runtime.startSession(request)
      const pid = await grandchildPid(pidFile)
      try {
        await h.runtime.close(request.sessionId)
        // killGraceMs = 500: o neto que ignora SIGTERM recebe SIGKILL logo depois.
        expect(await waitDead(pid, 2_000)).toBe(true)
      } finally {
        if (isAlive(pid)) process.kill(pid, 'SIGKILL')
      }
    })

    it('adaptador que cai sozinho não deixa o neto vivo', async () => {
      const h = makeRuntime()
      const pidFile = join(workdir, 'neto-crash.pid')
      const request = startRequest('morre-no-meio', {
        env: { FAKE_ACP_MODE: 'morre-no-meio', FAKE_ACP_GRANDCHILD: pidFile },
      })
      await h.runtime.startSession(request)
      const pid = await grandchildPid(pidFile)
      try {
        const result = await h.runtime.prompt(request.sessionId, { turnId: 't1', text: 'oi' })
        expect(result.outcome.kind).toBe('error')
        expect(await waitDead(pid, 3_000)).toBe(true)
      } finally {
        if (isAlive(pid)) process.kill(pid, 'SIGKILL')
      }
    })
  })

  it('membro não herda as variáveis de sessão do app antigo', async () => {
    const saved = { ...process.env }
    process.env['ECLIPSE_CODE_CONTROL_TOKEN'] = 'segredo-antigo'
    process.env['ECLIPSE_CODE_ENV'] = '1'
    try {
      const { runtime } = makeRuntime()
      const request = startRequest('normal')
      await runtime.startSession(request)
      const start = recorded().find((r) => r.method === 'session/new')!
      expect(Object.keys(start.env).filter((k) => k.startsWith('ECLIPSE_CODE_'))).toEqual([])
      expect(start.env['ECLIPSE_NEXT_ENV']).toBe('1')
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
      Object.assign(process.env, saved)
    }
  })
})
