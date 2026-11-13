import { useEffect, useMemo, useState } from 'react'
import type { JSX } from 'react'
import { useTranslation } from '@app/renderer/i18n'
import { toErrorMessage } from '@app/renderer/shell/utils/format'
import type { QuestionCardData } from '@shared/contracts/canvasCards'
import { QuestionCardAnswered, QuestionCardItemForm } from './questionNode/QuestionCardParts'
import {
  countAnswered,
  draftToAnswers,
  draftEntry,
  isDraftEntryAnswered,
  loadQuestionDraft,
  nextUnansweredIndex,
  saveQuestionDraft,
  setDraftText,
  toggleDraftOption,
  toggleDraftSkip,
  type QuestionDraft,
} from './questionNode/questionDraft'
import type { LabelColor } from '@shared/types/labelColor'
import type { NodeFrame, Point } from '../types'
import { NodeResizeHandles } from './shared/NodeResizeHandles'
import { useNodeFrameResize } from '../utils/nodeFrameResize'
import { resolveCanonicalNodeMinSize } from '../utils/workspaceNodeSizing'
import { shouldStopWheelPropagation } from './taskNode/helpers'
import { NodeKindIcon } from './shared/NodeKindIcon'
import { WindowHeader } from './shared/WindowHeader'
import { WindowPlate } from './shared/WindowPlate'
import { Button } from '@app/renderer/components/ui/Button'

export interface CardInteractionOptions {
  shiftKey?: boolean
}

type AnswerPayload = { answers: ReturnType<typeof draftToAnswers> }

/** Sends the user's answers through the Worker, which delivers them to the asking agent. */
async function sendAnswer(nodeId: string, answer: AnswerPayload) {
  await window.eclipseCodeApi.controlSurface.invoke({
    kind: 'command',
    id: 'question.answer',
    payload: { nodeId, ...answer },
  })
}

export function useCardFrame(options: {
  kind: 'question' | 'todos'
  position: Point
  width: number
  height: number
  onResize: (frame: NodeFrame) => void
}) {
  const { draftFrame, handleResizePointerDown } = useNodeFrameResize({
    position: options.position,
    width: options.width,
    height: options.height,
    minSize: resolveCanonicalNodeMinSize(options.kind),
    onResize: options.onResize,
  })
  const frame = draftFrame ?? {
    position: options.position,
    size: { width: options.width, height: options.height },
  }
  const { x, y } = options.position
  const style = useMemo(
    () => ({
      width: frame.size.width,
      height: frame.size.height,
      transform:
        frame.position.x !== x || frame.position.y !== y
          ? `translate(${frame.position.x - x}px, ${frame.position.y - y}px)`
          : undefined,
    }),
    [frame.position.x, frame.position.y, frame.size.height, frame.size.width, x, y],
  )
  return { style, handleResizePointerDown }
}

function formatTime(iso: string | null): string {
  const date = iso ? new Date(iso) : null
  return date && Number.isFinite(date.getTime())
    ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : ''
}

