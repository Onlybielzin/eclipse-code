/**
 * Fabrica do xterm do Lider. Fica isolada para os testes (jsdom, sem canvas/WebGL)
 * trocarem por um terminal falso com vi.mock.
 */
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import { findUrls } from './findUrls'
import { dropPathsText } from './dropPaths'
import { clipboardKeyAction, isImageOnlyPaste } from './clipboardKeys'

export interface XtermHandle {
  write(data: string): void
  onData(listener: (data: string) => void): () => void
  /** Ajusta ao tamanho do container. Devolve o tamanho novo, ou null se nao deu. */
  fit(): { cols: number; rows: number } | null
  /** Tamanho fixo em colunas/linhas (modo remoto: acompanha o pty sem mexer nele). */
  resize(cols: number, rows: number): void
  focus(): void
  dispose(): void
}

const isMac = (): boolean => navigator.platform.toLowerCase().includes('mac')
// Ctrl (Cmd no mac) + clique abre; o main manda a URL ao navegador padrao.
const openOnModifier = (event: MouseEvent, uri: string): void => {
  if (isMac() ? event.metaKey : event.ctrlKey) window.open(uri)
}

export function createXterm(container: HTMLElement): XtermHandle {
  const term = new Terminal({
    linkHandler: { activate: openOnModifier },
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
  term.registerLinkProvider({
    provideLinks: (y, callback) => {
      const line = term.buffer.active.getLine(y - 1)?.translateToString(true) ?? ''
      const links = findUrls(line).map((u) => ({
        text: u.text,
        range: { start: { x: u.start + 1, y }, end: { x: u.end, y } },
        activate: openOnModifier,
      }))
      callback(links.length ? links : undefined)
    },
  })
  // Selecionar copia na hora; erro de permissao da area de transferencia e ignorado.
  term.onSelectionChange(() => {
    if (term.hasSelection())
      void navigator.clipboard?.writeText(term.getSelection()).catch(() => {})
  })
  term.attachCustomKeyEventHandler((e) => {
    const action = clipboardKeyAction({
      ctrl: e.ctrlKey,
      shift: e.shiftKey,
      alt: e.altKey,
      meta: e.metaKey,
      key: e.key,
      type: e.type,
      hasSelection: term.hasSelection(),
      platform: navigator.platform.toLowerCase().includes('mac') ? 'darwin' : 'other',
    })
    if (action === 'copy') {
      // Sem isso o 'copy' nativo do xterm roda depois, com a selecao ja limpa, e grava vazio.
      e.preventDefault()
      void navigator.clipboard?.writeText(term.getSelection()).catch(() => {})
      term.clearSelection()
      return false
    }
    if (action === 'deleteWord') {
      // ^W apaga a palavra antes do cursor no bash, no zsh e no Claude Code.
      e.preventDefault()
      term.input('\x17', true)
      return false
    }
    if (action === 'newline') {
      // ^J (LF) e nova linha no Claude Code e no Codex; Enter (\r) enviaria a mensagem.
      e.preventDefault()
      term.input('\n', true)
      return false
    }
    if (action === 'swallow') return false
    // 'paste': sem preventDefault, o navegador dispara o 'paste' que o xterm ja trata.
    return action === 'pass'
  })
  // So imagem na area de transferencia: manda ^V e o Claude Code le a imagem.
  container.addEventListener(
    'paste',
    (e) => {
      if (!isImageOnlyPaste(e.clipboardData)) return
      e.preventDefault()
      e.stopPropagation()
      term.input('\x16', true)
    },
    true,
  )
  // Soltar arquivo escreve o caminho no pty; sem o preventDefault o Electron navegaria ate ele.
  container.addEventListener('dragover', (e) => {
    if (e.dataTransfer?.types.includes('Files')) e.preventDefault()
  })
  container.addEventListener('drop', (e) => {
    const files = Array.from(e.dataTransfer?.files ?? [])
    if (!files.length) return
    e.preventDefault()
    const text = dropPathsText(files.map((f) => window.eclipse.pathForFile(f)).filter(Boolean))
    if (text) term.input(text, true)
  })
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
    resize: (cols, rows) => term.resize(cols, rows),
    focus: () => term.focus(),
    dispose: () => term.dispose(),
  }
}
