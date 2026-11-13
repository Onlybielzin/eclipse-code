import React from 'react'
import type { Edge, Node } from '@xyflow/react'
import type { TerminalNodeData, WorkspaceSpaceState } from '../../../types'
import type { SpaceVisual } from '../types'
import { subscribeCloseTask } from '../tasks/taskEvents'
import { setActiveTaskSpace } from './useInteractions.spaceAssignment'

/** The active top-level Space and every Space nested in it. */
export function resolveActiveTaskSpaceIds(
  spaces: readonly Pick<WorkspaceSpaceState, 'id' | 'parentSpaceId'>[],
  activeSpaceId: string | null | undefined,
): Set<string> | null {
  if (!activeSpaceId || !spaces.some(space => space.id === activeSpaceId)) {
    return null
  }
  const ids = new Set([activeSpaceId])
  let grew = true
  while (grew) {
    grew = false
    for (const space of spaces) {
      if (space.parentSpaceId && ids.has(space.parentSpaceId) && !ids.has(space.id)) {
        ids.add(space.id)
        grew = true
      }
    }
  }
  return ids
}

/** The task (top-level Space) a node or Space belongs to; null for the root canvas. */
export function resolveTaskSpaceId(
  spaces: readonly Pick<WorkspaceSpaceState, 'id' | 'parentSpaceId' | 'nodeIds'>[],
  target: { nodeId: string } | { spaceId: string },
): string | null {
  let current =
    'nodeId' in target
      ? (spaces.find(space => space.nodeIds.includes(target.nodeId)) ?? null)
      : (spaces.find(space => space.id === target.spaceId) ?? null)
  const seen = new Set<string>()
  while (current?.parentSpaceId && !seen.has(current.id)) {
    seen.add(current.id)
    const parentId = current.parentSpaceId
    current = spaces.find(space => space.id === parentId) ?? null
  }
  return current?.id ?? null
}

/**
 * Eclipse Code tasks: a task is a top-level Space (usually bound to its own worktree). While one
 * is active, the canvas shows only that task's windows and Spaces; the others stay mounted and
 * keep running, just hidden. "All" (no active Space) shows everything.
 */
export function useActiveTaskIsolation<TNode extends Node<TerminalNodeData>>({
  nodes,
  edges,
  spaces,
  spaceVisuals,
  activeSpaceId,
  workspaceId,
  openSpaceArchive,
}: {
  nodes: TNode[]
  edges: Edge[]
  spaces: WorkspaceSpaceState[]
  spaceVisuals: SpaceVisual[]
  activeSpaceId: string | null | undefined
  /** Registers the open task so new windows land in it (findContainingSpaceByAnchor). */
  workspaceId?: string
  /** Lets "Close task" from the sidebar or Space menu open this canvas' archive dialog. */
  openSpaceArchive?: (spaceId: string, anchor: { x: number; y: number }) => void
}): {
  nodes: TNode[]
  edges: Edge[]
  spaceVisuals: SpaceVisual[]
  shownNodes: TNode[]
  isIsolated: boolean
} {
  React.useEffect(() => {
    if (!workspaceId) {
      return undefined
    }
    setActiveTaskSpace(workspaceId, activeSpaceId ?? null)
    return () => setActiveTaskSpace(workspaceId, null)
  }, [activeSpaceId, workspaceId])

  React.useEffect(() => {
    if (!openSpaceArchive) {
      return undefined
    }
    return subscribeCloseTask((spaceId, anchor) => {
      if (spaces.some(space => space.id === spaceId)) {
        openSpaceArchive(spaceId, anchor ?? { x: 240, y: 120 })
      }
    })
  }, [openSpaceArchive, spaces])

  const taskSpaceIds = React.useMemo(
    () => resolveActiveTaskSpaceIds(spaces, activeSpaceId),
    [activeSpaceId, spaces],
  )

  const taskNodeIds = React.useMemo(() => {
    if (!taskSpaceIds) {
      return null
    }
    const ids = new Set<string>()
    for (const space of spaces) {
      if (taskSpaceIds.has(space.id)) {
        for (const nodeId of space.nodeIds) {
          ids.add(nodeId)
        }
      }
    }
    return ids
  }, [spaces, taskSpaceIds])

  const isolatedNodes = React.useMemo(() => {
    if (!taskNodeIds) {
      return nodes
    }
    return nodes.map(node =>
      taskNodeIds.has(node.id) || node.hidden ? node : ({ ...node, hidden: true } as TNode),
    )
  }, [nodes, taskNodeIds])

  const isolatedEdges = React.useMemo(() => {
    if (!taskNodeIds) {
      return edges
    }
    return edges.filter(edge => taskNodeIds.has(edge.source) && taskNodeIds.has(edge.target))
  }, [edges, taskNodeIds])

  const isolatedSpaceVisuals = React.useMemo(() => {
    if (!taskSpaceIds) {
      return spaceVisuals
    }
    return spaceVisuals.filter(space => taskSpaceIds.has(space.id))
  }, [spaceVisuals, taskSpaceIds])

  const shownNodes = React.useMemo(
    () => isolatedNodes.filter(node => !node.hidden),
    [isolatedNodes],
  )

  return {
    nodes: isolatedNodes,
    edges: isolatedEdges,
    spaceVisuals: isolatedSpaceVisuals,
    shownNodes,
    isIsolated: taskSpaceIds !== null,
  }
}

/**
 * A focus request (sidebar, CLI `canvas focus`, --focus) for a window or Space of another task
 * opens that task first (the root canvas opens "All"), so the target is never hidden.
 */
export function useOpenTaskOfFocusTarget({
  activeSpaceId,
  focusNodeId,
  focusSpaceId,
  focusSequence,
  spaces,
  openTask,
}: {
  activeSpaceId: string | null | undefined
  focusNodeId: string | null | undefined
  focusSpaceId: string | null | undefined
  focusSequence: number | undefined
  spaces: WorkspaceSpaceState[]
  openTask: (spaceId: string | null) => void
}): void {
  const lastSequenceRef = React.useRef(focusSequence)
  React.useEffect(() => {
    if (lastSequenceRef.current === focusSequence) {
      return
    }
    lastSequenceRef.current = focusSequence
    if (!activeSpaceId || (!focusNodeId && !focusSpaceId)) {
      return
    }
    const target = focusNodeId ? { nodeId: focusNodeId } : { spaceId: focusSpaceId as string }
    const taskSpaceId = resolveTaskSpaceId(spaces, target)
    if (taskSpaceId !== activeSpaceId) {
      openTask(taskSpaceId)
    }
  }, [activeSpaceId, focusNodeId, focusSequence, focusSpaceId, openTask, spaces])
}
