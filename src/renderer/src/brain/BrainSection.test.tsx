// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActivityEvent } from '@shared/brain'
import { MiddlePane } from '../components/MiddlePane'
import { TitleBar } from '../components/TitleBar'
import { AppStore } from '../store/appStore'
import { StoreProvider } from '../store/context'
import { FakeApi, mockupData } from '../test/fakeApi'
import { BrainSection } from './BrainSection'
import type { BrainEngineLike } from './engineLoader'

// jsdom nao tem WebGL: o motor e falso, e o three nem chega a ser importado.
const engines: (BrainEngineLike & { disposed: boolean; fired: string[][] })[] = []
vi.mock('./engineLoader', () => ({
  loadEngine: async () => {
    const e = {
      disposed: false,
      fired: [] as string[][],
      setData: vi.fn(),
      setShape: vi.fn(),
      setMotion: vi.fn(),
      setStyle: vi.fn(),
      setTwinkle: vi.fn(),
      setHighlights: vi.fn(),
      focus: vi.fn(),
      resetView: vi.fn(),
      fire(ids: string[]) {
        this.fired.push(ids)
      },
      dispose() {
        this.disposed = true
      },
    }
    engines.push(e)
    return e
  },
}))

let api: FakeApi
const names = (channel: string) => api.calls.filter((c) => c.channel === channel).length

function setup(withKey = true) {
  api = new FakeApi(mockupData())
  api.brainKey = withKey ? 'sbk_abcd1234' : null
  api.brainGraph = {
    nodes: [
      {
        id: 'm1',
        label: 'Memória 1',
        type: 'learning',
        scope: 'global',
        importance: 5,
        created: '2026-11-01T00:00:00Z',
      },
      {
        id: 'e1',
        label: 'Entidade',
        type: 'entity',
        scope: 'global',
        importance: 5,
        created: '2026-11-01T00:00:00Z',
      },
    ],
    edges: [{ source: 'm1', target: 'e1', kind: 'link' }],
  }
  const store = new AppStore(api)
  render(
    <StoreProvider store={store}>
      <TitleBar />
      <MiddlePane />
      <BrainSection />
    </StoreProvider>,
  )
  return store
}

const expand = () => fireEvent.click(screen.getByRole('button', { name: /Cérebro/ }))

const activity = (
  seq: number,
  ids: string[],
  kind: ActivityEvent['kind'] = 'search',
): ActivityEvent => ({
  seq,
  ts: '2026-11-14T10:00:00Z',
  kind,
  query: 'q',
  hits: ids.map((id) => ({ id })),
})

beforeEach(() => {
  localStorage.clear()
  engines.length = 0
})
afterEach(cleanup)

describe('Seção Cérebro', () => {
  it('começa recolhida e não chama o main', () => {
    setup()
    expect(screen.getByRole('button', { name: /Cérebro/ }).getAttribute('aria-expanded')).toBe(
      'false',
    )
    expect(names('brain.status')).toBe(0)
    expect(names('brain.subscribe')).toBe(0)
  })

  it('sem chave mostra o aviso, não assina e abre as Configurações', async () => {
    setup(false)
    expand()
    await screen.findByText('Configure a chave do Second Brain em Configurações.')
    expect(names('brain.subscribe')).toBe(0)
    expect(engines).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Abrir Configurações' }))
    expect(screen.getByRole('dialog', { name: 'Configurações' })).toBeTruthy()
  })

  it('expandir assina o SSE, pede o grafo e cria o motor; recolher solta tudo', async () => {
    setup()
    expand()
    await waitFor(() => expect(names('brain.graph')).toBe(1))
    expect(names('brain.subscribe')).toBe(1)
    await waitFor(() => expect(engines).toHaveLength(1))
    expect(localStorage.getItem('eclipse.brainPanel.collapsed')).toBe('0')

    expand()
    await waitFor(() => expect(names('brain.unsubscribe')).toBe(1))
    expect(engines[0]?.disposed).toBe(true)
    expect(localStorage.getItem('eclipse.brainPanel.collapsed')).toBe('1')
  })

  it('desmontar a tela também chama brain.unsubscribe e dispõe o motor', async () => {
    setup()
    expand()
    await waitFor(() => expect(engines).toHaveLength(1))
    cleanup()
    expect(names('brain.unsubscribe')).toBe(1)
    expect(engines[0]?.disposed).toBe(true)
  })

  it('mostra o lastError quando a chave foi recusada', async () => {
    setup()
    api.overrides.set('brain.status', () => ({
      ok: true,
      value: {
        hasKey: true,
        keyLast4: '1234',
        connected: false,
        lastError: 'Chave recusada (401)',
      },
    }))
    expand()
    expect((await screen.findByTestId('brain-error')).textContent).toContain('Chave recusada (401)')
  })

  it('abre no meio cedendo o motor e o Fechar volta à tela anterior', async () => {
    setup()
    expand()
    await waitFor(() => expect(engines).toHaveLength(1))
    fireEvent.click(screen.getByTestId('brain-open'))
    // a seção pequena solta o motor; o do meio assume (um por vez)
    await waitFor(() => expect(engines).toHaveLength(2))
    expect(engines[0]?.disposed).toBe(true)
    expect(engines[1]?.disposed).toBe(false)
    expect(screen.getByRole('button', { name: 'Centralizar' })).toBeTruthy()
    expect(screen.getByText('Aberto no painel central.')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Fechar' }))
    expect(screen.getByText('Escolha uma tarefa na lista ou crie uma nova.')).toBeTruthy()
    await waitFor(() => expect(engines[1]?.disposed).toBe(true))
  })

  it('o feed guarda no máximo 20 itens', async () => {
    setup()
    expand()
    fireEvent.click(screen.getByTestId('brain-open'))
    await waitFor(() => expect(engines.length).toBeGreaterThan(0))
    await waitFor(() => expect(names('brain.graph')).toBeGreaterThan(0))
    act(() =>
      api.emit(
        'brain.history',
        Array.from({ length: 30 }, (_, i) => activity(i + 1, ['m1'])),
      ),
    )
    expect(screen.getByTestId('brain-feed').querySelectorAll('li')).toHaveLength(20)
  })

  it('evento com id conhecido só pulsa; com id desconhecido pede brain.graph de novo', async () => {
    setup()
    expand()
    await waitFor(() => expect(engines).toHaveLength(1))
    await waitFor(() => expect(engines[0]?.setData).toHaveBeenCalled())
    const before = names('brain.graph')
    act(() => api.emit('brain.activity', activity(1, ['m1'])))
    expect(names('brain.graph')).toBe(before)
    expect(engines[0]?.fired).toEqual([['m1']])

    // O main devolve o grafo já com a memória nova (objeto novo, como no IPC real).
    api.brainGraph = {
      ...api.brainGraph,
      nodes: [
        ...api.brainGraph.nodes,
        {
          id: 'nova',
          label: 'Nova',
          type: 'learning',
          scope: 'global',
          importance: 5,
          created: '2026-11-14T10:00:00Z',
        },
      ],
    }
    act(() => api.emit('brain.activity', activity(2, ['nova'], 'save')))
    await waitFor(() => expect(names('brain.graph')).toBe(before + 1))
    await waitFor(() => expect(engines[0]?.fired).toEqual([['m1'], ['nova']]))
  })
})
