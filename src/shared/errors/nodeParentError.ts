const presentations = {
  nodeNoParent: {
    message: 'This node was started by the user, so it has no parent agent.',
    hint: 'Use "eclipse-code agent list" to choose a recipient, or report your findings to the user.',
  },
  nodeParentDeleted: {
    message: 'The agent that created this node has been deleted.',
    hint: 'Use "eclipse-code agent list" to choose another recipient, or leave your findings in a shared note.',
  },
  nodeParentIdentityRequired: {
    message: '@parent works only inside an Eclipse Code terminal.',
    hint: 'Run this command inside Eclipse Code, or replace @parent with a node ID from "eclipse-code node list".',
  },
  nodeParentIdentityMismatch: {
    message: 'The current terminal identity does not match its Eclipse Code session.',
    hint: 'Open a new Eclipse Code terminal and run "eclipse-code whoami" before choosing a recipient.',
  },
  nodeParentUnavailable: {
    message: 'The parent node could not be resolved.',
    hint: 'Run "eclipse-code node get --node @self" to inspect your lineage, then choose a recipient with "eclipse-code node list".',
  },
}

/** Explain selector failures without changing their authority or retry semantics. */
export function nodeParentErrorPresentation(error: { code?: string; details?: unknown }) {
  const reason =
    error.details && typeof error.details === 'object' && 'reason' in error.details
      ? error.details.reason
      : undefined
  let key: keyof typeof presentations
  if (error.code === 'common.forbidden' && reason === 'caller_identity_mismatch') {
    key = 'nodeParentIdentityMismatch'
  } else if (error.code === 'node.parent_unavailable') {
    key =
      reason === 'no_parent'
        ? 'nodeNoParent'
        : reason === 'parent_deleted'
          ? 'nodeParentDeleted'
          : reason === 'caller_identity_required'
            ? 'nodeParentIdentityRequired'
            : 'nodeParentUnavailable'
  } else {
    return undefined
  }
  return { key, ...presentations[key] }
}
