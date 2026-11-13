/**
 * Execucao de git sem shell (execFile). Copiado de GitWorktreeService.shared.ts do
 * app antigo, sem o CommandEnvironmentService.
 */
import { execFile } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { DomainError } from '@shared/domain'

const OBSERVATION_TIMEOUT_MS = 30_000
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024

export interface GitResult {
  exitCode: number
  stdout: string
  stderr: string
}

/**
 * 'observation' le sem pegar lock opcional e tem prazo. 'mutation' nunca tem prazo
 * fixo: matar git no meio pode deixar index.lock para tras.
 */
export type GitIntent = 'observation' | 'mutation'

/** Variaveis que fariam o git operar em outro repo (ex: herdadas de um hook). */
const LEAKY_GIT_ENV = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_PREFIX',
]

export function gitEnv(intent: GitIntent): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' }
  for (const key of LEAKY_GIT_ENV) delete env[key]
  if (intent === 'observation') env['GIT_OPTIONAL_LOCKS'] = '0'
  return env
}

export function runGit(args: string[], cwd: string, intent: GitIntent): Promise<GitResult> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      'git',
      args,
      {
        cwd,
        env: gitEnv(intent),
        timeout: intent === 'observation' ? OBSERVATION_TIMEOUT_MS : 0,
        maxBuffer: MAX_OUTPUT_BYTES,
        encoding: 'utf8',
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          const code: unknown = (error as { code?: unknown }).code
          if (code === 'ENOENT') {
            // Falha no spawn: git nao instalado OU cwd inexistente.
            reject(
              new DomainError('unavailable', 'git não encontrado ou pasta inexistente', {
                cwd,
                debug: error.message,
              }),
            )
            return
          }
          // Numero = codigo de saida. Outro caso (prazo, sinal, saida grande demais) = falha.
          const exitCode = typeof code === 'number' ? code : 1
          const extra = typeof code === 'number' ? '' : `\n${error.message}`
          resolvePromise({
            exitCode,
            stdout: String(stdout ?? ''),
            stderr: `${String(stderr ?? '')}${extra}`,
          })
          return
        }
        resolvePromise({ exitCode: 0, stdout: String(stdout), stderr: String(stderr) })
      },
    )
  })
}

export function firstLine(text: string | null | undefined): string | null {
  const trimmed = (text ?? '').trim()
  return trimmed.length > 0 ? trimmed : null
}

/**
 * Caminho real (resolve symlinks). Correcao do app antigo: toda comparacao de
 * caminho de worktree usa isto, senao /tmp -> /private/tmp ou uma pasta
 * ligada por symlink nunca casa com a saida do `git worktree list`.
 */
export async function toCanonicalPath(path: string): Promise<string> {
  const normalized = resolve(path)
  try {
    return await realpath(normalized)
  } catch {
    return normalized
  }
}

/** Como toCanonicalPath, mas para caminho que ainda nao existe: resolve o pai. */
export async function toCanonicalPathEvenIfMissing(path: string): Promise<string> {
  const normalized = resolve(path)
  try {
    return await realpath(normalized)
  } catch {
    try {
      return resolve(await realpath(dirname(normalized)), basename(normalized))
    } catch {
      return normalized
    }
  }
}
