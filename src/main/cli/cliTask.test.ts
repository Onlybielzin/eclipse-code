import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { McpCliTaskInput, McpToolResult } from '@shared/mcp'
import type { McpBridgeServer } from '@shared/ports'
import { createMcpBridgeServer } from '../mcp/bridgeServer'
import { APP_CLOSED_MESSAGE, CLI_USAGE, parseCliArgs, runCliTask, type CliIo } from './cliTask'

const base = ['/app/eclipse-code', '--ozone-platform-hint=auto', 'tarefa', 'iniciar']

function run(...extra: string[]) {
  return parseCliArgs([...base, ...extra])
}

describe('parseCliArgs', () => {
  it('sem o subcomando tarefa o app abre normal', () => {
    expect(parseCliArgs(['/app/eclipse-code', '--no-sandbox'])).toEqual({ kind: 'none' })
    expect(parseCliArgs(['/app/eclipse-code', '--smoke'])).toEqual({ kind: 'none' })
  })

  it('aceita os argumentos válidos e ignora flags do Chromium', () => {
    expect(
      run('--projeto', 'Ereemby', '--titulo', 'Ajustar login', '--sem-worktree', '--json'),
    ).toEqual({
      kind: 'run',
      args: {
        projeto: 'Ereemby',
        titulo: 'Ajustar login',
        descricao: undefined,
        worktree: false,
        depoisDe: undefined,
        json: true,
        userDataDir: undefined,
      },
    })
    const out = run('--projeto=x', '--titulo=y', '--descricao', '-', '--no-sandbox')
    expect(out).toMatchObject({ kind: 'run', args: { descricao: '-', worktree: true } })
  })

  it('aceita o caminho do app antes de tarefa (dev) e --user-data-dir', () => {
    const out = parseCliArgs([
      'electron',
      '--user-data-dir=/tmp/x',
      '.',
      'tarefa',
      'iniciar',
      '--projeto',
      'p',
      '--titulo',
      't',
    ])
    expect(out).toMatchObject({ kind: 'run', args: { userDataDir: '/tmp/x' } })
  })

  it('--help, -h e tarefa sozinho pedem a ajuda', () => {
    const app = ['/app/eclipse-code']
    expect(parseCliArgs([...app, 'tarefa'])).toEqual({ kind: 'help' })
    expect(parseCliArgs([...app, 'tarefa', '--help'])).toEqual({ kind: 'help' })
    expect(parseCliArgs([...app, 'tarefa', '-h'])).toEqual({ kind: 'help' })
    expect(run('--help')).toEqual({ kind: 'help' })
    expect(run('--projeto', 'p', '-h')).toEqual({ kind: 'help' })
    expect(CLI_USAGE).toContain('Precisa do Eclipse Code aberto nesta sessão gráfica.')
  })

  it('falta --projeto ou --titulo é uso errado', () => {
    expect(run('--titulo', 't')).toMatchObject({ kind: 'usage', message: 'Falta --projeto.' })
    expect(run('--projeto', 'p')).toMatchObject({ kind: 'usage', message: 'Falta --titulo.' })
    expect(run('--projeto')).toMatchObject({ kind: 'usage' })
  })

  it('flag desconhecida e subcomando desconhecido são uso errado', () => {
    expect(run('--projeto', 'p', '--titulo', 't', '--foo')).toMatchObject({
      kind: 'usage',
      message: 'Flag desconhecida: --foo',
    })
    expect(parseCliArgs(['/app', 'tarefa', 'apagar'])).toMatchObject({ kind: 'usage' })
  })
})

