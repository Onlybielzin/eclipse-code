import { spawn as nodeSpawn } from 'node:child_process'
import {
  EXTERNAL_TERMINALS,
  buildExternalTerminalCommand,
  type ExternalTerminalSettings,
} from '@shared/externalTerminal'
import { DomainError } from '@shared/domain'
import { resolveExecutableOnPath } from '../leader/executable'
import { envValue, sanitizeInheritedEnv } from './spawnEnv'

const SETTING_KEY = 'externalTerminal'

export interface ExternalChild {
  once(event: 'spawn', listener: () => void): unknown
  once(event: 'error', listener: (error: Error) => void): unknown
  unref(): void
}

export type SpawnExternal = (
  command: string,
  args: string[],
  options: { cwd: string; env: Record<string, string>; detached: true; stdio: 'ignore' },
) => ExternalChild

export interface ExternalTerminalOptions {
  settings: { getSetting(key: string): string | null; setSetting(key: string, valueJson: string): void }
  tasks: {
    getTask(id: string): { projectId: string; worktreePath: string | null }
    getProject(id: string): { rootPath: string }
  }
  platform?: NodeJS.Platform
  env?: Record<string, string | undefined>
  /** Injetavel para os testes nunca abrirem janela. */
  spawn?: SpawnExternal
  resolveExecutable?: typeof resolveExecutableOnPath
}

export interface ExternalTerminalService {
  get(): ExternalTerminalSettings
  save(id: string | null): ExternalTerminalSettings
  open(taskId: string): Promise<void>
}

export function createExternalTerminalService(options: ExternalTerminalOptions): ExternalTerminalService {
  const platform = options.platform ?? process.platform
  const key = platform === 'win32' ? 'win32' : platform === 'darwin' ? 'darwin' : 'linux'
  const defs = EXTERNAL_TERMINALS.filter((t) => t.platform === key)
  const resolve = options.resolveExecutable ?? resolveExecutableOnPath
  const spawn = options.spawn ?? (nodeSpawn as unknown as SpawnExternal)
  const baseEnv = (): Record<string, string | undefined> => options.env ?? process.env
  const find = (command: string) =>
    resolve(command, envValue(baseEnv(), 'PATH'), { platform })

  const readSelected = (): string | null => {
    const raw = options.settings.getSetting(SETTING_KEY)
    if (raw === null) return null
    try {
      const id: unknown = JSON.parse(raw)
      return defs.some((d) => d.id === id) ? (id as string) : null
    } catch {
      return null
    }
  }

  const get = (): ExternalTerminalSettings => ({
    selected: readSelected(),
    options: defs.map((d) => ({ id: d.id, label: d.label, available: find(d.command) !== null })),
  })

  return {
    get,
    save(id) {
      if (id !== null && !defs.some((d) => d.id === id)) {
        throw new DomainError('invalid_input', 'Esse terminal não existe neste sistema.', { id })
      }
      options.settings.setSetting(SETTING_KEY, JSON.stringify(id))
      return get()
    },
    async open(taskId) {
      const task = options.tasks.getTask(taskId)
      const directory = task.worktreePath ?? options.tasks.getProject(task.projectId).rootPath
      const { selected, options: list } = get()
      const def = selected
        ? defs.find((d) => d.id === selected)
        : defs.find((d) => list.find((o) => o.id === d.id)?.available)
      const executable = def ? find(def.command) : null
      if (!def || !executable) {
        throw new DomainError(
          'unavailable',
          def
            ? `O terminal ${def.label} não foi encontrado no PATH. Escolha outro em Configurações.`
            : 'Nenhum terminal conhecido foi encontrado neste computador. Instale um e escolha em Configurações.',
          { terminal: def?.id ?? null },
        )
      }
      const { args } = buildExternalTerminalCommand(def.id, directory)
      const env = sanitizeInheritedEnv(baseEnv(), { platform })
      await new Promise<void>((done, fail) => {
        const child = spawn(executable, args, { cwd: directory, env, detached: true, stdio: 'ignore' })
        child.once('error', (error) =>
          fail(
            new DomainError('unavailable', `Não foi possível abrir o ${def.label}: ${error.message}`, {
              terminal: def.id,
            }),
          ),
        )
        child.once('spawn', () => {
          child.unref()
          done()
        })
      })
    },
  }
}
