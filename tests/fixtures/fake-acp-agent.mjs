#!/usr/bin/env node
/* global process, setTimeout */
// Agente ACP FALSO para os testes do MemberRuntime. Nunca chama modelo real.
//
// Modo por FAKE_ACP_MODE:
//   normal         raciocinio, chamada de ferramenta "entregar", texto em pedacos, end_turn
//   sem-entregar   so texto com linha STATUS, end_turn, sem ferramenta
//   morre-no-meio  manda um pedaco de texto e sai com codigo 3 no meio do turno
//   calado         nunca responde ao session/prompt nem manda evento; ignora session/cancel
//   gotejando      manda um pedaco a cada 30 ms ate receber session/cancel (responde cancelled)
//   permissao      pede permissao para um arquivo dentro do cwd e outro fora; conta o resultado
//   mcp            chama de verdade a ferramenta `entregar` no servidor MCP recebido em
//                  session/new (mcpServers), como o claude-agent-acp faria, e termina com end_turn
//
// FAKE_ACP_GRANDCHILD=<arquivo>: abre um neto no mesmo grupo de processos que ignora
// SIGTERM (como um `pnpm test` aberto pelo Bash do membro) e grava o pid dele no arquivo.
//
// FAKE_ACP_RECORD=<arquivo>: grava uma linha JSON por chamada de partida (initialize,
// session/new, session/load) com cwd e algumas variaveis de ambiente.
import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { AgentSideConnection, PROTOCOL_VERSION, ndJsonStream } from '@agentclientprotocol/sdk'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const mode = process.env.FAKE_ACP_MODE ?? 'normal'
const recordFile = process.env.FAKE_ACP_RECORD

function record(method, params) {
  if (!recordFile) return
  const env = {}
  for (const key of ['ANTHROPIC_MODEL', 'CODEX_CONFIG', 'ECLIPSE_NEXT_ENV', 'FAKE_EXTRA']) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ECLIPSE_CODE_')) env[key] = process.env[key]
  }
  appendFileSync(recordFile, `${JSON.stringify({ method, params, cwd: process.cwd(), env })}\n`)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

class FakeAgent {
  constructor(connection) {
    this.connection = connection
    this.turn = 0
    this.cancelled = new Set()
    this.sessionCounter = 0
    /** sessionId -> mcpServers do session/new */
    this.mcpServers = new Map()
  }

  /** Chama uma ferramenta no servidor MCP do app, como o adaptador ACP real faria. */
  async callAppTool(sessionId, name, args) {
    const server = (this.mcpServers.get(sessionId) ?? [])[0]
    if (!server) throw new Error('sessao sem servidor MCP')
    const env = { ...process.env }
    for (const { name: key, value } of server.env ?? []) env[key] = value
    const transport = new StdioClientTransport({ command: server.command, args: server.args, env })
    const client = new Client({ name: 'fake-acp-agent', version: '0.0.0' })
    await client.connect(transport)
    try {
      return await client.callTool({ name, arguments: args })
    } finally {
      await client.close()
    }
  }

