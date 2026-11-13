import { useEffect, useState } from 'react'
import { useTranslation } from '@app/renderer/i18n'
import { Dialog } from '@app/renderer/components/ui/Dialog'
import { toErrorMessage } from '@app/renderer/shell/utils/format'
import type { TaskDecisionRecord } from '@shared/contracts/canvasCards'
import { subscribeDecisionHistory } from './taskEvents'

type HistoryState =
  | { status: 'closed' }
  | { status: 'loading'; spaceId: string }
  | { status: 'ready'; spaceId: string; decisions: TaskDecisionRecord[] }
  | { status: 'failed'; spaceId: string; message: string }

/** Answered questions of one task, newest first. The cards close; the decisions stay here. */
export function TaskDecisionHistory({
  spaces,
}: {
  spaces: ReadonlyArray<{ id: string; name: string }>
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const [state, setState] = useState<HistoryState>({ status: 'closed' })

  useEffect(
    () =>
      subscribeDecisionHistory(spaceId => {
        setState({ status: 'loading', spaceId })
        window.eclipseCodeApi.controlSurface
          .invoke<{ decisions: TaskDecisionRecord[] }>({
            kind: 'query',
            id: 'question.history',
            payload: { spaceId },
          })
          .then(result => {
            setState(current =>
              current.status === 'loading' && current.spaceId === spaceId
                ? { status: 'ready', spaceId, decisions: result.decisions }
                : current,
            )
          })
          .catch((error: unknown) => {
            setState(current =>
              current.status === 'loading' && current.spaceId === spaceId
                ? { status: 'failed', spaceId, message: toErrorMessage(error) }
                : current,
            )
          })
      }),
    [],
  )

  if (state.status === 'closed') {
    return null
  }
  const taskName = spaces.find(space => space.id === state.spaceId)?.name ?? ''
  return (
    <Dialog
      open
      backdropClassName="cove-window-backdrop"
      backdropTestId="task-decision-history-backdrop"
      className="cove-window task-decision-history"
      data-testid="task-decision-history"
      aria-label={t('canvasCards.question.historyTitle')}
      onDismiss={() => setState({ status: 'closed' })}
    >
      <h3>
        {t('canvasCards.question.historyTitle')}
        {taskName ? ` · ${taskName}` : ''}
      </h3>
      {state.status === 'failed' ? (
        <p className="cove-window__error">
          {t('canvasCards.question.historyLoadFailed', { message: state.message })}
        </p>
      ) : null}
      {state.status === 'ready' && state.decisions.length === 0 ? (
        <p className="cove-window__meta">{t('canvasCards.question.historyEmpty')}</p>
      ) : null}
      {state.status === 'ready' ? (
        <ol className="task-decision-history__list">
          {state.decisions.map(decision => (
            <li key={decision.id} data-testid="task-decision-history-item">
              <div className="task-decision-history__question">{decision.question}</div>
              <div className="task-decision-history__answer">{decision.answer}</div>
              <div className="cove-window__meta">
                {decision.askedByTitle} · {new Date(decision.answeredAt).toLocaleString()}
              </div>
            </li>
          ))}
        </ol>
      ) : null}
    </Dialog>
  )
}
