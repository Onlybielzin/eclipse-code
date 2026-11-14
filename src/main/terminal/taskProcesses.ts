/**
 * Processos da worktree da tarefa: aba Iniciar (`$SHELL -lc <comando>`) e aba Terminal
 * (`$SHELL -l`). Um de cada tipo por tarefa. Usam o PtyHost mas NAO criam Session:
 * o limite de agentes conta sessoes, nao pty.
 *
 * Nao persistem: depois do reinicio o mapa esta vazio e a tela volta ao estado "parado".
 */
import { realpathSync, statSync } from 'node:fs'
import { isAbsolute, resolve, sep } from 'node:path'
import { DomainError, type Project, type Task, type TaskId } from '@shared/domain'
import type { PtyExit, PtyHost, Unsubscribe } from '@shared/ports'
import type { TaskProcessKind, TaskProcessState } from '@shared/ipc'
import { waitForPtyExit } from './ptyHost'

export interface TaskProcessesDeps {
  ptyHost: PtyHost
  tasks: { getTask(id: TaskId): Task; getProject(id: string): Project }
  shell?: () => string
  size?: { cols: number; rows: number }
  platform?: NodeJS.Platform
}

interface Slot {
  ptyId: string
  exit: PtyExit | null
}

/**
 * Subpasta relativa DENTRO de base. Recusa absoluto, `..` e symlink que escape
 * (compara o caminho real, nao o texto).
 */
export function resolveInside(base: string, dir: string | null): string {
  if (!dir) return base
  const segments = dir.split(/[\\/]+/)
  if (isAbsolute(dir) || segments.includes('..')) {
    throw new DomainError(
      'invalid_input',
      'a pasta precisa ser relativa e ficar dentro da worktree',
      {
        dir,
      },
    )
  }
  let realBase: string
  try {
    realBase = realpathSync(base)
  } catch {
    throw new DomainError('not_found', `A pasta da tarefa não existe mais: ${base}`, { base })
  }
  let real: string
  try {
    real = realpathSync(resolve(realBase, dir))
    if (!statSync(real).isDirectory()) throw new Error('não é pasta')
  } catch {
    throw new DomainError('invalid_input', `a pasta "${dir}" não existe na worktree`, { dir })
  }
  if (real !== realBase && !real.startsWith(realBase + sep)) {
    throw new DomainError('invalid_input', 'a pasta sai da worktree', { dir })
  }
  return real
}

export class TaskProcesses {
  private readonly slots = new Map<string, Slot>()
  /** Chamadas de start em andamento por `${taskId}:${kind}`: a segunda espera a primeira. */
  private readonly starting = new Map<string, Promise<TaskProcessState>>()
  private readonly off: Unsubscribe
  private readonly exitListeners = new Set<(ptyId: string, exit: PtyExit) => void>()

  constructor(private readonly deps: TaskProcessesDeps) {
    this.off = deps.ptyHost.onExit((ptyId, exit) => {
      for (const slot of this.slots.values()) {
        if (slot.ptyId === ptyId) slot.exit = exit
      }
      if (this.owns(ptyId)) for (const l of this.exitListeners) l(ptyId, exit)
    })
  }

  dispose(): void {
    this.off()
  }

  /** O ptyId e de um processo de aba (nao de um Lider)? Usado para rotear eventos e digitacao. */
  owns(ptyId: string): boolean {
    for (const slot of this.slots.values()) if (slot.ptyId === ptyId) return true
    return false
  }

  onExit(listener: (ptyId: string, exit: PtyExit) => void): Unsubscribe {
    this.exitListeners.add(listener)
    return () => this.exitListeners.delete(listener)
  }

  private baseDir(task: Task): string {
    return task.worktreePath ?? this.deps.tasks.getProject(task.projectId).rootPath
  }

  private cwdFor(task: Task, kind: TaskProcessKind): string {
    const base = this.baseDir(task)
    return kind === 'start' ? resolveInside(base, task.startDir) : base
  }

