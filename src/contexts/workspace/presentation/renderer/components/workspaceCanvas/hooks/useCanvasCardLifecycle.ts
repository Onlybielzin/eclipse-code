import { useEffect, useRef } from 'react'
import type { Node } from '@xyflow/react'
import { isQuestionCardClosable } from '@contexts/workspace/domain/canvasCards'
import type { TerminalNodeData } from '../../../types'

const SWEEP_INTERVAL_MS = 5_000

/**
 * Cards that should leave the canvas: answered questions (the decisions are kept in the task
 * history) and to-do lists whose agent window is gone.
 */
export function selectCardsToClose(nodes: readonly Node<TerminalNodeData>[]): string[] {
  const ids = new Set(nodes.map(node => node.id))
  return nodes
    .filter(node => {
      if (node.data.kind === 'question' && node.data.question) {
        return isQuestionCardClosable(node.data.question)
      }
      const owner = node.data.kind === 'todos' ? node.data.todos?.ownerNodeId : null
      return Boolean(owner) && !ids.has(owner!)
    })
    .map(node => node.id)
}

export function useCanvasCardLifecycle({
  nodes,
  closeNodesById,
}: {
  nodes: readonly Node<TerminalNodeData>[]
  closeNodesById: (nodeIds: string[]) => Promise<void>
}): void {
  const nodesRef = useRef(nodes)
  nodesRef.current = nodes
  const closeRef = useRef(closeNodesById)
  closeRef.current = closeNodesById
  const hasCards = nodes.some(node => node.data.kind === 'question' || node.data.kind === 'todos')
  // A card answered just now closes on this render, not on the next sweep.
  const answeredKey = nodes
    .filter(node => node.data.kind === 'question' && node.data.question?.status === 'answered')
    .map(node => node.id)
    .join(',')

  useEffect(() => {
    if (!hasCards) {
      return
    }
    let closing = false
    const sweep = () => {
      const ids = selectCardsToClose(nodesRef.current)
      if (closing || ids.length === 0) {
        return
      }
      closing = true
      void closeRef.current(ids).finally(() => {
        closing = false
      })
    }
    sweep()
    const timer = window.setInterval(sweep, SWEEP_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [hasCards, answeredKey])
}
