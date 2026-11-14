import type { ApiNode, BrainGraph } from '@shared/brain'
// So tipos: o three nao entra no chunk principal.
import type { EngineEdge, EngineNode, SceneData } from './engine'
import { entityPoint, globalMember, R, regionAnchor, regionMember, type V3 } from './shape'

const regionName = (scope: string) =>
  scope === 'global' ? 'global' : scope.replace(/^project:/, '')

/** Posiciona cada memória e liga as sinapses aos 2 vizinhos mais próximos (igual ao site). */
export function buildScene(raw: BrainGraph): SceneData {
  const degree = new Map<string, number>()
  for (const e of raw.edges) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1)
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1)
  }
  const groups = new Map<string, ApiNode[]>()
  for (const n of raw.nodes) {
    const r = n.type === 'entity' ? '·entidades' : regionName(n.scope)
    const list = groups.get(r) ?? []
    list.push(n)
    groups.set(r, list)
  }

  const nodes: EngineNode[] = []
  const regions: SceneData['regions'] = []
  for (const [region, members] of groups) {
    const anchor = region !== 'global' && region !== '·entidades' ? regionAnchor(region) : null
    const start = nodes.length
    for (const n of members) {
      const pos: V3 =
        n.type === 'entity'
          ? entityPoint(n.id)
          : anchor
            ? regionMember(n.id, anchor, members.length)
            : globalMember(n.id)
      nodes.push({
        id: n.id,
        label: n.label,
        type: n.type,
        region,
        importance: n.importance,
        degree: degree.get(n.id) ?? 0,
        pos,
        created: Date.parse(n.created) || 0,
      })
    }
    if (anchor) {
      regions.push({
        name: region,
        pos: anchor,
        count: members.length,
        members: nodes.slice(start).map((_, k) => start + k),
      })
    }
  }

  const index = new Map(nodes.map((n, i) => [n.id, i]))
  const edges: EngineEdge[] = []
  const seen = new Set<string>()
  const key = (a: number, b: number) => (a < b ? `${a}|${b}` : `${b}|${a}`)
  for (const e of raw.edges) {
    const a = index.get(e.source)
    const b = index.get(e.target)
    if (a === undefined || b === undefined || seen.has(key(a, b))) continue
    seen.add(key(a, b))
    edges.push({ a, b, kind: e.kind })
  }
  const maxD = (0.16 * R) ** 2
  for (let a = 0; a < nodes.length; a++) {
    const na = nodes[a]!
    if (na.type === 'entity') continue
    const pa = na.pos
    let best: [number, number][] = []
    for (let b = 0; b < nodes.length; b++) {
      const nb = nodes[b]!
      if (a === b || nb.type === 'entity') continue
      const pb = nb.pos
      const d = (pa[0] - pb[0]) ** 2 + (pa[1] - pb[1]) ** 2 + (pa[2] - pb[2]) ** 2
      if (d > maxD) continue
      if (best.length < 2) best.push([d, b])
      else if (d < best[1]![0]) best[1] = [d, b]
      else continue
      best = best.sort((p, q) => p[0] - q[0])
    }
    for (const [, b] of best) {
      if (seen.has(key(a, b))) continue
      seen.add(key(a, b))
      edges.push({ a, b, kind: 'synapse' })
    }
  }
  return { nodes, edges, regions }
}
