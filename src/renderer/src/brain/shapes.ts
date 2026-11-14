/**
 * Formations of the A30 prototype (docs/prototipos/animacoes-a30.tpl.html):
 * the points travel from the cloud to another shape and back.
 *
 * Targets are deterministic (same data -> same shape) and roughly the size of
 * the cloud (R = 100).
 */
export type Shape =
  | 'nuvem'
  | 'cerebro'
  | 'galaxia'
  | 'helice'
  | 'esfera'
  | 'toro'
  | 'explosao'
  | 'neuronio'
  | 'saturno'
  | 'cristal'
  | 'coracao'
  | 'rodizio'
export type Formation = Exclude<Shape, 'nuvem' | 'rodizio'>

export const SHAPES: { id: Shape; label: string }[] = [
  { id: 'nuvem', label: 'Nuvem' },
  { id: 'cerebro', label: 'Cérebro' },
  { id: 'galaxia', label: 'Galáxia' },
  { id: 'helice', label: 'Hélice dupla' },
  { id: 'esfera', label: 'Esfera' },
  { id: 'toro', label: 'Toro' },
  { id: 'explosao', label: 'Explosão' },
  { id: 'neuronio', label: 'Neurônio' },
  { id: 'saturno', label: 'Saturno' },
  { id: 'cristal', label: 'Cristal' },
  { id: 'coracao', label: 'Coração' },
  { id: 'rodizio', label: 'Rodízio' },
]
export const ROTATION: Formation[] = [
  'cerebro',
  'galaxia',
  'neuronio',
  'helice',
  'saturno',
  'esfera',
  'cristal',
  'toro',
  'coracao',
  'explosao',
]

export const isShape = (v: unknown): v is Shape => SHAPES.some((s) => s.id === v)

/** Rodízio cycle (seconds): cloud 2 -> going 3 -> in the shape 8 -> coming back 3. */
export const CYCLE_S = 16
export function rotationAt(tSec: number): { id: Formation; s: number } {
  const u = tSec % CYCLE_S
  const id = ROTATION[Math.floor(tSec / CYCLE_S) % ROTATION.length]!
  if (u < 2) return { id, s: 0 }
  if (u < 5) return { id, s: (u - 2) / 3 }
  if (u < 13) return { id, s: 1 }
  return { id, s: 1 - (u - 13) / 3 }
}

export interface ShapeInput {
  /** Cloud positions, xyz per node. */
  home: Float32Array
  entity: boolean[]
  /** Project index per node; -1 = global (no project). */
  region: number[]
}

function lcg(seed: number) {
  let s = seed >>> 0
  const rnd = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
  const gauss = () => {
    let u = 0
    for (let k = 0; k < 6; k++) u += rnd()
    return u - 3
  }
  return { rnd, gauss }
}

/** Per-node delay (0..0.35 of the transition) so the points leave in a wave, not all at once. */
export function delays(n: number): Float32Array {
  const { rnd } = lcg(12345)
  const d = new Float32Array(n)
  for (let i = 0; i < n; i++) d[i] = rnd() * 0.35
  return d
}

