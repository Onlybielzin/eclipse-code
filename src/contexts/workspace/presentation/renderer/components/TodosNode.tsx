import type { JSX } from 'react'
import { useTranslation } from '@app/renderer/i18n'
import type { TodosCardData } from '@shared/contracts/canvasCards'
import type { LabelColor } from '@shared/types/labelColor'
import { summarizeTodoProgress } from '@contexts/workspace/domain/canvasCards'
import type { NodeFrame, Point } from '../types'
import { NodeResizeHandles } from './shared/NodeResizeHandles'
import { shouldStopWheelPropagation } from './taskNode/helpers'
import { NodeKindIcon } from './shared/NodeKindIcon'
import { WindowHeader } from './shared/WindowHeader'
import { WindowPlate } from './shared/WindowPlate'
import { useCardFrame, type CardInteractionOptions } from './QuestionNode'

/** A read-only mirror of an agent's task list; the agent's hook keeps it current. */
export function TodosNode({
  ownerTitle,
  place,
  data,
  labelColor,
  position,
  width,
  height,
  onClose,
  onResize,
  onInteractionStart,
}: {
  ownerTitle: string
  place: string | null
  data: TodosCardData
  labelColor?: LabelColor | null
  position: Point
  width: number
  height: number
  onClose: () => void
  onResize: (frame: NodeFrame) => void
  onInteractionStart?: (options?: CardInteractionOptions) => void
}): JSX.Element {
  const { t } = useTranslation()
  const { style, handleResizePointerDown } = useCardFrame({
    kind: 'todos',
    position,
    width,
    height,
    onResize,
  })
  const progress = summarizeTodoProgress(data.items)
  const percent = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0
  const who = [ownerTitle, place].filter(Boolean).join(' · ')
  // Items carry no ids; the same text twice gets its occurrence number.
  const seen = new Map<string, number>()
  const keyedItems = data.items.map(item => {
    const occurrence = (seen.get(item.text) ?? 0) + 1
    seen.set(item.text, occurrence)
    return { item, key: `${occurrence}:${item.text}` }
  })

  return (
    <div
      className="canvas-card todos-node nowheel"
      data-cove-part="window"
      data-cove-kind="todos"
      data-testid="todos-node"
      style={style}
      onClickCapture={event => {
        if (event.button === 0) {
          onInteractionStart?.({ shiftKey: event.shiftKey })
        }
      }}
      onWheel={event => {
        if (shouldStopWheelPropagation(event.currentTarget)) {
          event.stopPropagation()
        }
      }}
    >
      <WindowHeader
        className="canvas-card__header"
        kind="plan"
        labelColor={labelColor}
        icon={<NodeKindIcon kind="todos" />}
        title={<span className="canvas-card__title">{t('canvasCards.todos.kind')}</span>}
        status={who ? <span className="canvas-card__who">{who}</span> : undefined}
        close={{ label: t('canvasCards.todos.close'), className: 'canvas-card__close', onClose }}
      />
      <WindowPlate kind="plan" />
      <div className="canvas-card__body nowheel" data-cove-part="window-body">
        <div className="todos-node__meta" data-testid="todos-node-progress">
          {progress.total > 0
            ? t('canvasCards.todos.progress', { done: progress.done, total: progress.total })
            : t('canvasCards.todos.empty')}
        </div>
        <div className="todos-node__bar" aria-hidden="true">
          <i style={{ width: `${percent}%` }} />
        </div>
        <ul className="todos-node__list">
          {keyedItems.map(({ item, key }) => (
            <li
              key={key}
              className={`todos-node__item todos-node__item--${item.status}`}
              data-testid="todos-node-item"
              data-status={item.status}
            >
              <i className="todos-node__check" aria-hidden="true" />
              <span>{item.text}</span>
            </li>
          ))}
        </ul>
      </div>
      <NodeResizeHandles
        classNamePrefix="task-node"
        testIdPrefix="todos-resizer"
        handleResizePointerDown={handleResizePointerDown}
      />
    </div>
  )
}
