/// <reference types="vite/client" />

import { EclipseCodeApi } from '../preload/index'

declare global {
  interface Window {
    eclipseCodeApi: EclipseCodeApi
  }
}
