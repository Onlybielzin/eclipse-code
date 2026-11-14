/**
 * Regras puras que transformam o fim de um turno em estado de subtarefa.
 * Usadas pelo TaskService (main). Sem I/O, para serem testadas sozinhas.
 */
import type {
  ActivityPayload,
  Delivery,
  DeliveryState,
  StopReason,
  SubtaskFailureCode,
  SubtaskState,
  TurnErrorCode,
  TurnResult,
} from './domain'

export const MAX_FALLBACK_SUMMARY_CHARS = 6_000

/** Estado que a linha "STATUS:" de um texto livre indica. null se nao ha linha reconhecivel. */
export function parseStatusLine(text: string): DeliveryState | null {
  const lines = text.split(/\r?\n/).reverse()
  for (const line of lines) {
    const index = line.toUpperCase().indexOf('STATUS:')
    if (index < 0) continue
    const value = line
      .slice(index + 'STATUS:'.length)
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[*_`]/g, '')
      .trim()
      .toUpperCase()
    const word = value.split(/[\s.,;:!-]+/)[0] ?? ''
    if (['PRONTO', 'DONE', 'COMPLETED', 'COMPLETO', 'CONCLUIDO'].includes(word)) return 'completed'
    if (['DUVIDA', 'PERGUNTA', 'QUESTION', 'INPUT_REQUIRED'].includes(word)) return 'input_required'
    if (['BLOQUEADO', 'BLOCKED', 'FAILED', 'FALHOU'].includes(word)) return 'failed'
    return null
  }
  return null
}

/**
 * Texto final do turno, como o Paperclip faz: o texto escrito depois da ultima
 * ferramenta. Se nao houver texto depois dela, o ultimo bloco de texto do turno.
 * Nao confia em campo de "ultima mensagem" do provedor.
 */
export function assembleFinalText(payloads: readonly ActivityPayload[]): string {
  let lastToolIndex = -1
  payloads.forEach((p, i) => {
    if (p.kind === 'tool_call' || p.kind === 'tool_result') lastToolIndex = i
  })
  const after = payloads
    .slice(lastToolIndex + 1)
    .flatMap((p) => (p.kind === 'text' ? [p.text] : []))
    .join('')
    .trim()
  if (after) return after
  for (let i = payloads.length - 1; i >= 0; i--) {
    const p = payloads[i]
    if (p?.kind === 'text' && p.text.trim()) return p.text.trim()
  }
  return ''
}

const ERROR_TO_FAILURE: Record<TurnErrorCode, SubtaskFailureCode> = {
  process_exited: 'process_exited',
  silent_timeout: 'silent_timeout',
  turn_timeout: 'turn_timeout',
  session_closed: 'error',
  spawn_failed: 'spawn_failed',
  protocol_error: 'error',
  app_restarted: 'session_lost',
}

/**
 * statusMessage da subtarefa que o app reiniciou no meio: fica em input_required esperando o
 * Lider responder (o app reabre o membro) ou cancelar.
 */
export const RESTART_PAUSE_MESSAGE = 'parada: o app reiniciou'

/** A subtarefa parou porque o app reiniciou (e nao por uma duvida do membro). */
export function isPausedByRestart(subtask: {
  state: string
  statusMessage: string | null
}): boolean {
  return subtask.state === 'input_required' && subtask.statusMessage === RESTART_PAUSE_MESSAGE
}

const FAILURE_MESSAGES: Record<SubtaskFailureCode, string> = {
  member_blocked: 'bloqueado pelo membro',
  process_exited: 'bloqueado: processo morreu',
  silent_timeout: 'bloqueado: sem resposta',
  turn_timeout: 'bloqueado: tempo máximo do turno',
  session_lost: 'bloqueado: sessão perdida',
  spawn_failed: 'bloqueado: membro não abriu',
  refusal: 'bloqueado: o modelo recusou',
  limit_reached: 'bloqueado: limite do turno atingido',
  error: 'bloqueado: erro',
}

export function failureMessage(code: SubtaskFailureCode): string {
  return FAILURE_MESSAGES[code]
}

const STOP_TO_FAILURE: Partial<Record<StopReason, SubtaskFailureCode>> = {
  max_tokens: 'limit_reached',
  max_turn_requests: 'limit_reached',
  refusal: 'refusal',
}

/** O que fazer com a subtarefa depois de um turno. */
export interface SubtaskTurnResolution {
  state: Exclude<SubtaskState, 'submitted' | 'working'>
  statusMessage: string
  failureCode: SubtaskFailureCode | null
  /**
   * Entrega "sem formato" a gravar quando o membro nao chamou entregar.
   * null quando ja ha entrega estruturada ou quando o turno foi cancelado.
   */
  fallbackDelivery: Delivery | null
}

function firstLine(text: string): string {
  const line = text.trim().split(/\r?\n/)[0] ?? ''
  return line.length > 200 ? `${line.slice(0, 199)}…` : line
}

function fallback(state: DeliveryState, finalText: string): Delivery {
  const summary =
    finalText.length > MAX_FALLBACK_SUMMARY_CHARS
      ? `${finalText.slice(0, MAX_FALLBACK_SUMMARY_CHARS)}\n…(cortado)`
      : finalText
  return { state, summary, files: [], tests: [], questions: [] }
}

/**
 * Decide o estado da subtarefa a partir do fim do turno.
 *
 * Ordem:
 *  1. Entrega estruturada (a ultima do turno) vence, mesmo com erro depois dela:
 *     o 'entregar' ja foi gravado e e a palavra explicita do membro.
 *  2. Erro de turno -> failed com o codigo do erro.
 *  3. stopReason 'cancelled' -> canceled (o vigia de silencio NAO usa isto; ele
 *     reporta erro 'silent_timeout').
 *  4. refusal, max_tokens, max_turn_requests -> failed.
 *  5. end_turn -> linha STATUS: do texto final. Sem STATUS reconhecivel vira
 *     'input_required' (nao final), para o Lider decidir sem perder a subtarefa.
 */
export function resolveTurn(result: TurnResult): SubtaskTurnResolution {
  const structured = result.deliveries.at(-1)
  if (structured) {
    const d = structured.delivery
    const failureCode: SubtaskFailureCode | null = d.state === 'failed' ? 'member_blocked' : null
    const errorNote =
      result.outcome.kind === 'error'
        ? ` (turno terminou com erro: ${result.outcome.error.code})`
        : ''
    return {
      state: d.state,
      statusMessage: `${firstLine(d.summary) || 'entrega sem resumo'}${errorNote}`,
      failureCode,
      fallbackDelivery: null,
    }
  }

  if (result.outcome.kind === 'error') {
    const code = ERROR_TO_FAILURE[result.outcome.error.code]
    return {
      state: 'failed',
      statusMessage: failureMessage(code),
      failureCode: code,
      fallbackDelivery: result.finalText ? fallback('failed', result.finalText) : null,
    }
  }

  const stopReason = result.outcome.stopReason
  if (stopReason === 'cancelled') {
    return {
      state: 'canceled',
      statusMessage: 'cancelada',
      failureCode: null,
      fallbackDelivery: null,
    }
  }

  const stopFailure = STOP_TO_FAILURE[stopReason]
  if (stopFailure) {
    return {
      state: 'failed',
      statusMessage: failureMessage(stopFailure),
      failureCode: stopFailure,
      fallbackDelivery: fallback('failed', result.finalText),
    }
  }

  const parsed = parseStatusLine(result.finalText)
  if (parsed === null) {
    return {
      state: 'input_required',
      statusMessage: 'terminou sem entregar e sem linha STATUS',
      failureCode: null,
      fallbackDelivery: fallback('input_required', result.finalText),
    }
  }
  return {
    state: parsed,
    statusMessage: `sem formato: ${firstLine(result.finalText) || parsed}`,
    failureCode: parsed === 'failed' ? 'member_blocked' : null,
    fallbackDelivery: fallback(parsed, result.finalText),
  }
}