export function buildTargets({
  home,
  entity,
  region,
}: ShapeInput): Record<Formation, Float32Array> {
  const n = entity.length
  const { rnd, gauss } = lcg(777)
  // Order along the shape: grouped by project, so each project stays together.
  const order = [...Array(n).keys()].sort((a, b) => region[a]! - region[b]! || a - b)
  const rank = new Int32Array(n)
  order.forEach((i, k) => (rank[i] = k))
  const make = (fn: (i: number) => [number, number, number]) => {
    const t = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) t.set(fn(i), i * 3)
    return t
  }

  // Spiral galaxy: 4 arms, one project per arm, entities in the core.
  const galaxia = make((i) => {
    if (entity[i]) {
      const r = 14 * Math.sqrt(rnd())
      const a = rnd() * Math.PI * 2
      return [r * Math.cos(a), gauss() * 4, r * Math.sin(a)]
    }
    const rg = region[i]! < 0 ? Math.floor(rnd() * 51) : region[i]
    const arm = rg! % 4
    const r = 20 + 82 * Math.sqrt(rnd())
    const a = (arm * Math.PI) / 2 + r * 0.032 + ((rg! * 0.37) % 0.5) + gauss() * 0.12
    return [r * Math.cos(a), gauss() * 3 * (1.3 - r / 110), r * Math.sin(a)]
  })

  // Double helix (DNA): two strands, points in project order along them.
  const helice = make((i) => {
    const k = rank[i]
    const x = (k! / n - 0.5) * 200
    const t = x / 16 + (k! % 2) * Math.PI
    if (entity[i]) {
      const m = gauss() * 10
      return [x, m * Math.cos(t), m * Math.sin(t)]
    }
    return [x, 34 * Math.cos(t) + gauss() * 1.5, 34 * Math.sin(t) + gauss() * 1.5]
  })

  // Sphere: Fibonacci lattice, evenly spread, grouped by project.
  const esfera = make((i) => {
    const k = rank[i]
    const y = 1 - (2 * (k! + 0.5)) / n
    const r = Math.sqrt(1 - y * y)
    const a = k! * 2.39996
    return [92 * r * Math.cos(a), 92 * y, 92 * r * Math.sin(a)]
  })

  // Torus (doughnut surface).
  const toro = make((i) => {
    const k = rank[i]
    const u = (k! / n) * Math.PI * 2
    const v = k! * 2.39996 * 7
    const rr = 74 + 26 * Math.cos(v)
    return [rr * Math.cos(u), 26 * Math.sin(v), rr * Math.sin(u)]
  })

  // Explosion: the cloud flies outwards and comes back to the same place.
  const explosao = make((i) => {
    const x = home[i * 3]!
    const y = home[i * 3 + 1]!
    const z = home[i * 3 + 2]!
    const l = Math.hypot(x, y, z) || 1
    const f = 1.9 + rnd() * 1.2
    return [x * f + (x / l) * 30, y * f + (y / l) * 30, z * f + (z / l) * 30]
  })

  // Saturn: a planet (40% of the memories) with a tilted ring; entities in its core.
  const tilt = (22 * Math.PI) / 180
  const ct = Math.cos(tilt)
  const st = Math.sin(tilt)
  const planetN = Math.max(1, Math.round(n * 0.4))
  const saturno = make((i) => {
    if (entity[i]) return [gauss() * 7, gauss() * 7, gauss() * 7]
    const k = rank[i]
    if (k! < planetN) {
      const y = 1 - (2 * (k! + 0.5)) / planetN
      const r = Math.sqrt(1 - y * y)
      const a = k! * 2.39996
      return [46 * r * Math.cos(a), 46 * y, 46 * r * Math.sin(a)]
    }
    let r = 64 + 42 * Math.sqrt(rnd())
    if (r > 86 && r < 92) r += 6 // a dark gap in the ring (Cassini division)
    const a = ((k! - planetN) / Math.max(1, n - planetN)) * Math.PI * 2 * 9 + rnd() * 0.6
    const x = r * Math.cos(a)
    const y = gauss() * 1.1
    const z = r * Math.sin(a)
    return [x * ct - y * st, x * st + y * ct, z]
  })

  // Crystal: a cubic lattice, filled in project order (each project is a slab).
  const side = Math.max(2, Math.ceil(Math.cbrt(n)))
  const step = 150 / (side - 1)
  const cristal = make((i) => {
    const k = rank[i]
    const gx = k! % side
    const gy = Math.floor(k! / side) % side
    const gz = Math.floor(k! / (side * side))
    return [
      (gx - (side - 1) / 2) * step,
      (gy - (side - 1) / 2) * step,
      (gz - (side - 1) / 2) * step,
    ]
  })

  // Heart: a puffy 3D heart, points mostly near its skin; entities in the middle.
  const heart = (t: number): [number, number] => [
    16 * Math.sin(t) ** 3,
    13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t),
  ]
  const speed = (t: number) => {
    const [a, b] = heart(t - 1e-3)
    const [c, d] = heart(t + 1e-3)
    return Math.hypot(c - a, d - b)
  }
  let maxSpeed = 0
  for (let k = 0; k < 400; k++) maxSpeed = Math.max(maxSpeed, speed((k / 400) * Math.PI * 2))
  const coracao = make((i) => {
    if (entity[i]) return [gauss() * 8, 4 + gauss() * 8, gauss() * 6]
    // Even spread along the outline (the raw parameter bunches points at the top and the tip).
    let t = rnd() * Math.PI * 2
    for (let k = 0; k < 12 && rnd() * maxSpeed > speed(t); k++) t = rnd() * Math.PI * 2
    const [hx, hy] = heart(t)
    const u = Math.pow(rnd(), 0.35) // biased to the outline
    const z = (rnd() < 0.5 ? -1 : 1) * Math.sqrt(Math.max(0, 1 - u * u)) * 34
    return [u * hx * 5.2, u * hy * 5.2 + 14, z]
  })

  return {
    cerebro: brain(entity, order, gauss),
    galaxia,
    helice,
    esfera,
    toro,
    explosao,
    neuronio: neuron(entity, order, gauss),
    saturno,
    cristal,
    coracao,
  }
}

