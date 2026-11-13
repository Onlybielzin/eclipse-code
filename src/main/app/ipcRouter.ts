import {
  parseIpcInvokeRequest,
  type IpcCommandChannel,
  type IpcCommandHandlers,
  type IpcResult,
} from '@shared/ipc'
import { DomainError, toDomainErrorPayload } from '@shared/domain'

/**
 * Valida e despacha um pedido IPC cru. Nunca lanca: erro vira IpcResult ok:false.
 * Handlers ausentes respondem 'unavailable' (modulo ainda nao ligado).
 */
export function createIpcRouter(handlers: Partial<IpcCommandHandlers>) {
  return async function route(raw: unknown): Promise<IpcResult<unknown>> {
    const parsed = parseIpcInvokeRequest(raw)
    if (!parsed.ok) return parsed
    const handler = handlers[parsed.channel] as ((input: unknown) => Promise<unknown>) | undefined
    if (!handler) {
      return {
        ok: false,
        error: toDomainErrorPayload(
          new DomainError('unavailable', `comando ainda não implementado: ${parsed.channel}`),
        ),
      }
    }
    try {
      return { ok: true, value: await handler(parsed.input) }
    } catch (error) {
      return { ok: false, error: toDomainErrorPayload(error) }
    }
  }
}

export type IpcRoute = ReturnType<typeof createIpcRouter>
export type { IpcCommandChannel }
