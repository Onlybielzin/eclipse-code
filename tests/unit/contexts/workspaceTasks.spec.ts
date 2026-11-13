import { afterEach, describe, expect, it } from 'vitest'
import {
  resolveActiveTaskSpaceIds,
  resolveTaskSpaceId,
} from '../../../src/contexts/workspace/presentation/renderer/components/workspaceCanvas/hooks/useActiveTaskIsolation'
import {
  findContainingSpaceByAnchor,
  setActiveTaskSpace,
} from '../../../src/contexts/workspace/presentation/renderer/components/workspaceCanvas/hooks/useInteractions.spaceAssignment'
import { toTaskSlug } from '../../../src/contexts/workspace/presentation/renderer/components/workspaceCanvas/tasks/createTaskWithWorktree'
import type { WorkspaceSpaceState } from '../../../src/contexts/workspace/presentation/renderer/types'

function space(
  id: string,
  rect: { x: number; y: number; width: number; height: number },
  options: { parentSpaceId?: string; nodeIds?: string[] } = {},
): WorkspaceSpaceState {
  return {
    id,
    name: id,
    directoryPath: '/repo',
    targetMountId: null,
    parentSpaceId: options.parentSpaceId ?? null,
    labelColor: null,
    nodeIds: options.nodeIds ?? [],
    rect,
  }
}

const taskA = space('a', { x: 0, y: 0, width: 400, height: 300 }, { nodeIds: ['n1'] })
const childOfA = space(
  'a-child',
  { x: 20, y: 20, width: 100, height: 100 },
  { parentSpaceId: 'a', nodeIds: ['n2'] },
)
const taskB = space('b', { x: 600, y: 0, width: 400, height: 300 }, { nodeIds: ['n3'] })
const spaces = [taskA, childOfA, taskB]

afterEach(() => setActiveTaskSpace('ws', null))

describe('Eclipse Code tasks', () => {
  it('turns a task name into a branch-safe slug', () => {
    expect(toTaskSlug('Login com Google!')).toBe('login-com-google')
    expect(toTaskSlug('  Devolução  Efí  ')).toBe('devolucao-efi')
    expect(toTaskSlug('***')).toBe('task')
    expect(toTaskSlug('x'.repeat(80))).toHaveLength(48)
  })

  it('includes nested Spaces in the open task and nothing when no task is open', () => {
    expect([...(resolveActiveTaskSpaceIds(spaces, 'a') ?? [])].sort()).toEqual(['a', 'a-child'])
    expect(resolveActiveTaskSpaceIds(spaces, null)).toBeNull()
    expect(resolveActiveTaskSpaceIds(spaces, 'missing')).toBeNull()
  })

  it('finds the task of a window or Space; root-canvas windows have none', () => {
    expect(resolveTaskSpaceId(spaces, { nodeId: 'n2' })).toBe('a')
    expect(resolveTaskSpaceId(spaces, { nodeId: 'n3' })).toBe('b')
    expect(resolveTaskSpaceId(spaces, { nodeId: 'loose' })).toBeNull()
    expect(resolveTaskSpaceId(spaces, { spaceId: 'a-child' })).toBe('a')
  })

  it('never drops a new window into a hidden task', () => {
    expect(findContainingSpaceByAnchor(spaces, { x: 700, y: 100 })?.id).toBe('b')
    setActiveTaskSpace('ws', 'a')
    // A point over task B (hidden) lands in the open task A.
    expect(findContainingSpaceByAnchor(spaces, { x: 700, y: 100 })?.id).toBe('a')
    // Inside the open task, the innermost Space still wins.
    expect(findContainingSpaceByAnchor(spaces, { x: 50, y: 50 })?.id).toBe('a-child')
  })
})
