import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Task } from '@shared/domain'
import { createHarness, seedTeam } from '../tasks/testing'
import { assertAgentCapacity } from '../tasks/agentLimits'
import { createPtyHost, type PtyProcessLike, type SpawnPty } from './ptyHost'
import { TaskProcesses } from './taskProcesses'

interface Call {
  file: string
  args: string[]
  cwd: string
}

class FakePty implements PtyProcessLike {
  pid = 4242
  killed: string[] = []
  private dataFns: Array<(d: string) => void> = []
  private exitFns: Array<(e: { exitCode: number; signal?: number }) => void> = []
  write(): void {}
  resize(): void {}
  kill(signal?: string): void {
    this.killed.push(signal ?? 'SIGHUP')
    this.emitExit(0)
  }
  onData(fn: (d: string) => void) {
    this.dataFns.push(fn)
    return { dispose: () => undefined }
  }
  onExit(fn: (e: { exitCode: number; signal?: number }) => void) {
    this.exitFns.push(fn)
    return { dispose: () => undefined }
  }
  emitData(d: string): void {
    this.dataFns.forEach((f) => f(d))
  }
  emitExit(exitCode: number): void {
    this.exitFns.forEach((f) => f({ exitCode }))
  }
}

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function setup() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'tp-')))
  dirs.push(base)
  mkdirSync(join(base, 'wt', 'app'), { recursive: true })
  const wt = join(base, 'wt')
  const h = createHarness()
  const fx = seedTeam(h.service)
  // seedTeam aponta a worktree para um caminho que nao existe: usa uma tarefa propria.
  const task = h.service.createTask({
    projectId: fx.project.id,
    title: 'Rodar app',
    kind: 'team',
    worktreePath: wt,
    branch: 'feat/rodar',
    baseBranch: 'main',
    leadRoleId: null,
    soloProvider: null,
  })
  const calls: Call[] = []
  const ptys: FakePty[] = []
  const spawnPty: SpawnPty = (file, args, o) => {
    calls.push({ file, args, cwd: o.cwd })
    const p = new FakePty()
    ptys.push(p)
    return p
  }
  const ptyHost = createPtyHost({ spawnPty, signalGroup: () => false })
  const procs = new TaskProcesses({ ptyHost, tasks: h.service, shell: () => '/bin/zsh' })
  return { h, fx, task, wt, base, calls, ptys, ptyHost, procs }
}

