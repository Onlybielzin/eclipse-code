import { describe, expect, it } from 'vitest'
import { createControlSurface } from '../../../src/app/main/controlSurface/controlSurface'
import type { ControlSurfaceContext } from '../../../src/app/main/controlSurface/types'
import { registerProjectRoleHandlers } from '../../../src/app/main/controlSurface/handlers/projectRoleHandlers'
import { SESSION_GRANT_POLICY } from '../../../src/app/main/controlSurface/http/sessionGrantPolicy'
import type { PersistenceStore } from '../../../src/platform/persistence/sqlite/PersistenceStore'
import {
  planDeleteProjectRole,
  planSetProjectRole,
} from '../../../src/contexts/settings/application/projectRoleCommands'

const now = new Date('2026-11-12T20:00:00.000Z')
const userCtx: ControlSurfaceContext = { now: () => now }

let nextId = 0
const createId = () => `role-${++nextId}`

function setup(initialSettings: unknown = {}) {
  let state = {
    formatVersion: 1,
    activeWorkspaceId: 'ws',
    workspaces: [
      {
        id: 'ws',
        name: 'kaliloop-backend',
        path: '/repo',
        worktreesRoot: '',
        viewport: { x: 0, y: 0, zoom: 1 },
        isMinimapVisible: true,
        spaces: [],
        activeSpaceId: null,
        nodes: [],
      },
    ],
    settings: initialSettings,
  } as Record<string, unknown>
  let revision = 1
  let conflictsLeft = 0
  const store = {
    readAppState: async () => structuredClone(state),
    readAppStateRevision: async () => revision,
    writeAppState: async (next: unknown, options?: { expectedRevision?: number }) => {
      if (conflictsLeft > 0) {
        conflictsLeft--
        revision++
        return {
          ok: false,
          error: { code: 'persistence.invalid_state', debugMessage: 'App state revision conflict' },
        }
      }
      if (options?.expectedRevision !== undefined && options.expectedRevision !== revision) {
        throw new Error('stale write')
      }
      state = structuredClone(next) as Record<string, unknown>
      revision++
      return { ok: true, revision }
    },
  } as unknown as PersistenceStore
  const controlSurface = createControlSurface()
  registerProjectRoleHandlers(controlSurface, { getPersistenceStore: async () => store })
  const call = (id: string, payload: unknown) =>
    controlSurface.invoke(userCtx, { kind: id === 'role.list' ? 'query' : 'command', id, payload })
  return {
    call,
    state: () => state,
    conflictOnce: () => {
      conflictsLeft = 1
    },
  }
}

describe('project roles from outside the shell', () => {
  it('creates a role, then updates it by name keeping unspecified fields', () => {
    const created = planSetProjectRole(
      { theme: 'eclipse' },
      'ws',
      { name: 'Dev 1', promptTemplate: 'Você é o Dev 1.', provider: 'claude-code', model: 'm1' },
      now.toISOString(),
      createId,
    )
    expect(created.ok && created.created).toBe(true)
    if (!created.ok) {
      return
    }
    expect(created.settings.theme).toBe('eclipse')

    const updated = planSetProjectRole(
      created.settings,
      'ws',
      { name: 'dev 1', model: 'm2' },
      now.toISOString(),
      createId,
    )
    expect(updated.ok).toBe(true)
    if (!updated.ok) {
      return
    }
    expect(updated.created).toBe(false)
    expect(updated.role).toMatchObject({
      id: created.role.id,
      name: 'Dev 1',
      model: 'm2',
      provider: 'claude-code',
      promptTemplate: 'Você é o Dev 1.',
    })
  })

  it('refuses a new role without a prompt', () => {
    const result = planSetProjectRole({}, 'ws', { name: 'Dev 1' }, now.toISOString(), createId)
    expect(result.ok).toBe(false)
  })

  it('keeps one lead: a new lead takes the mark', () => {
    const first = planSetProjectRole(
      {},
      'ws',
      { name: 'Líder', promptTemplate: 'a', isLead: true },
      now.toISOString(),
      createId,
    )
    if (!first.ok) {
      throw new Error('first failed')
    }
    const second = planSetProjectRole(
      first.settings,
      'ws',
      { name: 'Líder 2', promptTemplate: 'b', isLead: true },
      now.toISOString(),
      createId,
    )
    if (!second.ok) {
      throw new Error('second failed')
    }
    const roles = (
      second.settings.projectRolesByWorkspaceId as Record<
        string,
        Array<{ name: string; isLead: boolean }>
      >
    ).ws
    expect(roles.filter(role => role.isLead).map(role => role.name)).toEqual(['Líder 2'])
  })

  it('deletes by name and drops the project entry when empty', () => {
    const first = planSetProjectRole({}, 'ws', { name: 'X', promptTemplate: 'a' }, '', createId)
    if (!first.ok) {
      throw new Error('failed')
    }
    const deleted = planDeleteProjectRole(first.settings, 'ws', 'x')
    expect(deleted?.deleted.name).toBe('X')
    expect(deleted?.settings.projectRolesByWorkspaceId).toEqual({})
    expect(planDeleteProjectRole(first.settings, 'ws', 'missing')).toBeNull()
  })

  it('writes through the Worker, retrying a revision conflict, and lists the result', async () => {
    const harness = setup({ theme: 'eclipse' })
    harness.conflictOnce()
    const set = await harness.call('role.set', {
      projectId: 'ws',
      name: 'Líder',
      prompt: 'Você é o Líder.',
      provider: 'claude-code',
      isLead: true,
    })
    expect(set.ok).toBe(true)
    const listed = await harness.call('role.list', { projectId: 'ws' })
    expect(listed.ok && (listed.value as { roles: Array<{ name: string }> }).roles).toEqual([
      expect.objectContaining({ name: 'Líder', isLead: true }),
    ])
    expect((harness.state().settings as Record<string, unknown>).theme).toBe('eclipse')

    const removed = await harness.call('role.delete', { projectId: 'ws', name: 'líder' })
    expect(removed.ok).toBe(true)
  })

  it('rejects an unknown project and an unknown provider', async () => {
    const harness = setup()
    const unknownProject = await harness.call('role.set', {
      projectId: 'nope',
      name: 'X',
      prompt: 'a',
    })
    expect(!unknownProject.ok && unknownProject.error.code).toBe('common.invalid_input')
    const badProvider = await harness.call('role.set', {
      projectId: 'ws',
      name: 'X',
      prompt: 'a',
      provider: 'gpt-shell',
    })
    expect(!badProvider.ok && badProvider.error.code).toBe('common.invalid_input')
  })

  it('lets agents read the team but not change it', () => {
    expect(SESSION_GRANT_POLICY['role.list']).toEqual({ access: 'allow' })
    expect(SESSION_GRANT_POLICY['role.set']).toMatchObject({ access: 'deny' })
    expect(SESSION_GRANT_POLICY['role.delete']).toMatchObject({ access: 'deny' })
  })
})
