import { useState, type KeyboardEvent } from 'react'
import {
  SUBTASK_STATE_LABELS,
  USER_QUESTION_STATUS_LABELS,
  type Artifact,
  type QuestionItem,
  type Subtask,
  type UserQuestion,
} from '@shared/domain'
import type { SubtaskDetail } from '@shared/ipc'
import { STATE_BADGE_CLASS, STATE_ICON_CLASS } from '../store/format'
import { useAppState, useStore } from '../store/context'

const FAILURE_TEXT: Record<string, string> = {
  member_blocked: 'o membro se declarou bloqueado',
  process_exited: 'processo morreu',
  silent_timeout: 'sem resposta',
  turn_timeout: 'turno passou do tempo máximo',
  session_lost: 'sessão perdida',
  spawn_failed: 'não abriu',
  refusal: 'o modelo recusou',
  limit_reached: 'limite atingido',
  error: 'erro',
}

const CHANGE_TEXT = {
  added: 'novo',
  modified: 'alterado',
  deleted: 'removido',
  renamed: 'renomeado',
}

function latestArtifact(artifacts: readonly Artifact[]): Artifact | null {
  let best: Artifact | null = null
  for (const a of artifacts) if (!best || a.createdAt >= best.createdAt) best = a
  return best
}

export function DeliveryView({
  subtask,
  detail,
}: {
  subtask: Subtask
  detail: SubtaskDetail | undefined
}) {
  const questions = useAppState((s) => s.questions)
  const allSubtasks = useAppState((s) => s.subtasks[subtask.taskId])
  const artifact = detail ? latestArtifact(detail.artifacts) : null
  const delivery = artifact?.delivery ?? null
  const openQuestion =
    questions.find((q) => q.subtaskId === subtask.id && q.status === 'open') ?? null
  // Ultima pergunta fechada desta subtarefa vista nesta sessao da tela (historico curto).
  const closedQuestion = openQuestion
    ? null
    : (questions
        .filter((q) => q.subtaskId === subtask.id && q.status !== 'open')
        .sort((a, b) => (b.answeredAt ?? b.createdAt) - (a.answeredAt ?? a.createdAt))[0] ?? null)
  const references = subtask.referenceTaskIds
    .map((id) => allSubtasks?.find((s) => s.id === id)?.title ?? id)
    .join(', ')

  return (
    <div className="entrega" data-testid="delivery">
      <div className="badges">
        <span className={`badge ${STATE_BADGE_CLASS[subtask.state]}`}>
          <i className={`ic ${STATE_ICON_CLASS[subtask.state]}`} />
          {SUBTASK_STATE_LABELS[subtask.state]}
        </span>
        {artifact?.format === 'unformatted' && (
          <span className="badge b-submitted">sem formato</span>
        )}
      </div>
      <h3>{subtask.title}</h3>
      {references && <p className="muted small">Correção de: {references}</p>}
      {subtask.state === 'failed' && (
        <div className="box box-bad">
          <h4>Bloqueado</h4>
          {subtask.failureCode ? FAILURE_TEXT[subtask.failureCode] : 'sem motivo informado'}
          {subtask.statusMessage ? `: ${subtask.statusMessage}` : ''}
        </div>
      )}

      {!detail && <p className="muted">Carregando a entrega...</p>}
      {detail && !delivery && (
        <div className="box">
          <h4>Ainda sem entrega</h4>
          <p className="pre">{subtask.statusMessage ?? 'O membro ainda não entregou.'}</p>
        </div>
      )}

      {delivery && (
        <div className="box">
          <h4>Resumo</h4>
          <p className="pre">{delivery.summary || '(vazio)'}</p>
        </div>
      )}

      {openQuestion ? (
        <QuestionBox question={openQuestion} />
      ) : (
        delivery &&
        delivery.questions.length > 0 && (
          <div className="box box-warn">
            <h4>Dúvidas do membro</h4>
            <ul>
              {delivery.questions.map((q) => (
                <li key={q.id}>{q.prompt}</li>
              ))}
            </ul>
            <p className="muted small">O Líder decide se repassa para você.</p>
          </div>
        )
      )}
      {closedQuestion && (
        <p className="muted small" data-testid="question-closed">
          Pergunta ao usuário: {USER_QUESTION_STATUS_LABELS[closedQuestion.status]}.
        </p>
      )}

      {delivery && delivery.files.length > 0 && (
        <div className="box files">
          <h4>Arquivos</h4>
          <ul>
            {delivery.files.map((f) => (
              <li key={f.path}>
                {f.path} <span className="muted">({CHANGE_TEXT[f.change]})</span>
                {f.note ? ` · ${f.note}` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}

      {delivery && delivery.tests.length > 0 && (
        <div className="box">
          <h4>Testes</h4>
          <ul>
            {delivery.tests.map((t, i) => (
              <li key={`${t.command}-${i}`}>
                <code>{t.command}</code>: {t.result}
                {t.passed === false ? ' (falhou)' : ''}
              </li>
            ))}
          </ul>
        </div>
      )}

      <details className="box">
        <summary>Instruções do Líder</summary>
        <p className="pre">{subtask.instructions}</p>
      </details>
    </div>
  )
}

export function QuestionBox({ question }: { question: UserQuestion }) {
  const store = useStore()
  // A opcao sugerida pelo Lider ja vem marcada: confirmar e so Responder (ou Ctrl+Enter).
  const [picked, setPicked] = useState<Record<string, string[]>>(() => suggestedPicks(question))
  const [texts, setTexts] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)

  const submit = async (override?: Record<string, string[]>) => {
    const choice = override ?? picked
    setBusy(true)
    await store.answerQuestion(
      question.id,
      question.items.map((item) => ({
        itemId: item.id,
        optionIds: choice[item.id] ?? [],
        text: texts[item.id]?.trim() ? (texts[item.id] ?? '').trim() : null,
      })),
    )
    setBusy(false)
  }

  const toggle = (item: QuestionItem, optionId: string) => {
    setPicked((p) => {
      const cur = p[item.id] ?? []
      const next = item.multiSelect
        ? cur.includes(optionId)
          ? cur.filter((x) => x !== optionId)
          : [...cur, optionId]
        : [optionId]
      return { ...p, [item.id]: next }
    })
  }

  const hasAnswer =
    Object.values(picked).some((ids) => ids.length > 0) ||
    Object.values(texts).some((t) => t.trim().length > 0)

  // Ctrl+Enter (ou Cmd+Enter) envia de qualquer campo do cartao, quando ha resposta.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey)) return
    e.preventDefault()
    if (!busy && hasAnswer) void submit()
  }

  return (
    <div className="box box-warn question-card" data-testid="question" onKeyDown={onKeyDown}>
      <h4>Pergunta para você</h4>
      {question.items.map((item) => (
        <div key={item.id} className="q-item">
          <p className="q-prompt">{item.prompt}</p>
          <div className="answer">
            {item.options.map((o) => (
              <button
                key={o.id}
                type="button"
                disabled={busy}
                aria-pressed={(picked[item.id] ?? []).includes(o.id)}
                title={o.description}
                onClick={() => toggle(item, o.id)}
              >
                {o.label}
              </button>
            ))}
          </div>
          {item.options
            .filter((o) => (picked[item.id] ?? []).includes(o.id) && o.description)
            .map((o) => (
              <p key={o.id} className="q-desc">
                {o.description}
              </p>
            ))}
          {(item.allowFreeText || item.options.length === 0) && (
            <input
              className="field"
              placeholder="Responda com suas palavras"
              value={texts[item.id] ?? ''}
              onChange={(e) => setTexts((t) => ({ ...t, [item.id]: e.target.value }))}
            />
          )}
        </div>
      ))}
      <div className="answer">
        <button
          type="button"
          className="primary"
          disabled={busy || !hasAnswer}
          title="Ctrl+Enter"
          onClick={() => void submit()}
        >
          Responder <kbd>Ctrl+Enter</kbd>
        </button>
        <button
          type="button"
          className="ghost"
          disabled={busy}
          onClick={() => void store.dismissQuestion(question.id)}
        >
          Deixe o Líder decidir
        </button>
      </div>
    </div>
  )
}

/** Opcao sugerida: o rotulo diz "recomendado/recomendada/sugerido/sugerida". */
export function isSuggestedOption(label: string): boolean {
  return /recomendad|sugerid/i.test(label)
}

function suggestedPicks(question: UserQuestion): Record<string, string[]> {
  const picks: Record<string, string[]> = {}
  for (const item of question.items) {
    const suggested = item.options.filter((o) => isSuggestedOption(o.label)).map((o) => o.id)
    if (suggested.length > 0) picks[item.id] = item.multiSelect ? suggested : [suggested[0]!]
  }
  return picks
}