describe('runCliTask contra uma ponte de teste', () => {
  let dir: string
  let bridge: McpBridgeServer
  let startTaskFromCli: Mock<(input: McpCliTaskInput) => Promise<McpToolResult>>
  let out: string[]
  let err: string[]

  const io = (stdin = ''): CliIo => ({
    env: {},
    runtimeDir: join(dir, 'run'),
    readStdin: async () => stdin,
    stdout: (t) => void out.push(t),
    stderr: (t) => void err.push(t),
  })
  const data = {
    tarefa_id: 'abc',
    projeto_id: 'p1',
    projeto: 'Ereemby',
    nome: 'Ajustar login',
    branch: 'eclipse/abc',
    depois_de: null,
    aguardando: false,
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ecn-cli-'))
    out = []
    err = []
    startTaskFromCli = vi.fn(async (): Promise<McpToolResult> => ({ text: 'ok', data }))
    bridge = createMcpBridgeServer({
      runtimeDir: join(dir, 'run'),
      serverScriptPath: '/x.js',
    })
    await bridge.start({ callTool: vi.fn(), startTaskFromCli })
  })

  afterEach(async () => {
    await bridge.stop()
    rmSync(dir, { recursive: true, force: true })
  })

  it('ajuda: stdout com código 0', async () => {
    expect(await runCliTask({ kind: 'help' }, io())).toBe(0)
    expect(out.join('')).toBe(`${CLI_USAGE}\n`)
    expect(err).toEqual([])
  })

  it('erro ao ler o stdin: stderr e código 1, sem rejeitar', async () => {
    const failing = { ...io(), readStdin: async () => Promise.reject(new Error('stdin quebrou')) }
    const code = await runCliTask(run('--projeto', 'p', '--titulo', 't', '--descricao', '-'), failing)
    expect(code).toBe(1)
    expect(err.join('')).toBe('stdin quebrou\n')
  })

  it('texto: imprime a frase e repassa descrição do stdin', async () => {
    const code = await runCliTask(
      run('--projeto', 'ereemby', '--titulo', 'Ajustar login', '--descricao', '-'),
      io('detalhes\nem duas linhas'),
    )
    expect(code).toBe(0)
    expect(out.join('')).toBe(
      'Tarefa criada no projeto Ereemby: Ajustar login (abc), branch eclipse/abc. O Líder já está abrindo.\n',
    )
    expect(startTaskFromCli).toHaveBeenCalledWith({
      projeto: 'ereemby',
      titulo: 'Ajustar login',
      descricao: 'detalhes\nem duas linhas',
      worktree: true,
    })
  })

  it('--depois-de chega à ponte como depois_de e o texto avisa da espera', async () => {
    startTaskFromCli.mockResolvedValueOnce({
      text: 'ok',
      data: { ...data, depois_de: 'A1', aguardando: true },
    })
    const code = await runCliTask(
      run('--projeto', 'p', '--titulo', 't', '--depois-de', 'A1'),
      io(),
    )
    expect(code).toBe(0)
    expect(startTaskFromCli).toHaveBeenCalledWith(expect.objectContaining({ depois_de: 'A1' }))
    expect(out.join('')).toContain('Ela começa quando a tarefa indicada em --depois-de for lançada.')
    expect(CLI_USAGE).toContain('--depois-de')
  })

  it('--depois-de com id inexistente: erro do app no stderr, código 1', async () => {
    startTaskFromCli.mockRejectedValueOnce(
      new Error('A tarefa indicada em depois_de não existe: zzz.'),
    )
    const code = await runCliTask(run('--projeto', 'p', '--titulo', 't', '--depois-de', 'zzz'), io())
    expect(code).toBe(1)
    expect(err.join('')).toContain('não existe: zzz.')
  })

  it('--json imprime o data e --sem-worktree chega à ponte', async () => {
    startTaskFromCli.mockResolvedValueOnce({ text: 'ok', data: { ...data, branch: null } })
    const code = await runCliTask(
      run('--projeto', 'p', '--titulo', 't', '--sem-worktree', '--json'),
      io(),
    )
    expect(code).toBe(0)
    expect(JSON.parse(out.join(''))).toEqual({ ...data, branch: null })
    expect(JSON.parse(out.join(''))).toHaveProperty('depois_de', null)
    expect(startTaskFromCli).toHaveBeenCalledWith(expect.objectContaining({ worktree: false }))
  })

  it('projeto inexistente: erro do app no stderr, código 1', async () => {
    startTaskFromCli.mockRejectedValueOnce(new Error('projeto "x" nao existe. Projetos: A, B'))
    const code = await runCliTask(run('--projeto', 'x', '--titulo', 't'), io())
    expect(code).toBe(1)
    expect(out).toEqual([])
    expect(err.join('')).toContain('nao existe. Projetos: A, B')
  })

  it('app fechado (sem socket nem token): mensagem e código 1', async () => {
    await bridge.stop()
    const code = await runCliTask(run('--projeto', 'x', '--titulo', 't'), io())
    expect(code).toBe(1)
    expect(err.join('')).toBe(`${APP_CLOSED_MESSAGE}\n`)
  })

  it('uso errado: ajuda curta no stderr, código 2', async () => {
    const code = await runCliTask(run('--titulo', 't'), io())
    expect(code).toBe(2)
    expect(err.join('')).toContain('Uso: eclipse-code tarefa iniciar')
  })
})
