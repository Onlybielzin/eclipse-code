import type { WorkspaceState } from '@contexts/workspace/presentation/renderer/types'
import type { ProjectIconId } from '@shared/types/projectIcon'

export interface PendingQuestionReference {
  workspaceId: string
  projectName: string
  projectIconId: ProjectIconId | null
  nodeId: string
  /** The first question of the card. */
  question: string
  questionCount: number
  /** The agent that asked; its own "waiting" row is replaced by this question. */
  askedByNodeId: string | null
  askerTitle: string
  spaceName: string | null
  createdAtMs: number | null
}

/** Every question card still waiting for the user, across projects, oldest first. */
export function listPendingQuestions(
  workspaces: readonly WorkspaceState[],
): PendingQuestionReference[] {
  return workspaces.flatMap(workspace =>
    workspace.nodes
      .filter(node => node.data.kind === 'question' && node.data.question?.status === 'pending')
      .map(node => {
        const createdAtMs = Date.parse(node.data.question?.createdAt ?? '')
        return {
          workspaceId: workspace.id,
          projectName: workspace.name,
          projectIconId: workspace.iconId ?? null,
          nodeId: node.id,
          question: node.data.question?.questions[0]?.question ?? '',
          questionCount: node.data.question?.questions.length ?? 1,
          askedByNodeId: node.data.question?.askedByNodeId ?? null,
          askerTitle: node.data.title,
          spaceName: workspace.spaces.find(space => space.nodeIds.includes(node.id))?.name ?? null,
          createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : null,
        }
      })
      .sort((a, b) => (a.createdAtMs ?? 0) - (b.createdAtMs ?? 0)),
  )
}
