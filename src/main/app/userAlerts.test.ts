import { describe, expect, it, vi } from 'vitest'
import { createUserAlerts, type SystemNotifier } from './userAlerts'

function setup(over: Partial<SystemNotifier> = {}) {
  const emitted: { channel: string; payload: unknown }[] = []
  const shown: { title: string; body: string; click: () => void }[] = []
  const notifier: SystemNotifier = {
    isSupported: () => true,
    isWindowFocused: () => false,
    focusWindow: vi.fn(),
    show: (title, body, click) => shown.push({ title, body, click }),
    ...over,
  }
  let n = 0
  const alerts = createUserAlerts({
    lookup: (taskId) => ({
      taskId,
      taskName: 'Login',
      projectId: 'p1',
      projectName: 'ereemby',
    }),
    emit: (m) => emitted.push(m),
    notifier,
    now: () => 1000 + n,
    newId: () => `n${++n}`,
  })
  return { alerts, emitted, shown, notifier }
}

describe('userAlerts', () => {
  it('monta o aviso, guarda e publica ao renderer', () => {
    const { alerts, emitted } = setup({ isWindowFocused: () => true })
    alerts.publish('t1', 'Terminei')
    const notice = {
      id: 'n1',
      taskId: 't1',
      taskName: 'Login',
      projectId: 'p1',
      projectName: 'ereemby',
      text: 'Terminei',
      createdAt: 1001,
    }
    expect(emitted).toEqual([{ channel: 'notice.created', payload: notice }])
    expect(alerts.recent()).toEqual([notice])
  })

  it('guarda só os últimos 20', () => {
    const { alerts } = setup({ isWindowFocused: () => true })
    for (let i = 0; i < 25; i++) alerts.publish('t1', `a${i}`)
    expect(alerts.recent()).toHaveLength(20)
    expect(alerts.recent()[0]?.text).toBe('a5')
  })

  it('sem foco mostra a notificação do sistema; o clique foca e abre a tarefa', () => {
    const { alerts, emitted, shown, notifier } = setup()
    alerts.publish('t1', 'Terminei')
    expect(shown).toHaveLength(1)
    expect(shown[0]).toMatchObject({ title: 'ereemby: Login', body: 'Terminei' })
    shown[0]?.click()
    expect(notifier.focusWindow).toHaveBeenCalled()
    expect(emitted.at(-1)).toEqual({
      channel: 'notice.open',
      payload: { taskId: 't1', projectId: 'p1' },
    })
  })

  it('com foco, só o toast', () => {
    const { alerts, shown } = setup({ isWindowFocused: () => true })
    alerts.publish('t1', 'x')
    expect(shown).toHaveLength(0)
  })

  it('sem suporte a notificação, só o toast', () => {
    const { alerts, shown, emitted } = setup({ isSupported: () => false })
    alerts.publish('t1', 'x')
    expect(shown).toHaveLength(0)
    expect(emitted).toHaveLength(1)
  })

  it('tarefa que não existe mais não gera aviso nem derruba o chamador', () => {
    const { alerts, emitted } = setup()
    const broken = createUserAlerts({
      lookup: () => {
        throw new Error('sem tarefa')
      },
      emit: (m) => emitted.push(m),
      notifier: { isSupported: () => false, isWindowFocused: () => true, focusWindow() {}, show() {} },
    })
    expect(() => broken.publish('x', 'y')).not.toThrow()
    expect(emitted).toHaveLength(0)
    expect(alerts.recent()).toEqual([])
  })
})
