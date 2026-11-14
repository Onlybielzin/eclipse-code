// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MiddlePane } from '../components/MiddlePane'
import { SettingsModal } from '../components/SettingsModal'
import { AppStore } from '../store/appStore'
import { StoreProvider } from '../store/context'
import { FakeApi, mockupData } from '../test/fakeApi'
import type { BrainEngineLike } from './engineLoader'

// jsdom nao tem WebGL: o motor e falso, e o three nem chega a ser importado.
const engines: BrainEngineLike[] = []
vi.mock('./engineLoader', () => ({
  loadEngine: async () => {
    const e = {
      setData: vi.fn(),
      setShape: vi.fn(),
      setMotion: vi.fn(),
      setStyle: vi.fn(),
      setTwinkle: vi.fn(),
      setHighlights: vi.fn(),
      focus: vi.fn(),
      resetView: vi.fn(),
      fire: vi.fn(),
      dispose: vi.fn(),
    }
    engines.push(e)
    return e
  },
}))

function setup() {
  const api = new FakeApi(mockupData())
  api.brainKey = 'sbk_abcd1234'
  const store = new AppStore(api)
  store.setBrainOpen(true)
  render(
    <StoreProvider store={store}>
      <MiddlePane />
      <SettingsModal onClose={() => {}} />
    </StoreProvider>,
  )
  return store
}

beforeEach(() => {
  localStorage.clear()
  engines.length = 0
})
afterEach(cleanup)

describe('Efeito do Cérebro nas Configurações', () => {
  it('mudar a Forma no modal chama setShape no motor aberto e grava a escolha', async () => {
    setup()
    await waitFor(() => expect(engines).toHaveLength(1))
    await waitFor(() => expect(engines[0]!.setShape).toHaveBeenCalledWith('rodizio'))
    fireEvent.change(screen.getByLabelText('Forma'), { target: { value: 'nuvem' } })
    expect(engines[0]!.setShape).toHaveBeenLastCalledWith('nuvem')
    expect(localStorage.getItem('eclipse.brain.shape')).toBe('nuvem')
    expect(engines).toHaveLength(1) // sem recriar o motor nem recarregar o grafo
  })

  it('Movimento, Cor e Cintilar chegam ao motor', async () => {
    setup()
    await waitFor(() => expect(engines).toHaveLength(1))
    fireEvent.change(screen.getByLabelText('Movimento'), { target: { value: 'onda' } })
    fireEvent.change(screen.getByLabelText('Cor'), { target: { value: 'idade' } })
    fireEvent.click(screen.getByRole('switch', { name: 'Cintilar' }))
    expect(engines[0]!.setMotion).toHaveBeenLastCalledWith('onda')
    expect(engines[0]!.setStyle).toHaveBeenLastCalledWith('idade')
    expect(engines[0]!.setTwinkle).toHaveBeenLastCalledWith(true)
    expect(localStorage.getItem('eclipse.brain.twinkle')).toBe('1')
  })

  it('valor inválido no localStorage cai no padrão; valor válido é lido', () => {
    localStorage.setItem('eclipse.brain.shape', 'xxx')
    localStorage.setItem('eclipse.brain.motion', 'onda')
    const look = new AppStore(new FakeApi(mockupData())).getState().brainLook
    expect(look).toEqual({ shape: 'rodizio', motion: 'onda', style: 'tipo', twinkle: false })
  })

  it('a barra do cérebro grande não tem mais os seletores de aparência', async () => {
    setup()
    await waitFor(() => expect(engines).toHaveLength(1))
    expect(screen.getByRole('button', { name: 'Centralizar' })).toBeTruthy()
    expect(document.querySelector('.toolbar .looks')).toBeNull()
    expect(document.querySelector('.toolbar .picker')).toBeNull()
    act(() => {})
  })
})
