/**
 * `eclipse-code mcp`: a stdio MCP server that lets an agent running inside Eclipse Code drive its
 * team (create agents, message them, wait for them, read them) without a shell.
 *
 * Every tool runs this same CLI as a child process, so it inherits the caller's terminal grant
 * (ECLIPSE_CODE_* environment): the Worker's policy and spawn limits (3 levels, 6 live agents per
 * root) apply exactly as they do to `eclipse-code node create agent`. Only an agent the user
 * started (lineageDepth 1, the team lead) may create agents or message them.
 */
import { closeTask } from './closeTask'
import { runCli, type CliResult } from './runCli'
import { text, type ToolDefinition } from './toolSupport'
import { CARD_TOOLS } from './cardTools'
import { createInterface } from 'node:readline'

const PROTOCOL_VERSION = '2025-06-18'
const SERVER_INFO = { name: 'eclipse-code', version: '1.0.0' }
const MAX_OUTPUT_CHARS = 60_000

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: string | number | null
  method: string
  params?: Record<string, unknown>
}

function list(value: unknown, field: string): string[] {
  const items = Array.isArray(value) ? value : typeof value === 'string' ? [value] : []
  const clean = items.filter(
    (item): item is string => typeof item === 'string' && item.trim() !== '',
  )
  if (clean.length === 0) {
    throw new Error(`"${field}" precisa de pelo menos um agente.`)
  }
  return clean
}

const AGENT_SELECTOR = {
  type: 'string',
  description: 'ID do nó do agente (ou nome exato da janela, ou prefixo do ID com 6+ caracteres).',
}

