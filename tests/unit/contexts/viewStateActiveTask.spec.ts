// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import {
  applyLocalViewStateToPersistedState,
  persistLocalViewStateFromAppState,
} from '../../../src/contexts/workspace/presentation/renderer/utils/persistence/viewState'
import type { PersistedAppState } from '../../../src/contexts/workspace/presentation/renderer/types'

// Shared state as the Worker stores it: activeSpaceId is only a placeholder (first root Space).
function sharedState(activeSpaceId: string | null): PersistedAppState {
  return {
    activeWorkspaceId: 'ws',
    workspaces: [
      {
        id: 'ws',
        name: 'ws',
        path: '/repo',
        viewport: { x: 0, y: 0, zoom: 1 },
        isMinimapVisible: true,
        activeSpaceId,
        spaces: [
          { id: 'task-a', name: 'a', directoryPath: '/repo', nodeIds: [], rect: null },
          { id: 'task-b', name: 'b', directoryPath: '/repo', nodeIds: [], rect: null },
        ],
        nodes: [],
      },
    ],
  } as unknown as PersistedAppState
}

beforeEach(() => window.localStorage.clear())

// Eclipse Code tasks: the open task hides the others, so a local "All" must survive a restart.
describe('local open task over the shared placeholder', () => {
  it('keeps a local "All" instead of reopening the placeholder task', () => {
    persistLocalViewStateFromAppState(sharedState(null))
    const restored = applyLocalViewStateToPersistedState(sharedState('task-a'))
    expect(restored.workspaces[0]!.activeSpaceId).toBeNull()
  })

  it('keeps the locally open task', () => {
    persistLocalViewStateFromAppState(sharedState('task-b'))
    const restored = applyLocalViewStateToPersistedState(sharedState('task-a'))
    expect(restored.workspaces[0]!.activeSpaceId).toBe('task-b')
  })

  it('opens "All" when the locally open task no longer exists', () => {
    persistLocalViewStateFromAppState(sharedState('gone'))
    const restored = applyLocalViewStateToPersistedState(sharedState('task-a'))
    expect(restored.workspaces[0]!.activeSpaceId).toBeNull()
  })
})
