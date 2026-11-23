import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { createNotificationHolder, type NotificationLike } from './electronNotifier'

class FakeNotification extends EventEmitter implements NotificationLike {
  static all: FakeNotification[] = []
  shown = false
  constructor(readonly options: { title: string; body: string }) {
    super()
    FakeNotification.all.push(this)
  }
  show() {
    this.shown = true
  }
}

function setup() {
  FakeNotification.all = []
  return createNotificationHolder(FakeNotification)
}

describe('createNotificationHolder', () => {
  it('guarda a notificação até fechar', () => {
    const holder = setup()
    holder.show('t', 'b', () => {})
    expect(holder.size()).toBe(1)
    expect(FakeNotification.all[0]!.shown).toBe(true)
    FakeNotification.all[0]!.emit('close')
    expect(holder.size()).toBe(0)
  })

  it('solta em failed', () => {
    const holder = setup()
    holder.show('t', 'b', () => {})
    FakeNotification.all[0]!.emit('failed')
    expect(holder.size()).toBe(0)
  })

  it('no clique trata e depois solta', () => {
    const holder = setup()
    const seen: number[] = []
    holder.show('t', 'b', () => seen.push(holder.size()))
    FakeNotification.all[0]!.emit('click')
    expect(seen).toEqual([1])
    expect(holder.size()).toBe(0)
  })

  it('solta mesmo se o clique lança', () => {
    const holder = setup()
    holder.show('t', 'b', () => {
      throw new Error('x')
    })
    expect(() => FakeNotification.all[0]!.emit('click')).toThrow()
    expect(holder.size()).toBe(0)
  })

  it('dispose limpa tudo e tira os ouvintes', () => {
    const holder = setup()
    holder.show('a', 'b', vi.fn())
    holder.show('c', 'd', vi.fn())
    holder.dispose()
    expect(holder.size()).toBe(0)
    expect(FakeNotification.all[0]!.listenerCount('click')).toBe(0)
  })
})
