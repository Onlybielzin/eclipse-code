import { describe, expect, it } from 'vitest'
import { createControlSurface } from '../../../src/app/main/controlSurface/controlSurface'
import type { ControlSurfaceContext } from '../../../src/app/main/controlSurface/types'
import { registerSpaceHandlers } from '../../../src/app/main/controlSurface/handlers/spaceHandlers'
import type { PersistenceStore } from '../../../src/platform/persistence/sqlite/PersistenceStore'

const ctx: ControlSurfaceContext = { now: () => new Date('2026-11-11T00:00:00.000Z') }

function space(id: string, directoryPath: string, parentSpaceId: string | null = null) {
  return {
    id,
    name: id,
    directoryPath,
    parentSpaceId,
    labelColor: null,
    nodeIds: [],
    rect: { x: 0, y: 0, width: 300, height: 200 },
  }
}

function setup(spaces: ReturnType<typeof space>[], activeSpaceId: string | null) {
  let written: {
    workspaces: Array<{ spaces: Array<{ id: string }>; activeSpaceId: string | null }>
  } | null = null
  const state = {
    formatVersion: 1,
    activeWorkspaceId: 'ws',
    workspaces: [
      {
        id: 'ws',
        name: 'ws',
        path: '/repo/',
        worktreesRoot: '',
        viewport: { x: 0, y: 0, zoom: 1 },
        isMinimapVisible: true,
        spaces,
        activeSpaceId,
        nodes: [],
        spaceArchiveRecords: [],
      },
    ],
    settings: {},
  }
  const store = {
    readAppState: async () => state,
    readAppStateRevision: async () => 0,
    writeAppState: async (next: typeof written) => {
      written = next
      return { ok: true, level: 'full', bytes: 1 }
    },
  } as unknown as PersistenceStore
  const controlSurface = createControlSurface()
  registerSpaceHandlers(controlSurface, async () => store)
  const remove = (spaceId: string) =>
    controlSurface.invoke(ctx, { kind: 'command', id: 'space.delete', payload: { spaceId } })
  return { remove, written: () => written }
}

// Eclipse Code tasks: an agent closes its task by archiving the worktree, then removing the Space.
describe('space.delete', () => {
  it('removes a task Space with its nested Spaces and clears it as the open task', async () => {
    const t = setup(
      [space('task', '/repo'), space('child', '/repo', 'task'), space('other', '/repo')],
      'task',
    )
    const result = await t.remove('task')
    expect(result.ok).toBe(true)
    expect(t.written()!.workspaces[0]!.spaces.map(item => item.id)).toEqual(['other'])
    expect(t.written()!.workspaces[0]!.activeSpaceId).toBeNull()
  })

  it('refuses a Space still bound to a worktree, so no worktree is orphaned', async () => {
    const t = setup([space('task', '/repo/.eclipse-code/worktrees/feat-x--1234')], null)
    const result = await t.remove('task')
    expect(result.ok).toBe(false)
    expect(t.written()).toBeNull()
  })

  it('reports an unknown Space', async () => {
    const t = setup([space('task', '/repo')], null)
    const result = await t.remove('missing')
    expect(result.ok).toBe(false)
  })
})
