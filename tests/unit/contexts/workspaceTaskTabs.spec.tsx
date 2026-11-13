import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { WorkspaceSpaceState } from '@contexts/workspace/presentation/renderer/types'
import { orderRootSpaces } from '@contexts/workspace/domain/workspaceSpacePinning'
import { WorkspaceTaskTabs } from '@contexts/workspace/presentation/renderer/components/workspaceCanvas/view/WorkspaceTaskTabs'

function createSpace(
  id: string,
  options: { pinned?: boolean; sortOrder?: number; parentSpaceId?: string | null } = {},
): WorkspaceSpaceState {
  return {
    id,
    name: id,
    directoryPath: '/tmp',
    targetMountId: null,
    parentSpaceId: options.parentSpaceId,
    sortOrder: options.sortOrder,
    pinned: options.pinned,
    labelColor: null,
    nodeIds: [],
    rect: null,
  }
}

function renderTabs(
  spaces: WorkspaceSpaceState[],
  options: { activeSpaceId?: string | null; workspaceId?: string } = {},
) {
  const props = {
    activateSpace: vi.fn(),
    activateAllSpaces: vi.fn(),
    cancelSpaceRename: vi.fn(),
    onOpenSpaceContextMenu: vi.fn(),
  }
  render(
    <WorkspaceTaskTabs
      spaces={orderRootSpaces(spaces)}
      activeSpaceId={options.activeSpaceId ?? null}
      workspaceId={options.workspaceId}
      {...props}
    />,
  )
  return props
}

// Eclipse Code: every top-level Space is a task tab, pinned or not; child Spaces never are.
describe('WorkspaceTaskTabs', () => {
  it('renders nothing without tasks and without a project to create them in', () => {
    renderTabs([])
    expect(screen.queryByTestId('workspace-space-switch-all')).toBeNull()
  })

  it('shows "All" and every root space in root order, never child spaces', () => {
    renderTabs([
      createSpace('plain', { sortOrder: 0 }),
      createSpace('pinned-b', { pinned: true, sortOrder: 2 }),
      createSpace('pinned-a', { pinned: true, sortOrder: 1 }),
      createSpace('child', { pinned: true, parentSpaceId: 'plain' }),
    ])
    expect(screen.getAllByRole('radio').map(radio => (radio as HTMLInputElement).value)).toEqual([
      '__all__',
      'pinned-a',
      'pinned-b',
      'plain',
    ])
    expect(screen.queryByTestId('workspace-space-switch-child')).toBeNull()
  })

  it('opens a task, re-centres the open one on a second click, and "All" shows every task', () => {
    const props = renderTabs([createSpace('a'), createSpace('b')], { activeSpaceId: 'a' })
    expect(screen.getByTestId('workspace-space-switch-a')).toBeChecked()

    fireEvent.click(screen.getByTestId('workspace-space-switch-b'))
    expect(props.activateSpace).toHaveBeenCalledWith('b')

    props.activateSpace.mockClear()
    fireEvent.click(screen.getByTestId('workspace-space-switch-a'))
    expect(props.activateSpace).toHaveBeenCalledWith('a')

    fireEvent.click(screen.getByTestId('workspace-space-switch-all'))
    expect(props.activateAllSpaces).toHaveBeenCalled()
  })

  it('opens the shared space menu from a tab context click', () => {
    const props = renderTabs([createSpace('pinned', { pinned: true })])
    fireEvent.contextMenu(screen.getByTestId('workspace-space-switch-pinned'), {
      clientX: 42,
      clientY: 64,
    })
    expect(props.onOpenSpaceContextMenu).toHaveBeenCalledWith('pinned', { x: 42, y: 64 })
  })

  it('offers "+ New task" only inside a project', () => {
    renderTabs([createSpace('a')], { workspaceId: 'ws' })
    expect(screen.getByTestId('workspace-task-new')).toBeInTheDocument()
  })
})
