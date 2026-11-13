import { randomUUID } from 'node:crypto'
import { createAppError } from '../../../../shared/errors/appError'
import { resolveCanonicalNodeSize } from '../../domain/workspaceNodeSizing'
import { resolveWorkspaceNodesPlacement } from '../../domain/workspaceNodePlacement'
import { normalizeAgentSettings } from '../../../settings/domain/agentSettings'
import { workspaceWithNode } from '../nodeControl/nodeCreatePlacement'
import {
  replaceNodeControlWorkspace,
  requireNodeControlState,
  type NodeControlAppState,
  type NodeControlAppStateStore,
  type NodeControlNode,
  type NodeControlWorkspace,
} from '../nodeControl/nodeControlState'

export type CanvasCardKind = 'question' | 'todos'

/** Gap between the agent window and its card. */
const CARD_GAP_PX = 24

export interface LocatedNode {
  state: NodeControlAppState
  workspace: NodeControlWorkspace
  node: NodeControlNode
  spaceId: string | null
}

export function locateNode(state: NodeControlAppState, nodeId: string): LocatedNode | null {
  for (const workspace of state.workspaces) {
    const node = workspace.nodes.find(candidate => candidate.id === nodeId)
    if (node) {
      const space = workspace.spaces.find(candidate => candidate.nodeIds.includes(node.id))
      return { state, workspace, node, spaceId: space?.id ?? null }
    }
  }
  return null
}

/** Places a new card right of the agent window, inside the agent's Space (which grows to fit). */
export function placeCardNextTo(
  state: NodeControlAppState,
  owner: LocatedNode,
  kind: CanvasCardKind,
): { x: number; y: number; width: number; height: number } {
  const size = resolveCanonicalNodeSize({
    kind,
    bucket: normalizeAgentSettings(state.settings).standardWindowSizeBucket,
  })
  const ownSpaceIds = new Set<string>()
  let cursor = owner.workspace.spaces.find(space => space.id === owner.spaceId)
  while (cursor) {
    ownSpaceIds.add(cursor.id)
    const parentId = cursor.parentSpaceId ?? null
    cursor = parentId ? owner.workspace.spaces.find(space => space.id === parentId) : undefined
  }
  const resolved = resolveWorkspaceNodesPlacement({
    anchor: {
      x: owner.node.position.x + owner.node.width + CARD_GAP_PX,
      y: owner.node.position.y,
    },
    size,
    nodes: owner.workspace.nodes.map(node => ({
      id: node.id,
      position: node.position,
      data: { width: node.width, height: node.height },
    })),
    spaceRects: owner.workspace.spaces
      .filter(space => !ownSpaceIds.has(space.id))
      .map(space => space.rect)
      .filter((rect): rect is NonNullable<typeof rect> => Boolean(rect)),
    preferredDirection: 'right',
  })
  return { ...resolved.placement, ...size }
}

export function makeCardNode(options: {
  kind: CanvasCardKind
  title: string
  frame: { x: number; y: number; width: number; height: number }
  payload: unknown
}): NodeControlNode {
  return {
    id: randomUUID(),
    sessionId: null,
    title: options.title,
    titlePinnedByUser: false,
    titleIsLiteral: false,
    position: { x: options.frame.x, y: options.frame.y },
    width: options.frame.width,
    height: options.frame.height,
    kind: options.kind,
    profileId: null,
    runtimeKind: null,
    workerBinding: null,
    terminalProviderHint: null,
    labelColorOverride: null,
    status: null,
    startedAt: null,
    endedAt: null,
    exitCode: null,
    lastError: null,
    executionDirectory: null,
    expectedDirectory: null,
    agent: null,
    task: options.payload,
    scrollback: null,
  }
}

export function insertNode(
  state: NodeControlAppState,
  workspace: NodeControlWorkspace,
  node: NodeControlNode,
  spaceId: string | null,
): NodeControlAppState {
  return replaceNodeControlWorkspace(state, workspaceWithNode(workspace, node, spaceId))
}

export function replaceNode(
  state: NodeControlAppState,
  workspace: NodeControlWorkspace,
  node: NodeControlNode,
): NodeControlAppState {
  return replaceNodeControlWorkspace(state, {
    ...workspace,
    nodes: workspace.nodes.map(candidate => (candidate.id === node.id ? node : candidate)),
  })
}

function isRevisionConflict(error: { code: string; debugMessage?: string }): boolean {
  return (
    error.code === 'persistence.invalid_state' &&
    /^App state revision conflict(?:\s|\(|$)/.test(error.debugMessage ?? '')
  )
}

/**
 * Compare-and-swap write: plan against a fresh snapshot, retry on a revision conflict (another
 * client wrote first). The plan must be pure; it runs again on each attempt.
 */
export async function commitWithRetry<T>(
  store: NodeControlAppStateStore,
  plan: (state: NodeControlAppState) => { next: NodeControlAppState; result: T },
  assertActive?: () => void,
): Promise<T & { revision: number }> {
  /* eslint-disable no-await-in-loop -- Each bounded CAS attempt must use a fresh snapshot. */
  for (let attempt = 0; attempt < 3; attempt++) {
    const expectedRevision = await store.readAppStateRevision()
    const state = requireNodeControlState(await store.readAppState())
    const { next, result } = plan(state)
    assertActive?.()
    const written = await store.writeAppState(next, { expectedRevision })
    if (written.ok) {
      return { ...result, revision: written.revision ?? (await store.readAppStateRevision()) }
    }
    if (!isRevisionConflict(written.error) || attempt === 2) {
      throw createAppError(written.error)
    }
  }
  /* eslint-enable no-await-in-loop */
  throw new Error('Card persistence attempts exhausted.')
}
