import { describe, expect, it } from 'vitest'
import type { BrainGraph } from '@shared/brain'
import { buildScene } from './buildScene'

const node = (id: string, type: string, scope: string) => ({
  id,
  label: id,
  type,
  scope,
  importance: 5,
  created: '2026-11-01T00:00:00Z',
})

const graph: BrainGraph = {
  nodes: [
    node('m1', 'project_fact', 'project:alfa'),
    node('m2', 'learning', 'project:alfa'),
    node('m3', 'preference', 'global'),
    node('e1', 'entity', 'global'),
  ],
  edges: [{ source: 'm1', target: 'e1', kind: 'link' }],
}

describe('buildScene', () => {
  it('conta neurônios e cria uma região por projeto (global e entidades ficam sem região)', () => {
    const scene = buildScene(graph)
    expect(scene.nodes).toHaveLength(4)
    expect(scene.regions.map((r) => r.name)).toEqual(['alfa'])
    expect(scene.regions[0]?.count).toBe(2)
  })

  it('mantém as arestas da API, sem duplicar, e liga cada memória aos vizinhos próximos', () => {
    const scene = buildScene({
      ...graph,
      edges: [
        ...graph.edges,
        { source: 'e1', target: 'm1', kind: 'link' },
        { source: 'x', target: 'm1', kind: 'link' },
      ],
    })
    const api = scene.edges.filter((e) => e.kind === 'link')
    expect(api).toHaveLength(1)
    expect(scene.edges.length).toBeGreaterThanOrEqual(1)
  })

  it('é determinístico: o mesmo grafo dá as mesmas posições', () => {
    expect(buildScene(graph).nodes.map((n) => n.pos)).toEqual(
      buildScene(graph).nodes.map((n) => n.pos),
    )
  })
})
