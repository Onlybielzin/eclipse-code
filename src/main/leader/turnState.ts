/**
 * Estado do turno do Lider (trabalhando/ocioso) a partir dos registros que o provedor
 * grava. Origem: agent/infrastructure/watchers/SessionTurnStateDetector.ts do app
 * antigo, so Claude e Codex.
 */
import type { Provider } from '@shared/domain'

export type LeaderTurnSignal = 'working' | 'idle'

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function hasContentBlockType(message: Record<string, unknown>, blockTypes: string[]): boolean {
  if (!Array.isArray(message['content'])) return false
  return message['content'].some(
    (block) =>
      isRecord(block) && typeof block['type'] === 'string' && blockTypes.includes(block['type']),
  )
}

function detectClaudeTranscriptState(parsed: unknown): LeaderTurnSignal | null {
  if (!isRecord(parsed) || typeof parsed['type'] !== 'string') return null
  if (parsed['type'] === 'user') return 'working'
  if (parsed['type'] !== 'assistant') return null
  const message = parsed['message']
  if (!isRecord(message)) return null
  if (hasContentBlockType(message, ['tool_use'])) return 'working'
  const stopReason = message['stop_reason']
  if (stopReason === 'tool_use' || stopReason === 'pause_turn') return 'working'
  if (hasContentBlockType(message, ['thinking', 'redacted_thinking'])) return 'working'
  if (hasContentBlockType(message, ['text', 'output_text'])) return 'idle'
  if (stopReason === null) return 'working'
  if (typeof stopReason === 'string') return 'idle'
  return null
}

function codexAssistantPhase(
  payload: Record<string, unknown>,
  fallbackIdle: boolean,
): LeaderTurnSignal | null {
  if (payload['phase'] === 'commentary') return 'working'
  if (payload['phase'] === 'final_answer') return 'idle'
  return fallbackIdle ? 'idle' : null
}

// O indicador real do Codex vive na memoria da TUI (task_running). No arquivo, task_started
// e task_complete sao os donos; commentary segue trabalhando ate final_answer.
function detectCodexTranscriptState(parsed: unknown): LeaderTurnSignal | null {
  if (!isRecord(parsed) || typeof parsed['type'] !== 'string') return null
  const payload = parsed['payload']
  if (!isRecord(payload) || typeof payload['type'] !== 'string') return null
  if (parsed['type'] === 'event_msg') {
    switch (payload['type']) {
      case 'task_started':
      case 'agent_reasoning':
        return 'working'
      case 'task_complete':
      case 'turn_aborted':
        return 'idle'
      case 'agent_message':
        return codexAssistantPhase(payload, false)
      default:
        return null
    }
  }
  if (parsed['type'] === 'response_item') {
    if (payload['type'] === 'message') {
      return payload['role'] === 'assistant' ? codexAssistantPhase(payload, true) : null
    }
    if (['reasoning', 'function_call', 'function_call_output'].includes(payload['type']))
      return 'working'
  }
  return null
}

export function detectTranscriptTurnState(
  provider: Provider,
  parsed: unknown,
): LeaderTurnSignal | null {
  return provider === 'claude'
    ? detectClaudeTranscriptState(parsed)
    : detectCodexTranscriptState(parsed)
}

/** Evento de gancho do Claude gravado pelo script de ganchos (ver claudeHooks.ts). */
export interface ClaudeHookRecord {
  event: string
  sessionId: string | null
  notificationType: string | null
  source: string | null
  transcriptPath: string | null
  at: number
}

export function parseClaudeHookRecord(value: unknown): ClaudeHookRecord | null {
  if (!isRecord(value) || typeof value['event'] !== 'string') return null
  const str = (key: string): string | null => {
    const raw = value[key]
    return typeof raw === 'string' && raw.length > 0 ? raw : null
  }
  return {
    event: value['event'],
    sessionId: str('sessionId'),
    notificationType: str('notificationType'),
    source: str('source'),
    transcriptPath: str('transcriptPath'),
    at: typeof value['at'] === 'number' ? value['at'] : 0,
  }
}

/** Estado que cada gancho do Claude indica. null: o gancho nao muda o estado. */
export function stateFromClaudeHook(record: ClaudeHookRecord): LeaderTurnSignal | null {
  switch (record.event) {
    case 'SessionStart':
    case 'Stop':
    case 'StopFailure':
      return 'idle'
    case 'UserPromptSubmit':
    case 'PreToolUse':
    case 'PostToolUse':
    case 'PostToolUseFailure':
      return 'working'
    case 'Notification':
      // idle_prompt: o Claude esta esperando o usuario faz tempo. permission_prompt nao e ocioso.
      return record.notificationType === 'idle_prompt' ? 'idle' : null
    default:
      return null
  }
}
