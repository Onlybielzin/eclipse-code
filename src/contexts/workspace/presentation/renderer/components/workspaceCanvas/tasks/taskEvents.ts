/** "New task" from anywhere (command palette): the task tabs open their name field. */
const NEW_TASK_EVENT = 'eclipse-code:new-task'

export function requestNewTask(): void {
  window.dispatchEvent(new Event(NEW_TASK_EVENT))
}

export function subscribeNewTask(listener: () => void): () => void {
  window.addEventListener(NEW_TASK_EVENT, listener)
  return () => window.removeEventListener(NEW_TASK_EVENT, listener)
}

/** "Close task" from outside the canvas (sidebar card, Space menu): the canvas opens its archive. */
const CLOSE_TASK_EVENT = 'eclipse-code:close-task'

export function requestCloseTask(spaceId: string, anchor?: { x: number; y: number }): void {
  window.dispatchEvent(new CustomEvent(CLOSE_TASK_EVENT, { detail: { spaceId, anchor } }))
}

export function subscribeCloseTask(
  listener: (spaceId: string, anchor: { x: number; y: number } | null) => void,
): () => void {
  const handle = (event: Event) => {
    const detail = (event as CustomEvent<{ spaceId?: unknown; anchor?: unknown }>).detail
    if (typeof detail?.spaceId === 'string') {
      const anchor = detail.anchor as { x: number; y: number } | undefined
      listener(detail.spaceId, anchor && typeof anchor.x === 'number' ? anchor : null)
    }
  }
  window.addEventListener(CLOSE_TASK_EVENT, handle)
  return () => window.removeEventListener(CLOSE_TASK_EVENT, handle)
}

/** A top-level Space is a task: the Space menu offers "Close task" for it. */
export function isTaskSpaceTarget(
  workspaces: ReadonlyArray<{
    id: string
    spaces: ReadonlyArray<{ id: string; parentSpaceId?: string | null }>
  }>,
  target: { kind: string; workspaceId?: string; spaceId?: string },
): boolean {
  return (
    target.kind === 'space' &&
    workspaces.some(
      workspace =>
        workspace.id === target.workspaceId &&
        workspace.spaces.some(space => space.id === target.spaceId && !space.parentSpaceId),
    )
  )
}

/** "Decision history" from the Space menu: the canvas lists the task's answered questions. */
const DECISION_HISTORY_EVENT = 'eclipse-code:decision-history'

export function requestDecisionHistory(spaceId: string): void {
  window.dispatchEvent(new CustomEvent(DECISION_HISTORY_EVENT, { detail: { spaceId } }))
}

export function subscribeDecisionHistory(listener: (spaceId: string) => void): () => void {
  const handle = (event: Event) => {
    const spaceId = (event as CustomEvent<{ spaceId?: unknown }>).detail?.spaceId
    if (typeof spaceId === 'string') {
      listener(spaceId)
    }
  }
  window.addEventListener(DECISION_HISTORY_EVENT, handle)
  return () => window.removeEventListener(DECISION_HISTORY_EVENT, handle)
}