export function QuestionNode({
  nodeId,
  askerTitle,
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
  nodeId: string
  askerTitle: string
  place: string | null
  data: QuestionCardData
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
    kind: 'question',
    position,
    width,
    height,
    onResize,
  })
  const [draft, setDraft] = useState<QuestionDraft>(() => loadQuestionDraft(nodeId))
  const [activeIndex, setActiveIndex] = useState(0)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const answered = data.status === 'answered'
  const who = [askerTitle, place].filter(Boolean).join(' · ')
  const questions = data.questions
  const total = questions.length
  const done = countAnswered(questions, draft)
  const active = questions[Math.min(activeIndex, Math.max(total - 1, 0))] ?? null
  // One single-choice question answers on the first click, like before multi-question cards.
  const answersOnClick = total === 1 && !questions[0]?.multiSelect

  useEffect(() => {
    saveQuestionDraft(nodeId, answered ? null : draft)
  }, [answered, draft, nodeId])

  const submit = async (nextDraft: QuestionDraft) => {
    if (sending || answered) {
      return
    }
    setSending(true)
    setError(null)
    try {
      await sendAnswer(nodeId, { answers: draftToAnswers(questions, nextDraft) })
    } catch (caught) {
      setError(t('canvasCards.question.answerFailed', { message: toErrorMessage(caught) }))
    } finally {
      setSending(false)
    }
  }

  const update = (nextDraft: QuestionDraft, options: { advance: boolean; send: boolean }) => {
    setDraft(nextDraft)
    if (options.send) {
      void submit(nextDraft)
      return
    }
    if (options.advance && total > 1) {
      const next = nextUnansweredIndex(questions, nextDraft, activeIndex)
      if (next !== null) {
        setActiveIndex(next)
      }
    }
  }

  return (
    <div
      className={`canvas-card question-node nowheel${answered ? ' question-node--answered' : ' question-node--pending'}`}
      data-cove-part="window"
      data-cove-kind="question"
      data-testid="question-node"
      data-question-status={data.status}
      data-question-count={total}
      style={style}
      onClickCapture={event => {
        const target = event.target instanceof Element ? event.target : null
        if (event.button !== 0 || !target || target.closest('.nodrag')) {
          return
        }
        onInteractionStart?.({ shiftKey: event.shiftKey })
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
        icon={<NodeKindIcon kind="question" />}
        title={
          <span className="canvas-card__title">
            {total > 1
              ? t('canvasCards.question.kindMany', { count: total })
              : t('canvasCards.question.kind')}
          </span>
        }
        status={who ? <span className="canvas-card__who">{who}</span> : undefined}
        close={{ label: t('canvasCards.question.close'), className: 'canvas-card__close', onClose }}
      />
      <WindowPlate kind="plan" />
      <div className="canvas-card__body nodrag nowheel" data-cove-part="window-body">
        <span
          className={`canvas-card__pill canvas-card__pill--${answered ? 'done' : 'wait'}`}
          data-testid="question-node-status"
        >
          {answered
            ? t('canvasCards.question.answeredAt', { time: formatTime(data.answeredAt) })
            : t('canvasCards.question.waiting')}
        </span>
        {answered ? (
          <QuestionCardAnswered questions={questions} answers={data.answers ?? []} />
        ) : (
          <>
            {total > 1 ? (
              <div className="question-node__tabs" role="tablist">
                {questions.map((item, index) => {
                  const answeredTab = isDraftEntryAnswered(draftEntry(draft, item.id))
                  return (
                    <Button
                      key={item.id}
                      variant="ghost"
                      size="sm"
                      role="tab"
                      aria-selected={item === active}
                      className={[
                        'question-node__tab',
                        item === active ? 'question-node__tab--active' : '',
                        answeredTab ? 'question-node__tab--done' : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      data-testid={`question-node-tab-${index}`}
                      onClick={() => setActiveIndex(index)}
                    >
                      {item.header || t('canvasCards.question.tab', { index: index + 1 })}
                    </Button>
                  )
                })}
              </div>
            ) : null}
            {active ? (
              <QuestionCardItemForm
                key={active.id}
                item={active}
                entry={draftEntry(draft, active.id)}
                disabled={sending}
                sending={sending}
                answersOnClick={answersOnClick}
                onToggleOption={index =>
                  update(toggleDraftOption(draft, active, index), {
                    advance: !active.multiSelect,
                    send: answersOnClick,
                  })
                }
                onText={value =>
                  update(setDraftText(draft, active, value), { advance: false, send: false })
                }
                onSubmitText={() =>
                  update(draft, { advance: !active.multiSelect, send: answersOnClick })
                }
                onToggleSkip={() =>
                  update(toggleDraftSkip(draft, active), {
                    advance: true,
                    send: answersOnClick,
                  })
                }
              />
            ) : null}
            {answersOnClick ? null : (
              <Button
                variant="primary"
                size="sm"
                className="question-node__send-all"
                data-testid="question-node-send-all"
                loading={sending}
                disabled={done < total}
                onClick={() => void submit(draft)}
              >
                {done < total
                  ? t('canvasCards.question.sendProgress', { done, total })
                  : t('canvasCards.question.sendAll')}
              </Button>
            )}
          </>
        )}
        {error ? (
          <p className="question-node__error" role="alert" data-testid="question-node-error">
            {error}
          </p>
        ) : null}
      </div>
      <NodeResizeHandles
        classNamePrefix="task-node"
        testIdPrefix="question-resizer"
        handleResizePointerDown={handleResizePointerDown}
      />
    </div>
  )
}