  async initialize(params) {
    record('initialize', params)
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: { loadSession: true },
      authMethods: [],
    }
  }

  async newSession(params) {
    record('session/new', params)
    this.sessionCounter += 1
    const sessionId = `fake-${process.pid}-${this.sessionCounter}`
    this.mcpServers.set(sessionId, params.mcpServers ?? [])
    return { sessionId }
  }

  async loadSession(params) {
    record('session/load', params)
    // Historico repetido: o runtime nao deve transformar isto em atividade.
    await this.say(params.sessionId, 'historico antigo')
    return {}
  }

  async authenticate() {
    return {}
  }

  async cancel(params) {
    if (mode === 'calado') return
    this.cancelled.add(params.sessionId)
  }

  async say(sessionId, text, messageId) {
    await this.connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text },
        ...(messageId ? { messageId } : {}),
      },
    })
  }

  async prompt(params) {
    const sessionId = params.sessionId
    this.turn += 1
    const n = this.turn
    this.cancelled.delete(sessionId)
    const promptText = params.prompt.map((b) => (b.type === 'text' ? b.text : '')).join('')

    switch (mode) {
      case 'normal': {
        await this.connection.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text: `pensando ${n}` },
          },
        })
        await this.say(sessionId, `Vou entregar o turno ${n}.`, `m${n}a`)
        const toolCallId = `tool-${n}`
        await this.connection.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId,
            title: 'mcp__eclipse__entregar',
            kind: 'other',
            status: 'pending',
            rawInput: { estado: 'pronto', resumo: `turno ${n}` },
          },
        })
        await this.connection.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId,
            status: 'completed',
            content: [{ type: 'content', content: { type: 'text', text: 'entrega gravada' } }],
          },
        })
        for (const piece of [
          `Turno ${n} `,
          'feito',
          ` (${promptText.length} chars).`,
          '\nSTATUS: PRONTO',
        ]) {
          await this.say(sessionId, piece, `m${n}b`)
        }
        return { stopReason: 'end_turn' }
      }
      case 'sem-entregar': {
        await this.say(sessionId, `Fiz uma parte do turno ${n}.\n`)
        await this.say(sessionId, 'STATUS: DÚVIDA')
        return { stopReason: 'end_turn' }
      }
      case 'morre-no-meio': {
        await this.say(sessionId, 'começando...')
        setTimeout(() => process.exit(3), 20)
        return new Promise(() => {})
      }
      case 'calado':
        return new Promise(() => {})
      case 'gotejando': {
        for (let i = 0; ; i++) {
          if (this.cancelled.has(sessionId)) return { stopReason: 'cancelled' }
          await this.say(sessionId, `.${i}`)
          await sleep(30)
        }
      }
      case 'permissao': {
        const ask = async (path, id) => {
          const response = await this.connection.requestPermission({
            sessionId,
            toolCall: {
              toolCallId: id,
              title: `Edit ${path}`,
              kind: 'edit',
              locations: [{ path }],
            },
            options: [
              { optionId: 'sim', name: 'Permitir', kind: 'allow_once' },
              { optionId: 'nao', name: 'Recusar', kind: 'reject_once' },
            ],
          })
          return response.outcome.outcome === 'selected' ? response.outcome.optionId : 'cancelado'
        }
        const inside = await ask(join(process.cwd(), 'src', 'novo.ts'), 'p1')
        const outside = await ask('/etc/passwd', 'p2')
        const noPath = await this.connection.requestPermission({
          sessionId,
          toolCall: { toolCallId: 'p3', title: 'Terminal: ls', kind: 'execute' },
          options: [
            { optionId: 'sim', name: 'Permitir', kind: 'allow_once' },
            { optionId: 'nao', name: 'Recusar', kind: 'reject_once' },
          ],
        })
        const terminal =
          noPath.outcome.outcome === 'selected' ? noPath.outcome.optionId : 'cancelado'
        await this.say(sessionId, `dentro=${inside} fora=${outside} terminal=${terminal}`)
        return { stopReason: 'end_turn' }
      }
      case 'mcp': {
        const firstLine = promptText.split('\n')[0] ?? ''
        await this.say(sessionId, `Trabalhando em: ${firstLine}\n`)
        const result = await this.callAppTool(sessionId, 'entregar', {
          estado: 'pronto',
          resumo: `feito pelo membro falso: ${firstLine}`,
          arquivos: [{ path: 'src/falso.ts', change: 'modified' }],
          testes: [{ command: 'pnpm test', result: 'ok', passed: true }],
        })
        const text = (result.content ?? []).map((c) => c.text ?? '').join(' ')
        record('entregar', { isError: result.isError ?? false, text })
        await this.say(sessionId, `Entreguei. STATUS: PRONTO`)
        return { stopReason: 'end_turn' }
      }
      default:
        throw new Error(`modo desconhecido: ${mode}`)
    }
  }
}

if (process.env.FAKE_ACP_GRANDCHILD) {
  const pidFile = process.env.FAKE_ACP_GRANDCHILD
  spawn(
    process.execPath,
    [
      '-e',
      `process.on('SIGTERM', () => {}); require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`,
    ],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'ignore' },
  )
}

const stream = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin))
new AgentSideConnection((connection) => new FakeAgent(connection), stream)
process.stdin.on('end', () => process.exit(0))
