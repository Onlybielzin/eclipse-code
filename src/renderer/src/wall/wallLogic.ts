/** Lógica pura da Parede: compara retratos, calcula ritmo, marco de 100 e ordem dos cartões. */
import type { WallSnapshot, WallTask } from '@shared/wall'

export const MAX_CARDS = 10
export const MAX_LOG = 50
const WINDOW_MS = 60_000
/** Linhas por minuto que acendem a barra de calor por inteiro. */
const HEAT_FULL_LPM = 130

export interface LogEntry {
  id: number
  at: number
  project: string
  task: string
  text: string
  kind: 'lines' | 'done' | 'ask' | 'new'
}

export interface Session {
  last: WallSnapshot | null
  /** Ganhos de linhas dentro da janela de 60 s. */
  gains: { at: number; n: number }[]
  rate: { lpm: number; buckets: number[] }
  /** Ultimo ganho; seq novo reinicia a animacao do "+N". */
  gain: { n: number; seq: number } | null
  milestone: { value: number; seq: number } | null
  /** Quantas vezes uma subtarefa ficou pronta, por tarefa; muda = flash. */
  flash: Record<string, number>
  log: LogEntry[]
  seq: number
}

export const totalLines = (s: WallSnapshot): number =>
  s.tasks.reduce((n, t) => n + t.linesAdded, 0)

export const heatOf = (lpm: number): number => Math.min(1, lpm / HEAT_FULL_LPM)

/** Maior multiplo de 100 que `next` alcancou e `prev` ainda nao. */
export function crossedMilestone(prev: number, next: number): number | null {
  const hit = Math.floor(next / 100) * 100
  return next > prev && hit > prev && hit > 0 ? hit : null
}

export function rateWindow(gains: { at: number; n: number }[], now: number) {
  const buckets = new Array<number>(60).fill(0)
  let lpm = 0
  for (const g of gains) {
    const age = now - g.at
    if (age < 0 || age >= WINDOW_MS) continue
    lpm += g.n
    buckets[59 - Math.floor(age / 1000)]! += g.n
  }
  return { lpm, buckets }
}

const isWorking = (t: WallTask) => t.members.some((m) => m.state === 'working')

/** Com agente trabalhando, depois com pergunta, depois atualizadas por ultimo. */
export function sortCards(tasks: WallTask[]): WallTask[] {
  const rank = (t: WallTask) => (isWorking(t) ? 0 : t.openQuestions > 0 ? 1 : 2)
  return [...tasks].sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt).slice(0, MAX_CARDS)
}

/** Tarefas que o limite de cartoes deixa fora da grade. */
export const hiddenCards = (total: number): number => Math.max(0, total - MAX_CARDS)

export const newSession = (): Session => ({
  last: null, gains: [], rate: { lpm: 0, buckets: new Array<number>(60).fill(0) },
  gain: null, milestone: null, flash: {}, log: [], seq: 0,
})

export function advanceSession(s: Session, next: WallSnapshot, now: number): Session {
  const prev = s.last
  const gains = s.gains.filter((g) => now - g.at < WINDOW_MS)
  if (!prev) return { ...s, last: next, gains, rate: rateWindow(gains, now) }

  let seq = s.seq
  const entries: Omit<LogEntry, 'id'>[] = []
  const flash = { ...s.flash }
  const before = new Map(prev.tasks.map((t) => [t.id, t]))
  const log = (t: WallTask, text: string, kind: LogEntry['kind']) =>
    entries.push({ at: now, project: t.projectName, task: t.title, text, kind })

  for (const t of next.tasks) {
    const old = before.get(t.id)
    if (!old) {
      log(t, 'tarefa nova', 'new')
      continue
    }
    const grew = t.linesAdded - old.linesAdded
    if (grew > 0) log(t, `+${grew} linhas`, 'lines')
    const wasDone = new Set(old.members.filter((m) => m.state === 'completed').map((m) => m.subtaskId))
    for (const m of t.members) {
      if (m.state !== 'completed' || wasDone.has(m.subtaskId)) continue
      log(t, `${m.role} ficou pronto`, 'done')
      flash[t.id] = (flash[t.id] ?? 0) + 1
    }
    if (t.openQuestions > old.openQuestions) log(t, 'pergunta para você', 'ask')
  }

  const total = totalLines(next)
  const diff = total - totalLines(prev)
  if (diff > 0) gains.push({ at: now, n: diff })
  const mark = crossedMilestone(totalLines(prev), total)
  if (mark !== null) entries.push({ at: now, project: 'todos os projetos', task: 'Parede', text: `marco: ${mark} linhas`, kind: 'lines' })

  // Entra por cima: a ultima entrada gerada fica no topo.
  const logged = entries.map((e) => ({ ...e, id: ++seq }))
  return {
    last: next,
    gains,
    rate: rateWindow(gains, now),
    gain: diff > 0 ? { n: diff, seq: ++seq } : null,
    milestone: mark !== null ? { value: mark, seq: ++seq } : s.milestone,
    flash,
    log: [...logged.reverse(), ...s.log].slice(0, MAX_LOG),
    seq,
  }
}
