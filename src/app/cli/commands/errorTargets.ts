import type { ErrorTarget } from '../core/command'
// Request paths and recovery commands are CLI metadata, not inferred from response data.
export const errorTargets: ErrorTarget[] = [
  {
    codes: ['worker.unavailable'],
    entity: 'Worker for space',
    fields: { spaceId: 'spaceId' },
    listCommand: 'eclipse-code endpoint list',
  },
  {
    codes: ['worker.unavailable'],
    entity: 'Worker for mount',
    fields: { mountId: 'mountId' },
    listCommand: 'eclipse-code endpoint list',
  },
  {
    codes: ['worker.unavailable'],
    entity: 'Worker for space',
    fields: { space: 'target.locator' },
    listCommand: 'eclipse-code endpoint list',
  },
  {
    codes: ['session.not_found'],
    entity: 'Session',
    fields: { sessionId: 'sessionId' },
    listCommand: 'eclipse-code node list',
  },
  {
    codes: ['worker.unavailable'],
    entity: 'Worker for space',
    fields: { space: 'space' },
    listCommand: 'eclipse-code endpoint list',
  },
  {
    codes: ['worker.unavailable'],
    entity: 'Worker for session',
    fields: { sessionId: 'sessionId' },
    listCommand: 'eclipse-code node list',
  },
  {
    codes: ['node.not_found', 'node.unsupported_operation'],
    entity: 'Node',
    fields: { nodeId: 'nodeId' },
    listCommand: 'eclipse-code node list',
  },
  {
    codes: ['node.not_found'],
    entity: 'Node',
    fields: { nodeId: 'target.nodeId' },
    listCommand: 'eclipse-code node list',
  },
  {
    codes: ['space.not_found', 'space.ambiguous'],
    entity: 'Space',
    fields: { spaceId: 'spaceId' },
    listCommand: 'eclipse-code space list',
  },
  {
    codes: ['space.not_found', 'space.ambiguous'],
    entity: 'Space',
    fields: { space: 'space' },
    listCommand: 'eclipse-code space list',
  },
  {
    codes: ['space.not_found', 'space.ambiguous'],
    entity: 'Space',
    fields: { space: 'target.locator' },
    listCommand: 'eclipse-code space list',
  },
  {
    codes: ['project.not_found'],
    entity: 'Project',
    fields: { projectId: 'projectId' },
    listCommand: 'eclipse-code project list',
  },
  {
    codes: ['mount.not_found', 'mount.unavailable'],
    entity: 'Mount',
    fields: { mountId: 'mountId' },
    listCommand: 'eclipse-code mount list',
  },
  {
    codes: ['worker.unavailable', 'endpoint.not_found', 'endpoint.unavailable'],
    entity: 'Endpoint',
    fields: { endpointId: 'endpointId' },
    listCommand: 'eclipse-code endpoint list',
  },
  {
    codes: ['plugin.not_found'],
    entity: 'Plugin',
    fields: { pluginId: 'pluginId' },
    listCommand: 'eclipse-code plugin list',
  },
]
