import type { UserQuestion } from '@shared/domain'
import type { IpcEventMessage } from '@shared/ipc'
import type { AppLogger } from '../app/teamCoordinator'
import type { RemoteSettings } from './remoteSettings'

const MAX_TEXT = 300
const TIMEOUT_MS = 10_000
export interface NtfyDeps {
  getSettings: () => RemoteSettings
  /** null = nunca manda (teste e smoke). */
  fetch: typeof fetch | null
  lookup: (taskId: string) => { taskName: string; projectName: string }
  log: AppLogger
}

export interface Ntfy {
  /** Olha um evento do fluxo de UI e avisa o celular se couber. Nunca rejeita. */
  handle(message: IpcEventMessage): Promise<void>
  /** Aviso de teste (ignora ntfyEnabled). Rejeita com mensagem legivel. */
  test(): Promise<void>
}

const cut = (text: string) => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text)

export function createNtfy(deps: NtfyDeps): Ntfy {
  // shortcut: ids avisados so em memoria; no reinicio uma pergunta aberta avisa de novo. Persistir se incomodar.
  const notified = new Set<string>()

  async function post(title: string, message: string, priority: 3 | 4, tags: string[]) {
    if (!deps.fetch) throw new Error('O aviso por ntfy não funciona neste modo.')
    const s = deps.getSettings()
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (s.ntfyToken) headers['Authorization'] = `Bearer ${s.ntfyToken}`
    const body: Record<string, unknown> = {
      topic: s.ntfyTopic,
      title,
      message: cut(message),
      priority,
      tags,
    }
    if (s.publicUrl) body['click'] = `${s.publicUrl.replace(/\/+$/, '')}/`
    let res: Response
    try {
      res = await deps.fetch(s.ntfyServer.replace(/\/+$/, ''), {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch {
      throw new Error('Não consegui falar com o servidor ntfy. Confira o endereço e a rede.')
    }
    if (!res.ok) throw new Error(`O servidor ntfy recusou o aviso (HTTP ${res.status}).`)
  }

  return {
    async handle(message) {
      if (!deps.fetch || !deps.getSettings().ntfyEnabled) return
      try {
        if (message.channel === 'notice.created') {
          const n = message.payload as { projectName: string; taskName: string; text: string }
          await post(`${n.projectName}: ${n.taskName}`, n.text, 3, ['bell'])
        } else if (message.channel === 'domain.event') {
          const e = (message.payload as { event: { type: string; question?: unknown } }).event
          if (e.type !== 'question.upserted') return
          const q = e.question as UserQuestion
          if (q.status !== 'open' || notified.has(q.id)) return
          notified.add(q.id)
          const names = deps.lookup(q.taskId)
          await post(
            `${names.projectName}: ${names.taskName}`,
            q.items.map((i) => i.prompt).join('\n'),
            4,
            ['speech_balloon'],
          )
        }
      } catch (e) {
        deps.log.warn('aviso por ntfy falhou', {
          error: e instanceof Error ? e.message : String(e),
        })
      }
    },
    test: () =>
      post('Eclipse Code', 'Aviso de teste. Se você leu isto, o ntfy funciona.', 3, [
        'white_check_mark',
      ]),
  }
}
