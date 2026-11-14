import { describe, expect, it } from 'vitest'
import type { WallSnapshot, WallTask } from '@shared/wall'
import {
  advanceSession,
  crossedMilestone,
  heatOf,
  hiddenCards,
  newSession,
  rateWindow,
  sortCards,
  totalLines,
} from './wallLogic'

const task = (id: string, extra: Partial<WallTask> = {}): WallTask => ({
  id, projectId: 'p', projectName: 'proj', title: `Tarefa ${id}`, workflowStatus: 'em_andamento',
  branch: id, updatedAt: 1, members: [], linesAdded: 0, linesRemoved: 0, lastFile: null,
  lastLines: [], openQuestions: 0, ...extra,
})
const snap = (tasks: WallTask[], at = 1000): WallSnapshot => ({
  at, tasks, workingAgents: 0, maxLiveAgents: null, doneToday: 0, inReview: 0, openQuestions: 0,
})
const member = (state: 'working' | 'completed') =>
  ({ subtaskId: 's1', role: 'Dev', title: 'x', state }) as const

describe('marco de 100', () => {
  it('devolve o maior múltiplo de 100 cruzado, ou null', () => {
    expect(crossedMilestone(95, 101)).toBe(100)
    expect(crossedMilestone(99, 305)).toBe(300)
    expect(crossedMilestone(100, 150)).toBeNull()
    expect(crossedMilestone(150, 90)).toBeNull()
  })
})

describe('linhas por minuto', () => {
  it('soma os ganhos dos últimos 60 s e monta 60 baldes', () => {
    const gains = [{ at: 1_000, n: 99 }, { at: 70_000, n: 10 }, { at: 100_000, n: 5 }]
    const r = rateWindow(gains, 101_000)
    expect(r.lpm).toBe(15)
    expect(r.buckets).toHaveLength(60)
    expect(r.buckets[58]).toBe(5)
    expect(r.buckets.reduce((a, b) => a + b, 0)).toBe(15)
  })
  it('heat vai de 0 a 1', () => {
    expect(heatOf(0)).toBe(0)
    expect(heatOf(65)).toBeCloseTo(0.5)
    expect(heatOf(900)).toBe(1)
  })
})

describe('sortCards', () => {
  it('prioriza quem trabalha, depois pergunta, depois o mais novo; corta em 10', () => {
    const tasks = [
      task('velha', { updatedAt: 1 }),
      task('nova', { updatedAt: 9 }),
      task('pergunta', { openQuestions: 1, updatedAt: 2 }),
      task('trabalha', { members: [member('working')], updatedAt: 0 }),
    ]
    expect(sortCards(tasks).map((t) => t.id)).toEqual(['trabalha', 'pergunta', 'nova', 'velha'])
    const many = Array.from({ length: 14 }, (_, i) => task(`t${i}`))
    expect(sortCards(many)).toHaveLength(10)
  })
})

describe('advanceSession', () => {
  it('o primeiro retrato só fixa a base: sem log, sem marco, sem ganho', () => {
    const s = advanceSession(newSession(), snap([task('a', { linesAdded: 250 })]), 1000)
    expect(totalLines(s.last!)).toBe(250)
    expect(s.log).toEqual([])
    expect(s.milestone).toBeNull()
    expect(s.gain).toBeNull()
  })

  it('gera ganho, marco, log e flash a partir da diferença entre retratos', () => {
    let s = advanceSession(newSession(), snap([task('a', { linesAdded: 95, members: [member('working')] })]), 1000)
    s = advanceSession(
      s,
      snap([task('a', { linesAdded: 120, members: [member('completed')], openQuestions: 1 }), task('b')], 4000),
      4000,
    )
    expect(s.gain?.n).toBe(25)
    expect(s.milestone?.value).toBe(100)
    expect(s.flash['a']).toBe(1)
    const texts = s.log.map((l) => l.text)
    expect(texts).toEqual(expect.arrayContaining(['+25 linhas', 'Dev ficou pronto', 'pergunta para você', 'tarefa nova']))
    expect(s.rate.lpm).toBe(25)
  })

  it('linhas que diminuem não geram ganho e o log guarda no máximo 50', () => {
    let s = advanceSession(newSession(), snap([task('a', { linesAdded: 50 })]), 0)
    s = advanceSession(s, snap([task('a', { linesAdded: 40 })]), 3000)
    expect(s.gain).toBeNull()
    for (let i = 1; i <= 80; i++) {
      s = advanceSession(s, snap([task('a', { linesAdded: 40 + i })], i * 3000), i * 3000)
    }
    expect(s.log).toHaveLength(50)
    expect(s.log[0]!.text).toBe('+1 linhas')
  })
})

describe('hiddenCards', () => {
  it('conta o que passa do limite de 10 cartões', () => {
    expect(hiddenCards(10)).toBe(0)
    expect(hiddenCards(13)).toBe(3)
  })
})
