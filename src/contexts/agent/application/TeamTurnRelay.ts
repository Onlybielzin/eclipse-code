/**
 * Team relay, owned by the Worker: when a team member (an agent another agent started) ends a
 * turn, its reply goes to the agent that started it (the lead). The Worker sees turn ends of every
 * provider, so Claude and Codex members are relayed the same way.
 */

const MAX_REPLY_CHARS = 6000
const READ_ATTEMPTS = 5
const DELIVERY_ATTEMPTS = 10
const RETRY_DELAY_MS = 3000

export interface TeamTurnEvent {
  nodeId: string | null
  turnId: string
  outcome: string
}

export interface TeamTurnRelayPorts {
  subscribe: (listener: (event: TeamTurnEvent) => void) => () => void
  /** The member's lead and window title; null for an agent the user started. */
  readMember: (nodeId: string) => Promise<{ parentNodeId: string; title: string } | null>
  readFinalMessage: (nodeId: string, turnId: string) => Promise<string | null>
  deliver: (parentNodeId: string, text: string) => Promise<void>
  sleep: (ms: number) => Promise<void>
}

const OUTCOME_LABEL: Record<string, string> = {
  failed: ' com falha',
  aborted: ' interrompido',
}

export function composeTeamTurnMessage(input: {
  title: string
  nodeId: string
  outcome: string
  reply: string | null
}): string {
  const reply = input.reply?.trim() ?? ''
  const statusLine = reply
    .split('\n')
    .reverse()
    .find(line => line.toUpperCase().includes('STATUS:'))
  const status = statusLine
    ? statusLine.slice(statusLine.toUpperCase().indexOf('STATUS:')).trim()
    : 'sem linha STATUS'
  const body = !reply
    ? '(O app não guardou o texto desta resposta. Leia a tela dele com agente_ler e tela=true.)'
    : reply.length > MAX_REPLY_CHARS
      ? `${reply.slice(0, MAX_REPLY_CHARS)}\n…(cortado; leia o resto com agente_ler)\n${status}`
      : reply
  return [
    `[time] ${input.title} (id ${input.nodeId}) terminou o turno${OUTCOME_LABEL[input.outcome] ?? ''}. ${status}`,
    '',
    body,
    '',
    '[time] Primeiro atualize a subtarefa deste membro no quadro (TaskUpdate: status e nota no título). Depois: se for DUVIDA e você souber, responda com agente_mensagem para esse id; se for decisão do vings, pergunte a ele com pergunta_criar e repasse; se for PRONTO, siga a esteira.',
  ].join('\n')
}

function isBusy(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code
  return code === 'agent.busy' || code === 'agent.delivery_unsettled'
}

export function startTeamTurnRelay(ports: TeamTurnRelayPorts): () => void {
  const seen = new Set<string>()

  const relay = async (event: TeamTurnEvent & { nodeId: string }) => {
    const member = await ports.readMember(event.nodeId)
    if (!member) {
      return
    }
    let reply: string | null = null
    /* eslint-disable no-await-in-loop -- The archive can lag the turn-end event; retry in order. */
    for (let attempt = 0; attempt < READ_ATTEMPTS && reply === null; attempt++) {
      reply = await ports.readFinalMessage(event.nodeId, event.turnId).catch(() => null)
      if (reply === null && attempt < READ_ATTEMPTS - 1) {
        await ports.sleep(1000)
      }
    }
    const text = composeTeamTurnMessage({
      title: member.title,
      nodeId: event.nodeId,
      outcome: event.outcome,
      reply,
    })
    for (let attempt = 0; attempt < DELIVERY_ATTEMPTS; attempt++) {
      try {
        await ports.deliver(member.parentNodeId, text)
        return
      } catch (error) {
        if (!isBusy(error)) {
          return
        }
        await ports.sleep(RETRY_DELAY_MS)
      }
    }
    /* eslint-enable no-await-in-loop */
  }

  return ports.subscribe(event => {
    if (!event.nodeId) {
      return
    }
    const key = `${event.nodeId}:${event.turnId}`
    if (seen.has(key)) {
      return
    }
    seen.add(key)
    if (seen.size > 2000) {
      seen.delete(seen.values().next().value as string)
    }
    void relay({ ...event, nodeId: event.nodeId }).catch(() => undefined)
  })
}
