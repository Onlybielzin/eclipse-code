import type { EclipseApi } from '@shared/ipc'

declare global {
  interface Window {
    eclipse: EclipseApi
  }
}

export type { EclipseApi }
