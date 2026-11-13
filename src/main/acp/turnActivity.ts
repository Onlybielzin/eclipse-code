/**
 * Converte os session/update de um turno em ActivityEventDraft.
 *
 * - Pedacos de texto (e de raciocinio) seguidos viram um evento so. O bloco fecha quando
 *   chega outro tipo de evento, muda o messageId, passa `textFlushMs` desde o primeiro
 *   pedaco do bloco ou o turno acaba.
 * - O evento emitido corta textos longos em MAX_ACTIVITY_TEXT_CHARS. A copia interna fica
 *   inteira, para o texto final (assembleFinalText) nunca sair cortado.
 */
import type { SessionUpdate, ToolCallContent } from '@agentclientprotocol/sdk'
import {
  MAX_ACTIVITY_TEXT_CHARS,
  TOOL_CALL_STATUSES,
  type ActivityEventDraft,
  type ActivityPayload,
  type JsonValue,
  type SessionId,
  type SubtaskId,
  type ToolCallStatus,
  type TurnId,
} from '@shared/domain'
import { assembleFinalText } from '@shared/subtaskRules'
import type { Clock } from '@shared/ports'

export interface TurnActivityContext {
  sessionId: SessionId
  subtaskId: SubtaskId
  turnId: TurnId
}

type TextKind = 'text' | 'thought'

interface ToolState {
  title: string
  toolKind: string | null
  status: ToolCallStatus
}

export function truncateText(text: string, max = MAX_ACTIVITY_TEXT_CHARS): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

export function toJsonValue(value: unknown): JsonValue | null {
  if (value === undefined) return null
  try {
    const json = JSON.stringify(value)
    if (json === undefined) return null
    if (json.length > MAX_ACTIVITY_TEXT_CHARS) return truncateText(json)
    return JSON.parse(json) as JsonValue
  } catch {
    return null
  }
}

function toolStatus(value: unknown): ToolCallStatus | null {
  return typeof value === 'string' && (TOOL_CALL_STATUSES as readonly string[]).includes(value)
    ? (value as ToolCallStatus)
    : null
}

function summarizeToolOutput(
  content: readonly ToolCallContent[] | null | undefined,
  rawOutput: unknown,
): string | null {
  const parts: string[] = []
  for (const item of content ?? []) {
    if (item.type === 'content') {
      if (item.content.type === 'text') parts.push(item.content.text)
      else parts.push(`[${item.content.type}]`)
    } else if (item.type === 'diff') {
      parts.push(`[diff] ${item.path}`)
    } else if (item.type === 'terminal') {
      parts.push(`[terminal] ${item.terminalId}`)
    }
  }
  if (parts.length === 0 && rawOutput !== undefined && rawOutput !== null) {
    parts.push(typeof rawOutput === 'string' ? rawOutput : (JSON.stringify(rawOutput) ?? ''))
  }
  const text = parts.join('\n').trim()
  return text ? truncateText(text) : null
}

export class TurnActivity {
  /** Copia inteira (sem corte) de tudo o que foi emitido, em ordem. */
  private readonly payloads: ActivityPayload[] = []
  private readonly tools = new Map<string, ToolState>()
  private buffer: { kind: TextKind; messageId: string | null; text: string } | null = null
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private closed = false

  constructor(
    private readonly context: TurnActivityContext,
    private readonly clock: Clock,
    private readonly emit: (draft: ActivityEventDraft) => void,
    private readonly textFlushMs: number,
  ) {}

  /** Evento fora dos session/update (prompt, erro, fim de turno). */
  record(payload: ActivityPayload): void {
    if (this.closed) return
    this.flush()
    this.push(payload)
  }

  update(update: SessionUpdate): void {
    if (this.closed) return
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
      case 'agent_thought_chunk': {
        if (update.content.type !== 'text') return
        const kind: TextKind = update.sessionUpdate === 'agent_message_chunk' ? 'text' : 'thought'
        this.appendText(kind, update.messageId ?? null, update.content.text)
        return
      }
      case 'tool_call': {
        this.flush()
        const state: ToolState = {
          title: update.title,
          toolKind: update.kind ?? null,
          status: toolStatus(update.status) ?? 'pending',
        }
        this.tools.set(update.toolCallId, state)
        this.push({
          kind: 'tool_call',
          toolCallId: update.toolCallId,
          title: state.title,
          toolKind: state.toolKind,
          status: state.status,
          input: toJsonValue(update.rawInput),
        })
        if (state.status === 'completed' || state.status === 'failed') {
          this.push({
            kind: 'tool_result',
            toolCallId: update.toolCallId,
            status: state.status,
            output: summarizeToolOutput(update.content, update.rawOutput),
          })
        }
        return
      }
      case 'tool_call_update': {
        this.flush()
        const previous = this.tools.get(update.toolCallId)
        const status = toolStatus(update.status) ?? previous?.status ?? 'in_progress'
        const next: ToolState = {
          title: update.title ?? previous?.title ?? update.toolCallId,
          toolKind: update.kind ?? previous?.toolKind ?? null,
          status,
        }
        this.tools.set(update.toolCallId, next)
        if (status === 'completed' || status === 'failed') {
          if (previous?.status === 'completed' || previous?.status === 'failed') return
          this.push({
            kind: 'tool_result',
            toolCallId: update.toolCallId,
            status,
            output: summarizeToolOutput(update.content, update.rawOutput),
          })
          return
        }
        if (!previous || previous.status !== next.status || previous.title !== next.title) {
          this.push({
            kind: 'tool_call',
            toolCallId: update.toolCallId,
            title: next.title,
            toolKind: next.toolKind,
            status: next.status,
            input: toJsonValue(update.rawInput),
          })
        }
        return
      }
      default:
        // plan, comandos, modo, uso, etc.: contam como sinal de vida, sem evento.
        return
    }
  }

  /** Fecha o bloco de texto aberto, se houver. */
  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    const buffer = this.buffer
    this.buffer = null
    if (!buffer || buffer.text.length === 0) return
    this.push({ kind: buffer.kind, text: buffer.text })
  }

  finalText(): string {
    this.flush()
    return assembleFinalText(this.payloads)
  }

  /** Grava o turn_end e para de aceitar eventos. */
  close(end: Extract<ActivityPayload, { kind: 'turn_end' }>): void {
    if (this.closed) return
    this.flush()
    this.push(end)
    this.closed = true
  }

  private appendText(kind: TextKind, messageId: string | null, text: string): void {
    if (!text) return
    if (this.buffer && (this.buffer.kind !== kind || this.buffer.messageId !== messageId))
      this.flush()
    if (!this.buffer) this.buffer = { kind, messageId, text: '' }
    this.buffer.text += text
    // Prazo contado do primeiro pedaco do bloco (nao rearma): um texto que nunca para
    // de chegar ainda aparece na tela a cada textFlushMs.
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), this.textFlushMs)
      this.flushTimer.unref?.()
    }
  }

  private push(payload: ActivityPayload): void {
    this.payloads.push(payload)
    this.emit({
      sessionId: this.context.sessionId,
      subtaskId: this.context.subtaskId,
      turnId: this.context.turnId,
      at: this.clock.now(),
      payload: truncatePayload(payload),
    })
  }
}

function truncatePayload(payload: ActivityPayload): ActivityPayload {
  switch (payload.kind) {
    case 'prompt':
    case 'text':
    case 'thought':
      return payload.text.length > MAX_ACTIVITY_TEXT_CHARS
        ? { ...payload, text: truncateText(payload.text) }
        : payload
    case 'error':
      return { ...payload, message: truncateText(payload.message) }
    default:
      return payload
  }
}