export const TOOLS: ToolDefinition[] = [
  {
    name: 'time_contexto',
    description:
      'Mostra onde você está: projeto, Space atual e os agentes vizinhos com o estado de cada um (idle, working, waiting).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: () => runCli(['context']),
  },
  {
    name: 'feature_criar_space',
    description:
      'Cria um Space novo no projeto ligado a uma worktree nova (branch nova). Use uma vez por tarefa, antes de criar o time. Devolve o id do Space e o caminho da worktree. O app troca "/" por "-" no nome da branch.',
    leadOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        nome: { type: 'string', description: 'Slug curto da tarefa, ex.: login-google.' },
        branch: { type: 'string', description: 'Branch nova, ex.: feat/login-google.' },
      },
      required: ['nome', 'branch'],
      additionalProperties: false,
    },
    run: async args => {
      const created = await runCli([
        'space',
        'create',
        '--name',
        text(args.nome, 'nome')!,
        '--fields',
        'id',
      ])
      if (created.code !== 0) {
        return created
      }
      let spaceId: string
      try {
        spaceId = String((JSON.parse(created.stdout) as { id: string }).id)
      } catch {
        return {
          code: 1,
          stdout: created.stdout,
          stderr: 'Space criado, mas a resposta não trouxe o id.',
        }
      }
      const worktree = await runCli([
        'worktree',
        'create',
        '--space',
        spaceId,
        '--name',
        text(args.branch, 'branch')!,
      ])
      if (worktree.code !== 0) {
        return {
          ...worktree,
          stderr: `O Space ${spaceId} foi criado, mas a worktree falhou. Não crie outro Space.\n${worktree.stderr}`,
        }
      }
      return worktree
    },
  },
  {
    name: 'agente_criar',
    description:
      'Cria um agente do time numa janela do canvas, dentro de um Space, já com a tarefa. Devolve o id do nó. O agente roda na pasta do Space (a worktree da tarefa). Só o líder pode usar.',
    leadOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        titulo: {
          type: 'string',
          description: 'Nome da janela, ex.: "Dev 1", "Testes", "Revisor".',
        },
        prompt: {
          type: 'string',
          description: 'Instruções completas: papel, tarefa, escopo de arquivos e como terminar.',
        },
        provedor: {
          type: 'string',
          enum: ['claude-code', 'codex'],
          description: 'Provedor do agente.',
        },
        modelo: {
          type: 'string',
          description: 'Modelo, ex.: claude-sonnet-5-5 ou gpt-6.1-sol. Vazio usa o padrão.',
        },
        space: {
          type: 'string',
          description: 'ID do Space onde o agente roda. Vazio usa o seu Space atual.',
        },
      },
      required: ['titulo', 'prompt', 'provedor'],
      additionalProperties: false,
    },
    run: args => {
      const cli = [
        'node',
        'create',
        'agent',
        '--provider',
        text(args.provedor, 'provedor')!,
        '--title',
        text(args.titulo, 'titulo')!,
        '--prompt-file',
        '-',
        '--fields',
        'node.id,node.title,node.spaceId,node.data.executionDirectory',
      ]
      const model = text(args.modelo, 'modelo', false)
      if (model) {
        cli.push('--model', model)
      }
      const space = text(args.space, 'space', false)
      if (space) {
        cli.push('--space', space)
      }
      return runCli(cli, text(args.prompt, 'prompt')!)
    },
  },
  {
    name: 'agente_mensagem',
    description:
      'Manda uma mensagem a um agente do time. Recusa se ele estiver no meio de um turno: espere com agentes_esperar e tente de novo. Nunca reenvie sem antes ler a tela.',
    leadOnly: true,
    inputSchema: {
      type: 'object',
      properties: { agente: AGENT_SELECTOR, texto: { type: 'string' } },
      required: ['agente', 'texto'],
      additionalProperties: false,
    },
    run: args =>
      runCli(
        [
          'agent',
          'prompt',
          '--node',
          text(args.agente, 'agente')!,
          '--text-file',
          '-',
          '--if-busy',
          'refuse',
        ],
        text(args.texto, 'texto')!,
      ),
  },
  {
    name: 'agentes_esperar',
    description:
      'Espera agentes do time. Com "qualquer" (padrão), volta quando o primeiro terminar o turno (idle) ou parar esperando alguém (waiting). Código 10 = alguém está esperando: leia a tela dele. Código 124 = acabou o tempo.',
    inputSchema: {
      type: 'object',
      properties: {
        agentes: { type: 'array', items: { type: 'string' }, description: 'IDs dos agentes.' },
        ate: {
          type: 'string',
          enum: ['idle', 'waiting', 'exited', 'turn-end'],
          description: 'Condição; padrão idle.',
        },
        todos: {
          type: 'boolean',
          description: 'true = espera todos; false (padrão) = o primeiro.',
        },
        timeout: { type: 'string', description: 'Ex.: 30s, 10m. Padrão 10m.' },
      },
      required: ['agentes'],
      additionalProperties: false,
    },
    run: args => {
      const cli = ['agent', 'wait', '--until', text(args.ate, 'ate', false) ?? 'idle']
      for (const node of list(args.agentes, 'agentes')) {
        cli.push('--node', node)
      }
      cli.push(args.todos === true ? '--all' : '--any')
      cli.push('--timeout', text(args.timeout, 'timeout', false) ?? '10m')
      return runCli(cli)
    },
  },
  {
    name: 'agente_ler',
    description:
      'Lê a última resposta de um agente. Com tela=true, mostra a tela atual do terminal dele (use quando ele estiver esperando ou travado).',
    inputSchema: {
      type: 'object',
      properties: { agente: AGENT_SELECTOR, tela: { type: 'boolean' } },
      required: ['agente'],
      additionalProperties: false,
    },
    run: args => {
      const cli = ['agent', 'read', '--node', text(args.agente, 'agente')!]
      if (args.tela === true) {
        cli.push('--screen', '--lines', '60')
      }
      return runCli(cli)
    },
  },
  ...CARD_TOOLS,
  {
    name: 'tarefa_encerrar',
    description:
      'Encerra a tarefa em que você está (o Space top-level com worktree): arquiva a worktree (recusa se houver mudança sem commit, a não ser com forcar=true), fecha as janelas da tarefa, remove a aba e, por último, fecha a sua própria janela. Use só depois que o vings mandar e o trabalho já estiver na main.',
    leadOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        apagar_branch: {
          type: 'boolean',
          description:
            'Apaga também a branch da tarefa (padrão true; use false se ela ainda não foi para a main).',
        },
        forcar: {
          type: 'boolean',
          description: 'Descarta mudanças sem commit. Só com ordem explícita do vings.',
        },
      },
      additionalProperties: false,
    },
    run: args =>
      closeTask({ deleteBranch: args.apagar_branch !== false, force: args.forcar === true }),
  },
  {
    name: 'agente_encerrar',
    description:
      'Fecha a janela de um agente do time e encerra o processo dele. Só o líder pode usar.',
    leadOnly: true,
    inputSchema: {
      type: 'object',
      properties: { agente: AGENT_SELECTOR },
      required: ['agente'],
      additionalProperties: false,
    },
    run: args => runCli(['node', 'delete', '--node', text(args.agente, 'agente')!]),
  },
]

