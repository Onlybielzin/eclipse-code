/**
 * Abstract neural-cloud layout, deterministic (same input → same positions).
 *
 *   - Each project is a cluster near the outer shell (a "region").
 *   - Global memories form a loose cortex spread over the whole volume.
 *   - Entities are hubs in the inner core, so their links read as fibres
 *     running inward.
 */
export const R = 100
export type V3 = [number, number, number]

/** Slightly flattened, elongated volume so it reads as organic, not a ball. */
const SHAPE: V3 = [1.0, 0.72, 1.18]

export function rng(seed: string) {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619)
  return () => {
    h += 0x6d2b79f5
    let t = h
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function randomDir(rand: () => number): V3 {
  const u = rand() * 2 - 1
  const t = rand() * Math.PI * 2
  const s = Math.sqrt(1 - u * u)
  return [s * Math.cos(t), u, s * Math.sin(t)]
}

const gauss = (rand: () => number) => {
  const u = Math.max(1e-9, rand())
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand())
}

const toWorld = (d: V3, k: number): V3 => [
  d[0] * SHAPE[0] * k * R,
  d[1] * SHAPE[1] * k * R,
  d[2] * SHAPE[2] * k * R,
]

/** Anchor of a project region: on the shell, direction from the name. */
export function regionAnchor(name: string): V3 {
  return toWorld(randomDir(rng(`region:${name}`)), 0.82)
}

export function regionMember(id: string, anchor: V3, count: number): V3 {
  const r = rng(id)
  const s = (5 + 2.6 * Math.cbrt(count)) * (R / 100)
  return [anchor[0] + gauss(r) * s, anchor[1] + gauss(r) * s * 0.8, anchor[2] + gauss(r) * s]
}

export function globalMember(id: string): V3 {
  const r = rng(id)
  // Denser toward the shell, like a cortex, but filling the volume.
  return toWorld(randomDir(r), 0.45 + 0.55 * Math.sqrt(r()))
}

export function entityPoint(id: string): V3 {
  const r = rng(`entity:${id}`)
  return toWorld(randomDir(r), 0.12 + 0.22 * r())
}
