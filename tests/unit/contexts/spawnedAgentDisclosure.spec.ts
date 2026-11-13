import { describe, expect, it } from 'vitest'
import { collapseSpawnedAgentOnCreate } from '../../../src/contexts/workspace/domain/spawnedAgentDisclosure'
import type { NodeLineageRecord } from '../../../src/contexts/workspace/domain/nodeLineage'

const lineage = (nodeId: string): NodeLineageRecord => ({
  nodeId,
  spawnedBy: 'lead',
  rootNodeId: 'lead',
  lineageDepth: 2,
})

describe('collapseSpawnedAgentOnCreate', () => {
  it('starts an agent created by another agent as a compact window', () => {
    const workspace = { id: 'w', collapsedNodeIds: ['other'] }
    expect(
      collapseSpawnedAgentOnCreate(workspace, { id: 'dev', kind: 'agent' }, lineage('dev'))
        .collapsedNodeIds,
    ).toEqual(['other', 'dev'])
  })

  it('creates the collapse list when the workspace had none', () => {
    expect(
      collapseSpawnedAgentOnCreate({ id: 'w' }, { id: 'dev', kind: 'agent' }, lineage('dev'))
        .collapsedNodeIds,
    ).toEqual(['dev'])
  })

  it('keeps agents the user starts open', () => {
    const workspace = { id: 'w' }
    expect(collapseSpawnedAgentOnCreate(workspace, { id: 'lead', kind: 'agent' }, null)).toBe(
      workspace,
    )
  })

  it.each(['terminal', 'note', 'question', 'todos'])('keeps a spawned %s open', kind => {
    const workspace = { id: 'w' }
    expect(collapseSpawnedAgentOnCreate(workspace, { id: 'x', kind }, lineage('x'))).toBe(workspace)
  })

  it('ignores a lineage record that belongs to another node', () => {
    const workspace = { id: 'w' }
    expect(
      collapseSpawnedAgentOnCreate(workspace, { id: 'dev', kind: 'agent' }, lineage('nope')),
    ).toBe(workspace)
  })

  it('does not duplicate an id that is already collapsed', () => {
    const workspace = { id: 'w', collapsedNodeIds: ['dev'] }
    expect(
      collapseSpawnedAgentOnCreate(workspace, { id: 'dev', kind: 'agent' }, lineage('dev')),
    ).toBe(workspace)
  })
})
