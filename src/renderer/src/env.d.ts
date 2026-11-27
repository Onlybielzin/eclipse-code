/// <reference types="vite/client" />
import '../../preload/api'

declare global {
  interface Window {
    /** true quando a tela roda como página web (celular), servida pelo main. */
    eclipseRemote?: boolean
  }
}
