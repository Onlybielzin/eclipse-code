// Reinicio do app: grava num arquivo SQLite, fecha, reabre e roda recoverAfterRestart.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RESTART_PAUSE_MESSAGE } from '@shared/subtaskRules'
import { LATEST_SCHEMA_VERSION } from './migrations'
import {
  createHarness,
  sampleDelivery,
  seedTeam,
  seedWorkingSubtask,
  type Harness,
} from './testing'

let dir: string
let dbPath: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'eclipse-next-tasks-'))
  dbPath = join(dir, 'eclipse-code.sqlite')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function reboot(before: Harness, prefix: string): Harness {
  before.store.close()
  return createHarness(dbPath, prefix)
}

describe('recuperação no boot', () => {
  it('dados sobrevivem ao reinício e a migração não roda de novo', () => {
    const h1 = createHarness(dbPath, 'a')
    const fx = seedTeam(h1.service)
    const revision = h1.store.latestRevision()
    const h2 = reboot(h1, 'b')
    expect(h2.store.db.pragma('user_version', { simple: true })).toBe(LATEST_SCHEMA_VERSION)
    expect(h2.service.getTask(fx.task.id)).toEqual(fx.task)
    expect(h2.service.listRoles(fx.project.id)).toHaveLength(2)
    // Revisão continua crescendo depois do reinício.
    h2.service.addProject({ rootPath: '/repo/outro' })
    expect(h2.store.latestRevision()).toBeGreaterThan(revision)
    h2.store.close()
  })

  it('membro que não volta: sessão encerrada, subtarefa parada esperando o Líder, turno fechado', () => {
    const h1 = createHarness(dbPath, 'a')
    const fx = seedTeam(h1.service)
    const midTurn = seedWorkingSubtask(h1.service, fx, 'no meio do turno')
    const turn = h1.service.startTurn({
      sessionId: midTurn.session.id,
      subtaskId: midTurn.subtask.id,
      author: 'leader',
      parts: [{ kind: 'text', text: 'vai' }],
    })
    h1.service.appendActivity([
      {
        sessionId: midTurn.session.id,
        subtaskId: midTurn.subtask.id,
        turnId: turn.id,
        at: 5,
        payload: { kind: 'text', text: 'trabalhando... STATUS: PRONTO' },
      },
    ])
    const waiting = seedWorkingSubtask(h1.service, fx, 'em dúvida')
    h1.service.transitionSubtask(waiting.subtask.id, 'input_required')
    const queued = h1.service.createSubtask({
      taskId: fx.task.id,
      roleId: fx.dev.id,
      title: 'na fila',
      instructions: 'x',
      referenceTaskIds: [],
    })
    const done = seedWorkingSubtask(h1.service, fx, 'já pronta')
    h1.service.transitionSubtask(done.subtask.id, 'completed')
    h1.service.endSession(done.session.id, { reason: 'closed', exitCode: 0 })

    const h2 = reboot(h1, 'b')
    const report = h2.service.recoverAfterRestart()

    const pausedIds = report.pausedSubtasks.map((s) => s.id).sort()
    expect(pausedIds).toEqual([midTurn.subtask.id, waiting.subtask.id, queued.id].sort())
    // Nada vira cancelada nem bloqueada: tudo para em dúvida, esperando o Líder.
    for (const id of pausedIds) {
      expect(h2.service.getSubtask(id)).toMatchObject({
        state: 'input_required',
        failureCode: null,
        statusMessage: RESTART_PAUSE_MESSAGE,
        finishedAt: null,
      })
    }
    expect(RESTART_PAUSE_MESSAGE).toBe('parada: o app reiniciou')
    expect(h2.service.getSubtask(done.subtask.id).state).toBe('completed')
    expect(h2.service.listOpenSessions()).toEqual([])
    expect(h2.service.getSession(midTurn.session.id)).toMatchObject({
      status: 'exited',
      endReason: 'lost_on_restart',
      activeTurnId: null,
      // O id do provedor fica: responder reabre o membro com session/load.
      providerSessionId: 'acp-1',
    })
    const closedTurn = h2.store.getTurn(turn.id)
    expect(closedTurn?.endedAt).not.toBeNull()
    expect(closedTurn?.error?.code).toBe('app_restarted')
    expect(closedTurn?.finalText).toBe('trabalhando... STATUS: PRONTO')

    // Rodar de novo não muda nada.
    const second = h2.service.recoverAfterRestart()
    expect(second).toEqual({
      lostSessions: [],
      pausedSubtasks: [],
      deliveredSubtasks: [],
      leadersToResume: [],
    })
    h2.store.close()
  })

  it('reinício deixa um aviso durável por subtarefa parada, com ou sem turno aberto', () => {
    const h1 = createHarness(dbPath, 'a')
    const fx = seedTeam(h1.service)
    const midTurn = seedWorkingSubtask(h1.service, fx, 'no meio do turno')
    h1.service.startTurn({
      sessionId: midTurn.session.id,
      subtaskId: midTurn.subtask.id,
      author: 'leader',
      parts: [],
    })
    const waiting = seedWorkingSubtask(h1.service, fx, 'em dúvida')
    h1.service.transitionSubtask(waiting.subtask.id, 'input_required')
    const queued = h1.service.createSubtask({
      taskId: fx.task.id,
      roleId: fx.dev.id,
      title: 'na fila',
      instructions: 'x',
      referenceTaskIds: [],
    })

    const h2 = reboot(h1, 'b')
    h2.service.recoverAfterRestart({
      composeLostNotice: (subtask) =>
        `[eclipse] ${subtask.id} parou: ${subtask.state} ${subtask.statusMessage}`,
    })
    const expected = [midTurn.subtask.id, waiting.subtask.id, queued.id].map(
      (id) => `[eclipse] ${id} parou: input_required ${RESTART_PAUSE_MESSAGE}`,
    )
    const notices = h2.service.listPendingLeaderNotices(fx.task.id).map((n) => n.text)
    expect(notices.sort()).toEqual([...expected].sort())

    // Gravado no SQLite: sobrevive a outro reinício até ser entregue, e o segundo reinício
    // não repete o aviso da subtarefa que continua parada.
    const h3 = reboot(h2, 'c')
    const again = h3.service.recoverAfterRestart({ composeLostNotice: () => 'repetido' })
    expect(again.pausedSubtasks).toEqual([])
    const pending = h3.service.listPendingLeaderNotices(fx.task.id)
    expect(pending).toHaveLength(3)
    expect(h3.service.listTasksWithPendingLeaderNotices()).toEqual([fx.task.id])
    h3.service.markLeaderNoticeDelivered(pending[0]!.id)
    expect(h3.service.listPendingLeaderNotices(fx.task.id)).toHaveLength(2)
    // O aviso guarda a subtarefa; descartar por subtarefa tira so os avisos dela (e sobrevive ao reinício).
    expect(pending.map((n) => n.subtaskId).sort()).toEqual(
      [midTurn.subtask.id, waiting.subtask.id, queued.id].sort(),
    )
    h3.service.discardPendingLeaderNoticesForSubtasks(fx.task.id, [pending[1]!.subtaskId!])
    expect(h3.service.listPendingLeaderNotices(fx.task.id).map((n) => n.id)).toEqual([
      pending[2]!.id,
    ])
    h3.store.close()
  })

  it('entrega pronta ou bloqueada gravada antes da queda vale; dúvida gravada fica parada', () => {
    const h1 = createHarness(dbPath, 'a')
    const fx = seedTeam(h1.service)
    const ok = seedWorkingSubtask(h1.service, fx, 'entregou')
    h1.service.startTurn({
      sessionId: ok.session.id,
      subtaskId: ok.subtask.id,
      author: 'leader',
      parts: [],
    })
    h1.service.recordDelivery(ok.session.id, sampleDelivery('completed', 'tudo certo'))
    const ask = seedWorkingSubtask(h1.service, fx, 'perguntou')
    h1.service.startTurn({
      sessionId: ask.session.id,
      subtaskId: ask.subtask.id,
      author: 'leader',
      parts: [],
    })
    h1.service.recordDelivery(ask.session.id, sampleDelivery('input_required', 'qual tabela?'))
    const stuck = seedWorkingSubtask(h1.service, fx, 'travou')
    h1.service.startTurn({
      sessionId: stuck.session.id,
      subtaskId: stuck.subtask.id,
      author: 'leader',
      parts: [],
    })
    h1.service.recordDelivery(stuck.session.id, sampleDelivery('failed', 'sem acesso ao banco'))

    const h2 = reboot(h1, 'b')
    const report = h2.service.recoverAfterRestart({ composeLostNotice: (s) => `parou ${s.id}` })
    expect(report.deliveredSubtasks.map((s) => s.id).sort()).toEqual(
      [ok.subtask.id, stuck.subtask.id].sort(),
    )
    expect(h2.service.getSubtask(ok.subtask.id)).toMatchObject({
      state: 'completed',
      failureCode: null,
    })
    expect(h2.service.getSubtask(stuck.subtask.id)).toMatchObject({
      state: 'failed',
      failureCode: 'member_blocked',
    })
    expect(report.pausedSubtasks.map((s) => s.id)).toEqual([ask.subtask.id])
    expect(h2.service.getSubtask(ask.subtask.id)).toMatchObject({
      state: 'input_required',
      statusMessage: RESTART_PAUSE_MESSAGE,
    })
    // Só a parada gera aviso de reinício; as entregues avisam pelo fim de turno (relay).
    expect(h2.service.listPendingLeaderNotices(fx.task.id).map((n) => n.text)).toEqual([
      `parou ${ask.subtask.id}`,
    ])
    h2.store.close()
  })

  it('sessão que voltou (sobrevivente) fica intacta', () => {
    const h1 = createHarness(dbPath, 'a')
    const fx = seedTeam(h1.service)
    const back = seedWorkingSubtask(h1.service, fx, 'voltou')
    h1.service.transitionSubtask(back.subtask.id, 'input_required')
    const h2 = reboot(h1, 'b')
    const report = h2.service.recoverAfterRestart({
      survivingSessionIds: new Set([back.session.id]),
    })
    expect(report.lostSessions).toEqual([])
    expect(report.pausedSubtasks).toEqual([])
    expect(h2.service.getSubtask(back.subtask.id).state).toBe('input_required')
    expect(h2.service.getSession(back.session.id).status).toBe('starting')
    h2.store.close()
  })

  it('Líder perdido volta em leadersToResume com o id do provedor, e abre sessão nova', () => {
    const h1 = createHarness(dbPath, 'a')
    const fx = seedTeam(h1.service)
    const leader = h1.service.openSession({
      taskId: fx.task.id,
      subtaskId: null,
      roleId: fx.lead.id,
      kind: 'leader-pty',
      provider: 'claude',
      model: 'opus',
      cwd: '/wt/corrigir-login',
      providerSessionId: null,
    })
    h1.service.updateSession(leader.id, { status: 'running', providerSessionId: 'claude-abc' })
    // Tarefa sem providerSessionId conhecido não entra na lista.
    const other = h1.service.createTask({
      projectId: fx.project.id,
      title: 'Sem id',
      kind: 'solo',
      worktreePath: null,
      branch: null,
      baseBranch: null,
      leadRoleId: null,
      soloProvider: 'codex',
    })
    h1.service.openSession({
      taskId: other.id,
      subtaskId: null,
      roleId: null,
      kind: 'leader-pty',
      provider: 'codex',
      model: null,
      cwd: '/repo/projeto',
      providerSessionId: null,
    })

    const h2 = reboot(h1, 'b')
    const report = h2.service.recoverAfterRestart()
    expect(report.leadersToResume.map((s) => [s.taskId, s.providerSessionId])).toEqual([
      [fx.task.id, 'claude-abc'],
    ])
    expect(report.pausedSubtasks).toEqual([])
    expect(h2.service.getLiveLeaderSession(fx.task.id)).toBeNull()
    const resumed = h2.service.openSession({
      taskId: fx.task.id,
      subtaskId: null,
      roleId: fx.lead.id,
      kind: 'leader-pty',
      provider: 'claude',
      model: 'opus',
      cwd: '/wt/corrigir-login',
      providerSessionId: 'claude-abc',
    })
    expect(h2.service.getLiveLeaderSession(fx.task.id)?.id).toBe(resumed.id)
    h2.store.close()
  })
})