  attach(taskId: TaskId, kind: TaskProcessKind): TaskProcessState {
    const task = this.deps.tasks.getTask(taskId)
    const slot = this.slots.get(`${taskId}:${kind}`)
    const size = (slot && this.deps.ptyHost.size(slot.ptyId)) ??
      this.deps.size ?? { cols: 120, rows: 32 }
    return {
      ptyId: slot?.ptyId ?? null,
      alive: slot ? this.deps.ptyHost.isAlive(slot.ptyId) : false,
      cols: size.cols,
      rows: size.rows,
      scrollback: slot ? this.deps.ptyHost.scrollback(slot.ptyId) : '',
      exitCode: slot?.exit?.exitCode ?? null,
      exited: slot?.exit != null,
      cwd: this.baseDir(task),
    }
  }

  /** Abre o processo. Ja vivo: devolve o estado (ou, com restart, para e abre de novo). */
  start(taskId: TaskId, kind: TaskProcessKind, restart = false): Promise<TaskProcessState> {
    const key = `${taskId}:${kind}`
    const inFlight = this.starting.get(key)
    if (inFlight) return inFlight
    const run = this.doStart(taskId, kind, restart, key).finally(() => this.starting.delete(key))
    this.starting.set(key, run)
    return run
  }

  private assertNotArchived(taskId: TaskId): Task {
    const task = this.deps.tasks.getTask(taskId)
    if (task.status === 'archived') {
      throw new DomainError('invalid_transition', 'a tarefa está arquivada')
    }
    return task
  }

  private async doStart(
    taskId: TaskId,
    kind: TaskProcessKind,
    restart: boolean,
    key: string,
  ): Promise<TaskProcessState> {
    const task = this.assertNotArchived(taskId)
    const current = this.slots.get(key)
    if (current && this.deps.ptyHost.isAlive(current.ptyId)) {
      if (!restart) return this.attach(taskId, kind)
      this.deps.ptyHost.kill(current.ptyId, 'SIGTERM')
      await waitForPtyExit(this.deps.ptyHost, current.ptyId, 5000)
      if (this.deps.ptyHost.isAlive(current.ptyId)) {
        throw new DomainError('unavailable', 'o processo anterior não parou; tente de novo')
      }
      this.assertNotArchived(taskId)
    }
    const win = (this.deps.platform ?? process.platform) === 'win32'
    let args = win ? [] : ['-l']
    if (kind === 'start') {
      if (!task.startCommand) {
        throw new DomainError('invalid_input', 'a tarefa não tem comando para iniciar')
      }
      args = win ? ['/d', '/s', '/c', task.startCommand] : ['-lc', task.startCommand]
    }
    const cwd = this.cwdFor(task, kind)
    const size = this.deps.size ?? { cols: 120, rows: 32 }
    const command =
      this.deps.shell?.() ??
      (win ? (process.env['COMSPEC'] ?? 'cmd.exe') : process.env['SHELL'] || '/bin/bash')
    const { ptyId } = await this.deps.ptyHost.spawn({
      command,
      args,
      cwd,
      env: process.env as Record<string, string>,
      cols: size.cols,
      rows: size.rows,
      label: `${kind} ${taskId}`,
    })
    // Arquivar durante o restart/spawn: nao deixa o processo novo orfao.
    if (this.deps.tasks.getTask(taskId).status === 'archived') {
      this.deps.ptyHost.kill(ptyId, 'SIGTERM')
      throw new DomainError('invalid_transition', 'a tarefa está arquivada')
    }
    this.slots.set(key, { ptyId, exit: null })
    return this.attach(taskId, kind)
  }

  write(ptyId: string, data: string): void {
    this.deps.ptyHost.write(ptyId, data)
  }

  resize(ptyId: string, cols: number, rows: number): void {
    this.deps.ptyHost.resize(ptyId, cols, rows)
  }

  /** SIGTERM ao grupo (o PtyHost escala para SIGKILL depois do prazo). */
  stop(taskId: TaskId, kind: TaskProcessKind): void {
    const slot = this.slots.get(`${taskId}:${kind}`)
    if (slot && this.deps.ptyHost.isAlive(slot.ptyId)) this.deps.ptyHost.kill(slot.ptyId, 'SIGTERM')
  }

  stopTask(taskId: TaskId): void {
    this.stop(taskId, 'start')
    this.stop(taskId, 'shell')
  }
}
