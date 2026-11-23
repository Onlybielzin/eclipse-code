/** Parte da Notification do Electron que o adaptador usa (o construtor entra por parâmetro, para testar). */
export interface NotificationLike {
  on(event: 'click' | 'close' | 'failed', listener: () => void): unknown
  removeAllListeners(): unknown
  show(): void
}

export interface NotificationHolder {
  show(title: string, body: string, onClick: () => void): void
  size(): number
  dispose(): void
}

/** Guarda cada notificação até fechar, falhar ou ser clicada: sem isso o GC pode coletá-la e perder o clique. */
export function createNotificationHolder(
  Ctor: new (options: { title: string; body: string }) => NotificationLike,
): NotificationHolder {
  const live = new Set<NotificationLike>()
  return {
    show(title, body, onClick) {
      const notification = new Ctor({ title, body })
      const release = () => {
        live.delete(notification)
      }
      live.add(notification)
      notification.on('click', () => {
        try {
          onClick()
        } finally {
          release()
        }
      })
      notification.on('close', release)
      notification.on('failed', release)
      notification.show()
    },
    size: () => live.size,
    dispose() {
      for (const notification of live) notification.removeAllListeners()
      live.clear()
    },
  }
}
