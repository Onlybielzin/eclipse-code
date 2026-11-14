/**
 * Variations of the neurons (the "bolinhas"): continuous motion, colour/size
 * styles and twinkle. The engine applies them; the page only picks.
 */
import type { V3 } from './shape'

/** Continuous motion on top of the shape (A30 prototype modes 1-4). */
export type Motion = 'parado' | 'respiracao' | 'flutuacao' | 'onda' | 'batimento'
export const MOTIONS: { id: Motion; label: string; hint: string }[] = [
  { id: 'parado', label: 'Parado', hint: 'Só gira devagar' },
  { id: 'respiracao', label: 'Respiração', hint: 'Expande e contrai a cada 6 s' },
  { id: 'flutuacao', label: 'Flutuação', hint: 'Cada bolinha boia no lugar' },
  { id: 'onda', label: 'Onda', hint: 'Uma ondulação atravessa' },
  { id: 'batimento', label: 'Batimento', hint: 'Pulsa a cada consulta' },
]
export const isMotion = (v: unknown): v is Motion => MOTIONS.some((m) => m.id === v)

/** What colour and size of each neuron mean. */
export type Style = 'tipo' | 'projeto' | 'idade' | 'importancia'
export const STYLES: { id: Style; label: string; hint: string }[] = [
  { id: 'tipo', label: 'Tipo', hint: 'Memória azul, entidade violeta' },
  { id: 'projeto', label: 'Projeto', hint: 'Uma cor por projeto' },
  { id: 'idade', label: 'Idade', hint: 'Novas maiores e verde-água' },
  { id: 'importancia', label: 'Importância', hint: 'Importantes maiores e douradas' },
]
export const isStyle = (v: unknown): v is Style => STYLES.some((s) => s.id === v)

/** Offset of one point for the current motion. t in seconds, beat = seconds since the last query. */
export function motionScale(motion: Motion, t: number, beat: number): number {
  if (motion === 'respiracao') return 1 + 0.08 * Math.sin((t * 2 * Math.PI) / 6)
  if (motion === 'batimento' && beat >= 0)
    return 1 - 0.09 * Math.sin(beat * 13) * Math.exp(-beat * 3.5)
  return 1
}

/** HSL (0..1) to linear-ish RGB (0..1), enough for point colours. */
export function hsl(h: number, s: number, l: number): V3 {
  const f = (n: number) => {
    const k = (n + h * 12) % 12
    const a = s * Math.min(l, 1 - l)
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))
  }
  return [f(0), f(8), f(4)]
}

/** Piecewise-linear gradient over evenly spaced stops. */
export function ramp(stops: V3[], t: number): V3 {
  const x = Math.max(0, Math.min(1, t)) * (stops.length - 1)
  const k = Math.min(stops.length - 2, Math.floor(x))
  const f = x - k
  const a = stops[k]
  const b = stops[k + 1]
  return [a![0] + (b![0] - a![0]) * f, a![1] + (b![1] - a![1]) * f, a![2] + (b![2] - a![2]) * f]
}

/** Stable 0..1 number from a string (same memory -> same jitter). */
export function hash01(id: string): number {
  let h = 2166136261
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619)
  return ((h >>> 0) % 100000) / 100000
}
