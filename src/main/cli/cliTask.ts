import { readFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { join } from 'node:path'
import { MAX_DESCRIPTION_CHARS, MAX_TITLE_CHARS } from '@shared/schemas'
import { MCP_BRIDGE_PROTOCOL_VERSION } from '@shared/mcp'
import { resolveAppPaths } from '../app/paths'
import { CLI_TOKEN_FILE_NAME, mcpSocketPath } from '../mcp/bridgeServer'
import { readLines, writeLine } from '../mcp/ndjson'

export const CLI_USAGE = [
  'Uso: eclipse-code tarefa iniciar --projeto <id ou nome> --titulo "<texto>"',
  '       [--descricao "<texto>" | --descricao -] [--depois-de <id da tarefa>] [--sem-worktree] [--json]',
  '  --descricao -   lê a descrição do stdin',
  '  --depois-de     a tarefa nova só começa quando essa tarefa for lançada',
  'Precisa do Eclipse Code aberto nesta sessão gráfica.',
].join('\n')

export const APP_CLOSED_MESSAGE = 'O Eclipse Code não está aberto. Abra o app e rode de novo.'

export interface CliTaskArgs {
  projeto: string
  titulo: string
  /** '-' pede a leitura do stdin. */
  descricao: string | undefined
  worktree: boolean
  /** Id da tarefa que a nova espera. */
  depoisDe: string | undefined
  json: boolean
  userDataDir: string | undefined
}

export type CliParse =
  { kind: 'none' } | { kind: 'help' } | { kind: 'usage'; message: string } | { kind: 'run'; args: CliTaskArgs }

/** Flags do Chromium/Electron/lançador: o parser as ignora (com ou sem valor após '='). */
const CHROMIUM_FLAG =
  /^--(ozone-|no-sandbox|disable-|enable-|use-|force-|class|gtk-version|js-flags|inspect|remote-debugging|password-store|app-id|disk-cache)/

const VALUE_FLAGS = new Set(['projeto', 'titulo', 'descricao', 'depois-de', 'user-data-dir'])

/**
 * Lê process.argv. 'none' quando o subcomando `tarefa` não aparece (o app abre normal).
 * `tarefa` vale como subcomando se só flags (ou no máximo o caminho do app, no dev) vêm antes.
 */
export function parseCliArgs(argv: readonly string[]): CliParse {
  const rest = argv.slice(1)
  const at = rest.findIndex((a) => a === 'tarefa')
  if (at === -1) return { kind: 'none' }
  // No dev o caminho do app vem antes (`electron . tarefa`): no máximo um argumento sem '-'.
  if (rest.slice(0, at).filter((a) => !a.startsWith('-')).length > 1) return { kind: 'none' }
  const usage = (message: string): CliParse => ({ kind: 'usage', message })
  const tail = rest.slice(at + 1)
  if (tail.length === 0 || tail.some((a) => a === '--help' || a === '-h')) return { kind: 'help' }
  if (tail[0] !== 'iniciar') return usage('Subcomando desconhecido. Use: tarefa iniciar.')
  const values = new Map<string, string>()
  // Chromium aceita `--user-data-dir X` do lançador; as nossas aceitam `--flag X` e `--flag=X`.
  for (const f of rest.slice(0, at)) {
    const m = /^--user-data-dir=(.+)$/.exec(f)
    if (m?.[1]) values.set('user-data-dir', m[1])
  }
  let semWorktree = false
  let json = false
  for (let i = 1; i < tail.length; i++) {
    const arg = tail[i] as string
    if (!arg.startsWith('--')) return usage(`Argumento inesperado: ${arg}`)
    const eq = arg.indexOf('=')
    const name = arg.slice(2, eq === -1 ? undefined : eq)
    if (name === 'sem-worktree') semWorktree = true
    else if (name === 'json') json = true
    else if (VALUE_FLAGS.has(name)) {
      let value: string | undefined
      if (eq !== -1) value = arg.slice(eq + 1)
      else {
        value = tail[i + 1]
        i++
      }
      if (value === undefined) return usage(`A flag --${name} precisa de um valor.`)
      values.set(name, value)
    } else if (!CHROMIUM_FLAG.test(arg)) return usage(`Flag desconhecida: ${arg}`)
  }
  const projeto = values.get('projeto')?.trim()
  const titulo = values.get('titulo')?.trim()
  if (!projeto) return usage('Falta --projeto.')
  if (!titulo) return usage('Falta --titulo.')
  if (titulo.length > MAX_TITLE_CHARS)
    return usage(`O título passa de ${MAX_TITLE_CHARS} caracteres.`)
  return {
    kind: 'run',
    args: {
      projeto,
      titulo,
      descricao: values.get('descricao'),
      worktree: !semWorktree,
      depoisDe: values.get('depois-de')?.trim() || undefined,
      json,
      userDataDir: values.get('user-data-dir'),
    },
  }
}

export interface CliIo {
  env: NodeJS.ProcessEnv
  readStdin: () => Promise<string>
  stdout: (text: string) => void
  stderr: (text: string) => void
  /** Injetável para teste. Padrão: runtime de resolveAppPaths. */
  runtimeDir?: string
  timeoutMs?: number
}

interface TaskData {
  tarefa_id: string
  projeto_id: string
  projeto: string
  nome: string
  branch: string | null
  depois_de: string | null
  /** true = a tarefa nasceu esperando a outra subir; o Líder ainda não abriu. */
  aguardando: boolean
}

/** Uma chamada task.create na ponte. Rejeita com Error(message) legível para o terminal. */
async function callBridge(
  socketPath: string,
  token: string,
  params: {
    projeto: string
    titulo: string
    descricao?: string
    worktree: boolean
    depois_de?: string
  },
  timeoutMs: number,
): Promise<TaskData> {
  return new Promise<TaskData>((resolve, reject) => {
    const socket = connect(socketPath)
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('O app não respondeu a tempo.'))
    }, timeoutMs)
    const done = (fn: () => void) => {
      clearTimeout(timer)
      socket.destroy()
      fn()
    }
    socket.once('error', (e: NodeJS.ErrnoException) =>
      done(() =>
        reject(
          e.code === 'ENOENT' || e.code === 'ECONNREFUSED'
            ? new Error(APP_CLOSED_MESSAGE)
            : new Error(`Falha ao falar com o app: ${e.message}`),
        ),
      ),
    )
    socket.once('connect', () =>
      writeLine(socket, {
        v: MCP_BRIDGE_PROTOCOL_VERSION,
        id: 1,
        token,
        method: 'task.create',
        params,
      }),
    )
    socket.once('close', () => done(() => reject(new Error('O app fechou a conexão.'))))
    readLines(
      socket,
      (line) => {
        const msg = JSON.parse(line) as {
          ok?: boolean
          result?: { data?: TaskData }
          error?: { message?: string }
        }
        if (msg.ok && msg.result?.data) done(() => resolve(msg.result?.data as TaskData))
        else done(() => reject(new Error(msg.error?.message ?? 'O app recusou o pedido.')))
      },
      () => done(() => reject(new Error('Resposta grande demais do app.'))),
    )
  })
}