let callerIsLead: Promise<boolean> | null = null

/** Only an agent the user started (lineageDepth 1) leads; agents it created cannot spawn more. */
function resolveCallerIsLead(): Promise<boolean> {
  callerIsLead ??= runCli(['node', 'get', '--node', '@self', '--fields', 'lineageDepth']).then(
    result => {
      if (result.code !== 0) {
        return false
      }
      try {
        const parsed = JSON.parse(result.stdout) as {
          node?: { lineageDepth?: unknown }
          lineageDepth?: unknown
        }
        const depth = parsed.node?.lineageDepth ?? parsed.lineageDepth
        return depth === 1
      } catch {
        return false
      }
    },
  )
  return callerIsLead
}

function toolResult(result: CliResult): Record<string, unknown> {
  const body = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n')
  const clipped =
    body.length > MAX_OUTPUT_CHARS ? `${body.slice(0, MAX_OUTPUT_CHARS)}\n…(cortado)` : body
  return {
    content: [
      { type: 'text', text: `${clipped || '(sem saída)'}\n[código de saída ${result.code}]` },
    ],
    isError: result.code !== 0 && result.code !== 10,
  }
}

export async function handleRequest(
  request: JsonRpcRequest,
): Promise<Record<string, unknown> | null> {
  switch (request.method) {
    case 'initialize':
      return {
        protocolVersion:
          typeof request.params?.protocolVersion === 'string'
            ? request.params.protocolVersion
            : PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions:
          'Ferramentas do time do Eclipse Code. O líder (agente aberto pelo vings) cria o Space da tarefa, cria os agentes do time, conversa com eles, espera as respostas e pergunta ao vings com pergunta_criar (card no canvas, não no terminal). Membros do time só leem.',
      }
    case 'ping':
      return {}
    case 'tools/list':
      return {
        tools: TOOLS.map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema,
        })),
      }
    case 'tools/call': {
      const name = request.params?.name
      const tool = TOOLS.find(candidate => candidate.name === name)
      if (!tool) {
        throw Object.assign(new Error(`Ferramenta desconhecida: ${String(name)}`), {
          rpcCode: -32602,
        })
      }
      if (process.env['ECLIPSE_CODE_ENV'] !== '1') {
        return toolResult({
          code: 3,
          stdout: '',
          stderr:
            'Fora do Eclipse Code: estas ferramentas só funcionam num agente aberto pelo app.',
        })
      }
      if (tool.leadOnly && !(await resolveCallerIsLead())) {
        return toolResult({
          code: 4,
          stdout: '',
          stderr:
            'Só o líder do time (agente aberto pelo vings) pode usar esta ferramenta. Termine o turno com STATUS: DUVIDA e explique o que precisa.',
        })
      }
      const args = (request.params?.arguments ?? {}) as Record<string, unknown>
      try {
        return toolResult(await tool.run(args))
      } catch (error) {
        return toolResult({
          code: 2,
          stdout: '',
          stderr: error instanceof Error ? error.message : String(error),
        })
      }
    }
    default:
      if (request.method.startsWith('notifications/')) {
        return null
      }
      throw Object.assign(new Error(`Método não suportado: ${request.method}`), { rpcCode: -32601 })
  }
}

export async function runMcpServer(): Promise<number> {
  const write = (message: Record<string, unknown>) => {
    process.stdout.write(`${JSON.stringify(message)}\n`)
  }
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
  const pending = new Set<Promise<void>>()
  for await (const line of lines) {
    if (!line.trim()) {
      continue
    }
    let request: JsonRpcRequest
    try {
      request = JSON.parse(line) as JsonRpcRequest
    } catch {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON inválido' } })
      continue
    }
    const task = handleRequest(request)
      .then(result => {
        if (request.id !== undefined && request.id !== null && result !== null) {
          write({ jsonrpc: '2.0', id: request.id, result })
        }
      })
      .catch((error: unknown) => {
        if (request.id === undefined || request.id === null) {
          return
        }
        const code = (error as { rpcCode?: number }).rpcCode ?? -32603
        write({
          jsonrpc: '2.0',
          id: request.id,
          error: { code, message: error instanceof Error ? error.message : String(error) },
        })
      })
      .finally(() => pending.delete(task))
    pending.add(task)
  }
  await Promise.all(pending)
  return 0
}
