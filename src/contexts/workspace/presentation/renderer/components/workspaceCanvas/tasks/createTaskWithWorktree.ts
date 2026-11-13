import type { CreateSpaceResult } from '@shared/contracts/dto/workspaceBootstrap'

/** "Login com Google" -> "login-com-google" (ASCII, lowercase, hyphens, at most 48 chars). */
export function toTaskSlug(name: string): string {
  const slug = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '')
  return slug.length > 0 ? slug : 'task'
}

export interface CreatedTask {
  spaceId: string
  slug: string
  /** Set when the Space exists but its worktree could not be created (e.g. not a git repo). */
  worktreeError: string | null
}

/**
 * Creates a task: a top-level Space bound to the project root, then a new worktree on branch
 * feat/<slug> bound to that Space. Uses the same Worker operations as the eclipse-code CLI, so
 * the state reaches every client through sync.
 */
export async function createTaskWithWorktree({
  projectId,
  name,
}: {
  projectId: string
  name: string
}): Promise<CreatedTask> {
  const slug = toTaskSlug(name)
  const invoke = window.eclipseCodeApi.controlSurface.invoke
  const created = await invoke<CreateSpaceResult>({
    kind: 'command',
    id: 'space.create',
    payload: { projectId, name: slug },
  })
  try {
    await invoke({
      kind: 'command',
      id: 'worktree.create',
      payload: { spaceId: created.spaceId, name: `feat/${slug}` },
    })
    return { spaceId: created.spaceId, slug, worktreeError: null }
  } catch (error) {
    // All or nothing: a task without its worktree would point at the project root, and agents
    // in it would treat it as "outside a task". Remove the Space and report the failure.
    await invoke({
      kind: 'command',
      id: 'space.delete',
      payload: { spaceId: created.spaceId },
    }).catch(() => undefined)
    throw error
  }
}
