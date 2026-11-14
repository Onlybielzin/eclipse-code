/**
 * Fabrica do xterm do Lider. Fica isolada para os testes (jsdom, sem canvas/WebGL)
 * trocarem por um terminal falso com vi.mock.
 */
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'

export interface XtermHandle {
  write(data: string): void
  onData(listener: (data: string) => void): () => void
  /** Ajusta ao tamanho do container. Devolve o tamanho novo, ou null se nao deu. */
  fit(): { cols: number; rows: number } | null
  focus(): void
  dispose(): void
}

export function createXterm(container: HTMLElement): XtermHandle {
  const term = new Terminal({
    cursorBlink: true,
    fontFamily: '"Geist Mono Variable", ui-monospace, Menlo, monospace',
    fontSize: 13,
    lineHeight: 1.25,
    scrollback: 10_000,
    allowProposedApi: false,
    theme: {
      background: '#07090e',
      foreground: '#c9d1dd',
      cursor: '#5ab9fc',
      selectionBackground: '#264a6b',
      black: '#131824',
      green: '#4ade80',
      yellow: '#f2b84b',
      red: '#f87171',
      blue: '#5ab9fc',
      magenta: '#a78bfa',
    },
  })
  const fitAddon = new FitAddon()
  term.loadAddon(fitAddon)
  term.open(container)
  try {
    const webgl = new WebglAddon()
    webgl.onContextLoss(() => webgl.dispose())
    term.loadAddon(webgl)
  } catch {
    // sem WebGL: o xterm segue com o renderizador DOM
  }
  return {
    write: (data) => term.write(data),
    onData: (listener) => {
      const sub = term.onData(listener)
      return () => sub.dispose()
    },
    fit: () => {
      try {
        fitAddon.fit()
        return { cols: term.cols, rows: term.rows }
      } catch {
        return null
      }
    },
    focus: () => term.focus(),
    dispose: () => term.dispose(),
  }
}
