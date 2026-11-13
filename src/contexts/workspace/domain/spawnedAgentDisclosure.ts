import type { NodeLineageRecord } from './nodeLineage'

/**
 * An agent created by another agent (a team member started by the lead) starts as
 * a compact window, like a subtask of its creator. Only the creation commit applies
 * this rule; afterwards the user's own expand/collapse choice owns the disclosure.
 * Agents the user starts (no lineage) and non-agent nodes keep their normal window.
 */
export function collapseSpawnedAgentOnCreate<W extends { collapsedNodeIds?: string[] }>(
  workspace: W,
  node: { id: string; kind: string },
  lineage: NodeLineageRecord | null | undefined,
): W {
  if (!lineage || node.kind !== 'agent' || lineage.nodeId !== node.id) {
    return workspace
  }
  const current = workspace.collapsedNodeIds ?? []
  if (current.includes(node.id)) {
    return workspace
  }
  return { ...workspace, collapsedNodeIds: [...current, node.id] }
}