/** Roda o comando e devolve o código de saída: 0 ok, 1 erro, 2 uso errado. */
export async function runCliTask(parse: CliParse, io: CliIo): Promise<number> {
  if (parse.kind === 'none') return 0
  if (parse.kind === 'help') {
    io.stdout(`${CLI_USAGE}\n`)
    return 0
  }
  if (parse.kind === 'usage') {
    io.stderr(`${parse.message}\n${CLI_USAGE}\n`)
    return 2
  }
  const { args } = parse
  try {
    let descricao = args.descricao
    if (descricao === '-') descricao = await io.readStdin()
    if (descricao !== undefined && descricao.length > MAX_DESCRIPTION_CHARS) {
      io.stderr(`A descrição passa de ${MAX_DESCRIPTION_CHARS} caracteres.\n`)
      return 2
    }
    const runtime = io.runtimeDir ?? resolveAppPaths(io.env, undefined, args.userDataDir).runtime
    // shortcut: no Windows o pipe tem nome aleatório que o comando não descobre; só unix, por ora.
    if (process.platform === 'win32') throw new Error(APP_CLOSED_MESSAGE)
    const token = (
      await readFile(join(runtime, CLI_TOKEN_FILE_NAME), 'utf8').catch(() => {
        throw new Error(APP_CLOSED_MESSAGE)
      })
    ).trim()
    const data = await callBridge(
      mcpSocketPath(runtime, 'mcp.sock'),
      token,
      {
        projeto: args.projeto,
        titulo: args.titulo,
        ...(descricao ? { descricao } : {}),
        worktree: args.worktree,
        ...(args.depoisDe ? { depois_de: args.depoisDe } : {}),
      },
      io.timeoutMs ?? 120_000,
    )
    io.stdout(
      args.json
        ? `${JSON.stringify(data)}\n`
        : `Tarefa criada no projeto ${data.projeto}: ${data.nome} (${data.tarefa_id}), ${
            data.branch ? `branch ${data.branch}` : 'sem worktree'
          }. ${
            data.aguardando
              ? 'Ela começa quando a tarefa indicada em --depois-de for lançada.'
              : 'O Líder já está abrindo.'
          }\n`,
    )
    return 0
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}