describe('TaskProcesses', () => {
  it('start roda $SHELL -lc no cwd da worktree mais a subpasta', async () => {
    const s = setup()
    s.h.service.setTaskStartCommand(s.task.id, 'pnpm dev', 'app')
    const state = await s.procs.start(s.task.id, 'start', false)
    expect(s.calls[0]).toEqual({
      file: '/bin/zsh',
      args: ['-lc', 'pnpm dev'],
      cwd: join(s.wt, 'app'),
    })
    expect(state.alive).toBe(true)
    expect(s.procs.owns(state.ptyId!)).toBe(true)
  })

  it('terminal abre $SHELL -l na pasta base', async () => {
    const s = setup()
    await s.procs.start(s.task.id, 'shell', false)
    expect(s.calls[0]).toEqual({ file: '/bin/zsh', args: ['-l'], cwd: s.wt })
  })

  it('avulso sem worktree usa a raiz do projeto', async () => {
    const s = setup()
    const root = join(s.base, 'raiz')
    mkdirSync(root)
    const project = s.h.service.addProject({ rootPath: root })
    const solo = s.h.service.createTask({
      projectId: project.id,
      title: 'Avulso',
      kind: 'solo',
      worktreePath: null,
      branch: null,
      baseBranch: null,
      leadRoleId: null,
      soloProvider: 'claude',
    })
    await s.procs.start(solo.id, 'shell', false)
    expect(s.calls[0]?.cwd).toBe(root)
  })

  it('recusa subpasta que sai da worktree (.., absoluta, symlink)', async () => {
    const s = setup()
    symlinkSync(s.base, join(s.wt, 'fuga'))
    expect(() => s.h.service.setTaskStartCommand(s.task.id, 'x', '../fora')).toThrow()
    expect(() => s.h.service.setTaskStartCommand(s.task.id, 'x', '/etc')).toThrow()
    // symlink passa na regra textual e cai na checagem do caminho real, no start
    s.h.service.setTaskStartCommand(s.task.id, 'x', 'fuga')
    await expect(s.procs.start(s.task.id, 'start', false)).rejects.toThrow(/sai da worktree/)
    expect(s.calls).toHaveLength(0)
  })

  it('stop e stopTask mandam SIGTERM; ja vivo sem restart nao abre outro', async () => {
    const s = setup()
    s.h.service.setTaskStartCommand(s.task.id, 'pnpm dev', null)
    await s.procs.start(s.task.id, 'start', false)
    await s.procs.start(s.task.id, 'start', false)
    expect(s.calls).toHaveLength(1)
    s.procs.stopTask(s.task.id)
    expect(s.ptys[0]?.killed).toEqual(['SIGTERM'])
    expect(s.procs.attach(s.task.id, 'start')).toMatchObject({
      alive: false,
      exited: true,
      exitCode: 0,
    })
  })

  it('restart para o vivo e abre outro', async () => {
    const s = setup()
    s.h.service.setTaskStartCommand(s.task.id, 'pnpm dev', null)
    await s.procs.start(s.task.id, 'start', false)
    await s.procs.start(s.task.id, 'start', true)
    expect(s.calls).toHaveLength(2)
    expect(s.procs.attach(s.task.id, 'start').alive).toBe(true)
  })

  it('nao cria Session nem entra na contagem de agentes', async () => {
    const s = setup()
    s.h.service.setTaskStartCommand(s.task.id, 'pnpm dev', null)
    await s.procs.start(s.task.id, 'start', false)
    await s.procs.start(s.task.id, 'shell', false)
    expect(s.h.service.listSessions(s.task.id)).toEqual([])
    // Dois pty vivos e limite de 1 agente: abrir um Lider ainda cabe.
    expect(s.ptyHost.liveCount()).toBe(2)
    expect(
      assertAgentCapacity({
        taskId: s.task.id,
        kind: 'leader',
        openSessions: s.h.service.listSessions(s.task.id),
        liveness: { isAlive: () => true },
        limits: { maxLiveAgents: 1, maxLiveMembersPerTask: 1 },
      }).liveAgents,
    ).toBe(0)
  })

  it('tarefa arquivada nao inicia', async () => {
    const s = setup()
    s.h.service.setTaskStartCommand(s.task.id, 'pnpm dev', null)
    s.h.service.markTaskArchived(s.task.id)
    const t: Task = s.h.service.getTask(s.task.id)
    expect(t.status).toBe('archived')
    await expect(s.procs.start(s.task.id, 'start', false)).rejects.toThrow(/arquivada/)
  })

  it('dois restart simultaneos deixam so 1 pty vivo e o slot aponta para ele', async () => {
    const s = setup()
    s.h.service.setTaskStartCommand(s.task.id, 'pnpm dev', null)
    await s.procs.start(s.task.id, 'start', false)
    const [a, b] = await Promise.all([
      s.procs.start(s.task.id, 'start', true),
      s.procs.start(s.task.id, 'start', true),
    ])
    expect(s.calls).toHaveLength(2)
    expect(s.ptyHost.liveCount()).toBe(1)
    expect(b.ptyId).toBe(a.ptyId)
    expect(s.procs.attach(s.task.id, 'start')).toMatchObject({ ptyId: a.ptyId, alive: true })
  })

  it('arquivar durante o restart nao deixa pty vivo', async () => {
    const s = setup()
    s.h.service.setTaskStartCommand(s.task.id, 'pnpm dev', null)
    await s.procs.start(s.task.id, 'start', false)
    const restarting = s.procs.start(s.task.id, 'start', true)
    s.h.service.markTaskArchived(s.task.id)
    await expect(restarting).rejects.toThrow(/arquivada/)
    expect(s.ptyHost.liveCount()).toBe(0)
  })

  it('worktree apagada vira erro em portugues', async () => {
    const s = setup()
    s.h.service.setTaskStartCommand(s.task.id, 'pnpm dev', 'app')
    rmSync(s.wt, { recursive: true, force: true })
    await expect(s.procs.start(s.task.id, 'start', false)).rejects.toThrow(
      `A pasta da tarefa não existe mais: ${s.wt}`,
    )
  })

  it('no win32 usa COMSPEC /d /s /c para start e sem args para o shell', async () => {
    const s = setup()
    s.h.service.setTaskStartCommand(s.task.id, 'pnpm dev', null)
    const old = process.env['COMSPEC']
    process.env['COMSPEC'] = 'C:\\Windows\\cmd.exe'
    try {
      const win = new TaskProcesses({ ptyHost: s.ptyHost, tasks: s.h.service, platform: 'win32' })
      await win.start(s.task.id, 'start', false)
      await win.start(s.task.id, 'shell', false)
    } finally {
      if (old === undefined) delete process.env['COMSPEC']
      else process.env['COMSPEC'] = old
    }
    expect(s.calls.map((c) => [c.file, c.args])).toEqual([
      ['C:\\Windows\\cmd.exe', ['/d', '/s', '/c', 'pnpm dev']],
      ['C:\\Windows\\cmd.exe', []],
    ])
  })
})
