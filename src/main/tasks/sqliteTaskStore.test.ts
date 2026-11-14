import { describe, expect, it } from 'vitest'
import { LATEST_SCHEMA_VERSION } from './migrations'
import { EVENT_RETENTION, migrate, roleNameKey } from './sqliteTaskStore'
import { createHarness, sampleDelivery, seedTeam, seedWorkingSubtask } from './testing'

describe('SqliteTaskStore', () => {
  it('migra até a última versão e rodar de novo não muda nada', () => {
    const { store } = createHarness()
    expect(store.db.pragma('user_version', { simple: true })).toBe(LATEST_SCHEMA_VERSION)
    expect(migrate(store.db)).toBe(LATEST_SCHEMA_VERSION)
    expect(store.db.pragma('foreign_keys', { simple: true })).toBe(1)
  })

  it('migração 7: tarefas ganham start_command e start_dir nulos', () => {
    const { store } = createHarness()
    const cols = (store.db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map(
      (c) => c.name,
    )
    expect(cols).toEqual(expect.arrayContaining(['start_command', 'start_dir']))
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(7)
  })

  it('entrega e atividade gravadas não mudam', () => {
    const { service, store } = createHarness()
    const fx = seedTeam(service)
    const { subtask, session } = seedWorkingSubtask(service, fx)
    service.startTurn({ sessionId: session.id, subtaskId: subtask.id, author: 'leader', parts: [] })
    const artifact = service.recordDelivery(session.id, sampleDelivery('completed'))
    expect(() =>
      store.db.prepare("UPDATE artifacts SET format = 'unformatted' WHERE id = ?").run(artifact.id),
    ).toThrow(/não muda|nao muda/)
    expect(() => store.db.prepare('UPDATE activity SET at = 0').run()).toThrow(/nao muda/)
  })

  it('poda eventos antigos sem reaproveitar revisão', () => {
    const { store } = createHarness()
    let last = 0
    store.transaction(() => {
      for (let i = 0; i < EVENT_RETENTION + 600; i++) {
        last = store.appendEvent({ type: 'project.removed', projectId: `p${i}` }, i).revision
      }
    })
    const count = (store.db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n
    expect(count).toBeLessThanOrEqual(EVENT_RETENTION + 500)
    expect(store.latestRevision()).toBe(last)
  })

  it('chave de nome ignora acento, caixa e espaços', () => {
    expect(roleNameKey('  Revisor  de   Segurança ')).toBe('revisor de seguranca')
  })
})
