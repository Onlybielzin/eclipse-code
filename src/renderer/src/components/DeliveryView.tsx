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
        <QuestionBox key={openQuestion.id} question={openQuestion} />
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
  const [step, setStep] = useState(0)
  // Quem pergunta: o membro da subtarefa em duvida ou, sem subtarefa, o Lider.
  const asker = useAppState((s) => {
    const sub = question.subtaskId
      ? s.subtasks[question.taskId]?.find((x) => x.id === question.subtaskId)
      : undefined
    return sub ? `${s.roles[sub.roleId]?.name ?? 'Membro'} · ${sub.title}` : 'Líder'
  })

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

  // Item so conta como respondido se o usuario ja o viu: a sugerida pre-marcada nao basta.
  const [seen, setSeen] = useState<string[]>([])
  const current = question.items[Math.min(step, question.items.length - 1)]
  const isAnswered = (it: QuestionItem, picks: Record<string, string[]>) =>
    (picks[it.id] ?? []).length > 0 || (texts[it.id] ?? '').trim().length > 0
  /** Proximo item (depois do atual, dando a volta) ainda sem resposta vista; -1 se nao ha. */
  const nextPending = (picks: Record<string, string[]>): number => {
    const n = question.items.length
    for (let k = 1; k < n; k++) {
      const i = (step + k) % n
      const it = question.items[i]
      if (it && !(seen.includes(it.id) && isAnswered(it, picks))) return i
    }
    return -1
  }
  const goTo = (i: number) => {
    if (current) setSeen((s) => (s.includes(current.id) ? s : [...s, current.id]))
    setStep(i)
  }

  const toggle = (item: QuestionItem, optionId: string) => {
    const cur = picked[item.id] ?? []
    const next = item.multiSelect
      ? cur.includes(optionId)
        ? cur.filter((x) => x !== optionId)
        : [...cur, optionId]
      : [optionId]
    const picks = { ...picked, [item.id]: next }
    setPicked(picks)
    // Escolha unica responde o item: segue para o proximo sem resposta.
    if (!item.multiSelect) {
      const to = nextPending(picks)
      if (to >= 0) goTo(to)
    }
  }

  const pending = nextPending(picked)
  const canSend = pending === -1 && !!current && isAnswered(current, picked)
  const canAct = !busy && (pending >= 0 || canSend)

  // Falta item: avanca para ele. Tudo respondido: envia.
  const advance = () => {
    if (pending >= 0) goTo(pending)
    else if (canSend) void submit()
  }

  // Ctrl+Enter (ou Cmd+Enter) age de qualquer campo do cartao, com a mesma regra do botao.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey)) return
    e.preventDefault()
    if (canAct) advance()
  }

  const item = current

  return (
    <div className="box box-warn question-card" data-testid="question" onKeyDown={onKeyDown}>
      <h4>
        Pergunta para você
        <span className="q-who">{asker}</span>
        {question.items.length > 1 && (
          <span className="q-steps">
            {question.items.map((it, i) => (
              <button
                key={it.id}
                type="button"
                className={`q-step ${i === step ? 'cur' : ''}`}
                aria-label={`Pergunta ${i + 1}`}
                aria-current={i === step}
                onClick={() => goTo(i)}
              />
            ))}
            <span>
              {step + 1} de {question.items.length}
            </span>
          </span>
        )}
      </h4>
      {item && (
        <div key={item.id} className="q-item">
          <p className="q-prompt">{item.prompt}</p>
          <div className="answer">
            {item.options.map((o) => {
              const on = (picked[item.id] ?? []).includes(o.id)
              return (
                <button
                  key={o.id}
                  type="button"
                  disabled={busy}
                  aria-pressed={on}
                  onClick={() => toggle(item, o.id)}
                >
                  <span className={`q-mark ${item.multiSelect ? 'sq' : ''}`} aria-hidden="true" />
                  <span className="q-opt">
                    <span className="q-opt-t">
                      {optionTitle(o.label)}
                      {isSuggestedOption(o.label) && <span className="q-tag">sugerida</span>}
                    </span>
                    {o.description && <span className="q-opt-d">{o.description}</span>}
                  </span>
                </button>
              )
            })}
          </div>
          {(item.allowFreeText || item.options.length === 0) && (
            <label className="q-other">
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path
                  d="M3 13l.6-2.8L11 2.8a1.2 1.2 0 011.7 0l.5.5a1.2 1.2 0 010 1.7L5.8 12.4 3 13z"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinejoin="round"
                />
              </svg>
              <input
                className="field"
                placeholder="Outra: escreva a sua resposta"
                value={texts[item.id] ?? ''}
                onChange={(e) => setTexts((t) => ({ ...t, [item.id]: e.target.value }))}
              />
            </label>
          )}
        </div>
      )}
      <div className="answer">
        <button
          type="button"
          className="primary"
          disabled={!canAct}
          title="Ctrl+Enter"
          onClick={advance}
        >
          {pending >= 0 ? 'Próxima' : 'Enviar'} <kbd>Ctrl ↵</kbd>
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

/** Titulo da opcao sem o sufixo "(Recomendado)": a etiqueta "sugerida" ocupa o lugar dele. */
function optionTitle(label: string): string {
  return label.replace(/\s*\((recomendad|sugerid)[oa]\)\s*$/i, '')
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
