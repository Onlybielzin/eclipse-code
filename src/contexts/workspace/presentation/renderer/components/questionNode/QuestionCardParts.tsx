import type { JSX } from 'react'
import { useTranslation } from '@app/renderer/i18n'
import { Button } from '@app/renderer/components/ui/Button'
import type { QuestionCardItem, QuestionCardItemAnswer } from '@shared/contracts/canvasCards'
import type { QuestionDraftEntry } from './questionDraft'

/** One question of a pending card: its options, the user's own answer and "let the agent decide". */
export function QuestionCardItemForm({
  item,
  entry,
  disabled,
  sending,
  answersOnClick,
  onToggleOption,
  onText,
  onSubmitText,
  onToggleSkip,
}: {
  item: QuestionCardItem
  entry: QuestionDraftEntry
  disabled: boolean
  sending: boolean
  /** A single single-choice question: a click sends right away. */
  answersOnClick: boolean
  onToggleOption: (index: number) => void
  onText: (value: string) => void
  onSubmitText: () => void
  onToggleSkip: () => void
}): JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="question-node__item" data-testid={`question-node-item-${item.id}`}>
      <div className="question-node__question">{item.question}</div>
      {item.context ? <p className="question-node__context">{item.context}</p> : null}
      {item.multiSelect ? (
        <p className="question-node__hint">{t('canvasCards.question.multiSelectHint')}</p>
      ) : null}
      {item.options.map((option, index) => {
        const selected = entry.optionIndexes.includes(index)
        return (
          <Button
            key={option.label}
            variant="ghost"
            className={[
              'question-node__option',
              option.recommended ? 'question-node__option--recommended' : '',
              selected ? 'question-node__option--selected' : '',
              item.multiSelect ? 'question-node__option--multi' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            aria-pressed={selected}
            data-testid={`question-node-option-${index}`}
            disabled={disabled}
            onClick={() => onToggleOption(index)}
          >
            {item.multiSelect ? <span className="question-node__check" aria-hidden="true" /> : null}
            <span className="question-node__option-label">{option.label}</span>
            {option.recommended ? (
              <span className="question-node__option-tag">
                {t('canvasCards.question.recommended')}
              </span>
            ) : null}
            {option.detail ? (
              <span className="question-node__option-detail">{option.detail}</span>
            ) : null}
          </Button>
        )
      })}
      {item.allowOther ? (
        <form
          className="question-node__other"
          onSubmit={event => {
            event.preventDefault()
            if (entry.text.trim()) {
              onSubmitText()
            }
          }}
        >
          <input
            className="question-node__other-input"
            data-testid="question-node-other"
            aria-label={t('canvasCards.question.otherLabel')}
            placeholder={t('canvasCards.question.otherPlaceholder')}
            value={entry.text}
            disabled={disabled}
            onChange={event => onText(event.target.value)}
            onPointerDown={event => event.stopPropagation()}
          />
          {answersOnClick ? (
            <Button
              type="submit"
              variant="primary"
              size="sm"
              data-testid="question-node-send"
              loading={sending}
              disabled={!entry.text.trim()}
            >
              {sending ? t('canvasCards.question.sending') : t('canvasCards.question.send')}
            </Button>
          ) : null}
        </form>
      ) : null}
      <Button
        variant="ghost"
        size="sm"
        className={['question-node__skip', entry.skipped ? 'question-node__skip--active' : '']
          .filter(Boolean)
          .join(' ')}
        aria-pressed={entry.skipped}
        data-testid="question-node-skip"
        disabled={disabled}
        onClick={onToggleSkip}
      >
        {t('canvasCards.question.skip')}
      </Button>
    </div>
  )
}

/** An answered card: each question with what the user chose, until the card closes itself. */
export function QuestionCardAnswered({
  questions,
  answers,
}: {
  questions: readonly QuestionCardItem[]
  answers: readonly QuestionCardItemAnswer[]
}): JSX.Element {
  const { t } = useTranslation()
  return (
    <>
      {questions.map(item => {
        const answer = answers.find(entry => entry.questionId === item.id)
        const chosen = answer?.skipped
          ? [t('canvasCards.question.skipped')]
          : [
              ...(answer?.optionIndexes ?? []).map(index => item.options[index]?.label ?? ''),
              answer?.text ?? '',
            ].filter(Boolean)
        return (
          <div className="question-node__item" key={item.id}>
            <div className="question-node__question">
              {item.header && questions.length > 1 ? (
                <span className="question-node__header">{item.header}</span>
              ) : null}
              {item.question}
            </div>
            <div
              className="question-node__option question-node__option--chosen"
              data-testid={`question-node-answer-${item.id}`}
            >
              <span className="question-node__option-label">{chosen.join(', ')}</span>
            </div>
          </div>
        )
      })}
      <p className="question-node__context">{t('canvasCards.question.yourChoice')}</p>
    </>
  )
}
