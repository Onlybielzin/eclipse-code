import type { FireKind, FocusGroup, AgentOrigin, SceneData } from './engine'
import type { Motion, Shape, Style } from './engine'

/** O que a tela usa do motor. Os testes injetam um falso no lugar do three. */
export interface BrainEngineLike {
  setData(data: SceneData): void
  setShape(shape: Shape): void
  setMotion(motion: Motion): void
  setStyle(style: Style): void
  setTwinkle(on: boolean): void
  setHighlights(groups: FocusGroup[]): void
  focus(ids: string[]): void
  resetView(): void
  fire(ids: string[], kind: FireKind, opts?: { birth?: boolean; agent?: AgentOrigin }): void
  dispose(): void
}

export type EngineFactory = (
  stage: HTMLElement,
  labels: HTMLElement,
  onSelect: (id: string | null) => void,
) => Promise<BrainEngineLike>

/** O three (~700 kB) so e baixado quando o cerebro abre: import() dinamico vira chunk proprio. */
export const loadEngine: EngineFactory = async (stage, labels, onSelect) => {
  const { BrainEngine } = await import('./engine')
  return new BrainEngine(stage, labels, onSelect)
}