/**
 * Neuron: a round cell body (soma) with the entities as its nucleus, branching
 * dendrites on one side and a long wavy axon ending in small terminals.
 */
function neuron(entity: boolean[], order: number[], gauss: () => number): Float32Array {
  const n = entity.length
  const out = new Float32Array(n * 3)
  const { rnd } = lcg(9091)
  type P3 = [number, number, number]
  const SOMA: P3 = [-38, 0, 0]
  const SOMA_R = 20
  const segs: { a: P3; b: P3; len: number }[] = []
  const norm = (v: P3): P3 => {
    const l = Math.hypot(v[0], v[1], v[2]) || 1
    return [v[0] / l, v[1] / l, v[2] / l]
  }
  const grow = (p: P3, dir: P3, len: number, depth: number, spread: number) => {
    const b: P3 = [p[0] + dir[0] * len, p[1] + dir[1] * len, p[2] + dir[2] * len]
    segs.push({ a: p, b, len })
    if (depth <= 0) return
    for (let c = 0; c < 2; c++) {
      const d = norm([
        dir[0] + (rnd() - 0.5) * spread,
        dir[1] + (rnd() - 0.5) * spread,
        dir[2] + (rnd() - 0.5) * spread,
      ])
      grow(b, d, len * 0.66, depth - 1, spread)
    }
  }
  // Dendrites: 7 roots leaving the soma away from the axon side.
  for (let k = 0; k < 7; k++) {
    const u = rnd() * 1.6 - 0.8
    const a = (k / 7) * Math.PI * 2 + rnd() * 0.5
    const q = Math.sqrt(1 - u * u)
    const dir = norm([-0.9 - rnd() * 0.6, q * Math.cos(a) * 1.4, q * Math.sin(a) * 1.4 + u * 0.3])
    const start: P3 = [
      SOMA[0] + dir[0] * SOMA_R,
      SOMA[1] + dir[1] * SOMA_R,
      SOMA[2] + dir[2] * SOMA_R,
    ]
    grow(start, dir, 26, 3, 1.3)
  }
  // Axon: wavy line to the right, then terminal branches.
  let prev: P3 = [SOMA[0] + SOMA_R, 0, 0]
  for (let k = 1; k <= 12; k++) {
    const x = SOMA[0] + SOMA_R + k * 11
    const next: P3 = [x, 5 * Math.sin(k * 0.9), 4 * Math.cos(k * 0.7)]
    segs.push({
      a: prev,
      b: next,
      len: Math.hypot(next[0] - prev[0], next[1] - prev[1], next[2] - prev[2]),
    })
    prev = next
  }
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2 + 0.4
    grow(prev, norm([1, Math.cos(a) * 0.9, Math.sin(a) * 0.9]), 14, 2, 1.0)
  }
  const total = segs.reduce((s, x) => s + x.len, 0)
  const cum: number[] = []
  let acc = 0
  for (const x of segs) cum.push((acc += x.len))

  const mem = order.filter((i) => !entity[i])
  const somaN = Math.round(mem.length * 0.2)
  mem.forEach((i, k) => {
    if (k < somaN) {
      const y = 1 - (2 * (k + 0.5)) / Math.max(1, somaN)
      const r = Math.sqrt(1 - y * y)
      const a = k * 2.39996
      out.set(
        [
          SOMA[0] + SOMA_R * r * Math.cos(a),
          SOMA[1] + SOMA_R * y,
          SOMA[2] + SOMA_R * r * Math.sin(a),
        ],
        i * 3,
      )
      return
    }
    // Even spread along all branches, in project order.
    const at = ((k - somaN + 0.5) / Math.max(1, mem.length - somaN)) * total
    let s = 0
    while (s < segs.length - 1 && cum[s]! < at) s++
    const g = segs[s]
    const f = 1 - (cum[s]! - at) / g!.len
    const w = 1.2 + 1.6 * (1 - Math.min(1, g!.len / 26))
    out.set(
      [
        g!.a[0] + (g!.b[0] - g!.a[0]) * f + gauss() * w,
        g!.a[1] + (g!.b[1] - g!.a[1]) * f + gauss() * w,
        g!.a[2] + (g!.b[2] - g!.a[2]) * f + gauss() * w,
      ],
      i * 3,
    )
  })
  for (const i of order)
    if (entity[i])
      out.set([SOMA[0] + gauss() * 5, SOMA[1] + gauss() * 5, SOMA[2] + gauss() * 5], i * 3)
  return out
}

