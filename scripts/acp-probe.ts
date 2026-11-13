/**
 * Prova real do MemberRuntime ACP: UM turno curto com o Claude (Haiku) e UM com o Codex.
 * GASTA COTA DE MODELO. Nao roda nos testes nem no workflow; a integracao decide quando rodar.
 *
 * Uso (na raiz do repo, sem janela):
 *   node scripts/probe/run-ts.mjs scripts/acp-probe.ts            # claude e codex
 *   node scripts/probe/run-ts.mjs scripts/acp-probe.ts claude     # so um
 *
 * Variaveis opcionais:
 *   PROBE_CLAUDE_MODEL (padrao claude-haiku-4-5), PROBE_CODEX_MODEL (padrao: o do ~/.codex),
 *   PROBE_TURN_TIMEOUT_MS (padrao 180000).
 *
 * O que confere em cada provedor:
 *   1. A sessao abre (initialize + session/new) com cwd numa pasta git temporaria.
 *   2. O turno termina pela resposta do session/prompt (stopReason end_turn).
 *   3. O membro chamou a ferramenta MCP `entregar` (servidor falso scripts/probe/fake-mcp-entregar.mjs).
 *   4. O texto final saiu dos pedacos de texto do turno.
 * Sai com codigo 0 se todos os provedores pedidos passarem.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { MCP_SERVER_NAME } from '@shared/mcp'
import type { ActivityEventDraft, Artifact, Provider } from '@shared/domain'
import { AcpMemberRuntime } from '../src/main/acp'

const ROOT = resolve(import.meta.dirname, '..')
const FAKE_MCP = join(ROOT, 'scripts/probe/fake-mcp-entregar.mjs')

const PROMPT = [
  'Isto é um teste automático do app. Não leia nem altere arquivos.',
  'Chame a ferramenta MCP `entregar` uma vez, com estado "pronto" e resumo "teste ok".',
  'Depois responda numa linha "teste ok" e termine com a linha: STATUS: PRONTO',
].join('\n')

function log(line: string): void {
  process.stdout.write(`${line}\n`)
}

function describe(draft: ActivityEventDraft): string {
  const p = draft.payload
  switch (p.kind) {
    case 'text':
    case 'thought':
    case 'prompt':
      return `${p.kind}: ${p.text.replace(/\s+/g, ' ').slice(0, 160)}`
    case 'tool_call':
      return `tool_call: ${p.title} [${p.status}]`
    case 'tool_result':
      return `tool_result: ${p.toolCallId} [${p.status}] ${(p.output ?? '').slice(0, 80)}`
    case 'error':
      return `error: ${p.code} ${p.message}`
    case 'turn_end':
      return `turn_end: ${p.stopReason ?? p.error?.code}`
  }
}

async function probe(provider: Provider): Promise<boolean> {
  const dir = mkdtempSync(join(tmpdir(), `eclipse-acp-probe-${provider}-`))
  const deliveriesFile = join(dir, 'entregas.jsonl')
  const cwd = join(dir, 'worktree')
  execFileSync('git', ['init', '-q', cwd])
  const model =
    provider === 'claude'
      ? (process.env.PROBE_CLAUDE_MODEL ?? 'claude-haiku-4-5')
      : (process.env.PROBE_CODEX_MODEL ?? null)
  const turnTimeoutMs = Number(process.env.PROBE_TURN_TIMEOUT_MS ?? 180_000)

  const runtime = new AcpMemberRuntime(
    {
      clock: { now: () => Date.now() },
      timeouts: { turnTimeoutMs, silenceTimeoutMs: Math.min(turnTimeoutMs, 120_000) },
      deliveries: {
        // Mostra as chamadas ao `entregar` como entregas do turno.
        forTurn: (turnId) => {
          if (!existsSync(deliveriesFile)) return []
          return readFileSync(deliveriesFile, 'utf8')
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((line, i): Artifact => {
              const args = JSON.parse(line) as { estado: string; resumo: string }
              return {
                id: `probe-${i}`,
                taskId: 'probe',
                subtaskId: 'probe',
                sessionId: 'probe',
                turnId,
                format: 'structured',
                delivery: {
                  state: args.estado === 'pronto' ? 'completed' : 'failed',
                  summary: args.resumo,
                  files: [],
                  tests: [],
                  questions: [],
                },
                parts: [],
                createdAt: Date.now(),
              }
            })
        },
      },
    },
    {
      logger: {
        info: (m, meta) => log(`  [info] ${m} ${meta ? JSON.stringify(meta) : ''}`),
        warn: (m, meta) => log(`  [warn] ${m} ${meta ? JSON.stringify(meta) : ''}`),
      },
    },
  )
  runtime.onActivity((draft) => log(`  ${describe(draft)}`))

  log(`\n== ${provider} (modelo: ${model ?? 'padrão do usuário'}) em ${cwd}`)
  const started = Date.now()
  try {
    const handle = await runtime.startSession({
      sessionId: `probe-${provider}`,
      taskId: 'probe',
      subtaskId: 'probe',
      provider,
      model,
      cwd,
      systemPrompt: 'Você é um membro de teste do Eclipse Code. Siga as instruções à risca.',
      mcpServer: {
        name: MCP_SERVER_NAME,
        command: process.execPath,
        args: [FAKE_MCP],
        env: { PROBE_DELIVERIES_FILE: deliveriesFile },
      },
      env: {},
      resumeProviderSessionId: null,
    })
    log(
      `  sessão aberta: ${handle.providerSessionId} pid=${handle.pid} em ${Date.now() - started} ms`,
    )
    const result = await runtime.prompt(handle.sessionId, {
      turnId: `probe-${provider}-1`,
      text: PROMPT,
    })
    const ok =
      result.outcome.kind === 'stopped' &&
      result.outcome.stopReason === 'end_turn' &&
      result.deliveries.length > 0 &&
      result.finalText.length > 0
    log(`  resultado: ${JSON.stringify(result.outcome)}`)
    log(
      `  entregas: ${result.deliveries.map((d) => `${d.delivery.state}: ${d.delivery.summary}`).join(' | ') || 'nenhuma'}`,
    )
    log(`  texto final: ${JSON.stringify(result.finalText)}`)
    log(`  ${ok ? 'PASSOU' : 'FALHOU'} em ${Date.now() - started} ms`)
    return ok
  } catch (error) {
    log(`  FALHOU: ${error instanceof Error ? error.message : String(error)}`)
    return false
  } finally {
    await runtime.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
}

export async function main(args: string[]): Promise<number> {
  const wanted = (args.length ? args : ['claude', 'codex']).filter(
    (p): p is Provider => p === 'claude' || p === 'codex',
  )
  let allOk = true
  for (const provider of wanted) {
    if (!(await probe(provider))) allOk = false
  }
  return allOk ? 0 : 1
}
