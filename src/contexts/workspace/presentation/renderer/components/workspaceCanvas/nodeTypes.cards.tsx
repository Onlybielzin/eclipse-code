import type { MutableRefObject, ReactElement } from 'react'
import type { LabelColor } from '@shared/types/labelColor'
import { QuestionNode } from '../QuestionNode'
import { TodosNode } from '../TodosNode'
import type { NodeFrame, TerminalNodeData, WorkspaceSpaceState } from '../../types'
import { useNodePosition } from './nodePosition'

/** Question and to-do cards: the agent's window title plus the task (Space) they belong to. */
export function WorkspaceCanvasCardNodeType({
  data,
  id,
  spacesRef,
  selectNode,
  closeNodeRef,
  resizeNodeRef,
  normalizeViewportForTerminalInteractionRef,
}: {
  data: TerminalNodeData
  id: string
  spacesRef: MutableRefObject<WorkspaceSpaceState[]>
  selectNode: (nodeId: string, options?: { toggle?: boolean }) => void
  closeNodeRef: MutableRefObject<(nodeId: string) => Promise<void>>
  resizeNodeRef: MutableRefObject<(nodeId: string, desiredFrame: NodeFrame) => void>
  normalizeViewportForTerminalInteractionRef: MutableRefObject<(nodeId: string) => void>
}): ReactElement | null {
  const position = useNodePosition(id)
  const place = spacesRef.current.find(space => space.nodeIds.includes(id))?.name ?? null
  const labelColor =
    (data as TerminalNodeData & { effectiveLabelColor?: LabelColor | null }).effectiveLabelColor ??
    null
  const common = {
    place,
    labelColor,
    position,
    width: data.width,
    height: data.height,
    onClose: () => {
      void closeNodeRef.current(id)
    },
    onResize: (frame: NodeFrame) => resizeNodeRef.current(id, frame),
    onInteractionStart: (options?: { shiftKey?: boolean }) => {
      selectNode(id, options?.shiftKey ? { toggle: true } : undefined)
      normalizeViewportForTerminalInteractionRef.current(id)
    },
  }
  if (data.kind === 'question' && data.question) {
    return <QuestionNode nodeId={id} askerTitle={data.title} data={data.question} {...common} />
  }
  if (data.kind === 'todos' && data.todos) {
    return <TodosNode ownerTitle={data.title} data={data.todos} {...common} />
  }
  return null
}