/**
 * Brain: two hemispheres with the fissure between them, points gathered on
 * the ridges of the folds (gyri), cerebellum low at the back with thin bands,
 * brain stem going down, entities in the middle (thalamus).
 * Axes: x = front (+) / back (-), y = up, z = left/right.
 */
function brain(entity: boolean[], order: number[], gauss: () => number): Float32Array {
  const n = entity.length
  const out = new Float32Array(n * 3)
  const { rnd } = lcg(4242)
  // Folds: a gyroid on the unit sphere gives winding, maze-like ridges.
  const fold = (x: number, y: number, z: number) => {
    const a = 9
    return (
      Math.sin(a * x) * Math.cos(a * y) +
      Math.sin(a * y) * Math.cos(a * z) +
      Math.sin(a * z) * Math.cos(a * x)
    )
  }
  const LIFT = 10 // whole shape moves up so it sits centred

  // Which part each memory goes to (in project order, so projects stay together).
  const part = new Int8Array(n) // 0 cortex, 1 cerebellum, 2 stem
  let cortex = 0
  for (const i of order) {
    if (entity[i]) continue
    const r = rnd()
    part[i] = r < 0.84 ? 0 : r < 0.96 ? 1 : 2
    if (part[i] === 0) cortex++
  }
  const perHemi = Math.max(1, Math.ceil(cortex / 2))
  let c = 0
  for (const i of order) {
    let p: [number, number, number]
    if (entity[i]) {
      p = [gauss() * 7, -4 + gauss() * 5, gauss() * 6]
    } else if (part[i] === 0) {
      const side = c % 2 === 0 ? -1 : 1
      const k = c >> 1
      c++
      // Even spread over the hemisphere (Fibonacci), then pull to the nearest ridge.
      const fy = 1 - (2 * (k + 0.5)) / perHemi
      const fr = Math.sqrt(Math.max(0, 1 - fy * fy))
      const fa = k * 2.39996
      let best: [number, number, number] = [fr * Math.cos(fa), fy, fr * Math.sin(fa)]
      let bestF = fold(best[0], best[1], best[2])
      for (let t = 0; t < 14; t++) {
        const d: [number, number, number] = [
          best[0] + (rnd() - 0.5) * 0.3,
          best[1] + (rnd() - 0.5) * 0.3,
          best[2] + (rnd() - 0.5) * 0.3,
        ]
        const l = Math.hypot(d[0], d[1], d[2]) || 1
        d[0] /= l
        d[1] /= l
        d[2] /= l
        const f = fold(d[0], d[1], d[2])
        if (f > bestF) {
          best = d
          bestF = f
        }
      }
      const [dx, dy, dz] = best
      const bump = 1 + 0.045 * bestF
      let x = dx * 80 * bump
      let y = dy * 56 * bump
      let z = dz * 36 * bump
      if (dz * side < 0) z *= 0.18 // flat inner wall along the fissure
      if (y < 0) y *= 0.68 // flatter underside
      if (dx > 0.35 && dy < -0.1) y -= 8 * dx // temporal/frontal lobe dips a little
      x *= 1 - 0.08 * Math.max(0, dy) // slightly narrower on top
      p = [x, y + LIFT, side * 6 + z]
    } else if (part[i] === 1) {
      const side = rnd() < 0.5 ? -1 : 1
      const u = rnd() * 2 - 1
      const a = rnd() * Math.PI * 2
      const r = Math.sqrt(1 - u * u)
      const folia = 1 + 0.07 * Math.sin(u * 30)
      p = [
        -56 + r * Math.cos(a) * 24 * folia,
        -38 + u * 15 * folia + LIFT,
        side * 19 + r * Math.sin(a) * 21 * folia,
      ]
    } else {
      const t = rnd()
      p = [-22 - 12 * t + gauss() * 3, -30 - 46 * t + LIFT, gauss() * 4]
    }
    out.set(p, i * 3)
  }
  return out
}
