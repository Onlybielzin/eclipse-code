import { useEffect, useRef } from 'react'
import { useStore } from '../store/context'
import { createXterm } from '../terminal/createXterm'

export interface PtyOpened {
  /** Id usado em terminal.write/resize e nos eventos terminal.data/exit. */
  sessionId: string
  alive: boolean
  cols: number
  rows: number
  /** Saida recente do main, escrita no xterm antes dos eventos novos. */
  scrollback: string
}

interface Props {
  /** Abre ou anexa o processo e devolve o retrato. Roda uma vez por montagem (use `key`). */
  open: () => Promise<PtyOpened>
  onOpened?: (opened: PtyOpened) => void
  onExit?: (exitCode: number | null) => void
  onError?: (message: string) => void
  /** false = so leitura (log de uma execucao que ja parou). */
  interactive?: boolean
}

/**
 * Miolo de xterm ligado a um pty do main. Os eventos terminal.data chegam antes da
 * resposta de `open` quando foram emitidos antes do retrato; o retrato os inclui. Por isso
 * descarta o que chega ate `open` responder, e escreve scrollback e eventos novos depois.
 */
export function PtyTerminal({ open, onOpened, onExit, onError, interactive = true }: Props) {
  const store = useStore()
  const hostRef = useRef<HTMLDivElement | null>(null)
  const latest = useRef({ open, onOpened, onExit, onError })
  latest.current = { open, onOpened, onExit, onError }

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const api = store.api
    let disposed = false
    let sessionId: string | null = null
    let lastSize = { cols: 0, rows: 0 }
    const term = createXterm(host)

    const offData = api.on('terminal.data', (p) => {
      if (p.sessionId === sessionId) term.write(p.data)
    })
    const offExit = api.on('terminal.exit', (p) => {
      if (p.sessionId === sessionId) latest.current.onExit?.(p.exitCode)
    })
    const offInput = term.onData((data) => {
      if (sessionId === null || !interactive) return
      void api.invoke('terminal.write', { sessionId, data })
    })

    const syncSize = () => {
      const size = term.fit()
      if (!size || sessionId === null || !interactive) return
      if (size.cols === lastSize.cols && size.rows === lastSize.rows) return
      if (size.cols < 2 || size.rows < 1) return
      lastSize = size
      void api.invoke('terminal.resize', { sessionId, cols: size.cols, rows: size.rows })
    }
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => syncSize())
    observer?.observe(host)

    void (async () => {
      try {
        const opened = await latest.current.open()
        if (disposed) return
        sessionId = opened.sessionId
        if (opened.scrollback) term.write(opened.scrollback)
        lastSize = { cols: opened.cols, rows: opened.rows }
        latest.current.onOpened?.(opened)
        syncSize()
        if (interactive) term.focus()
      } catch (error) {
        if (!disposed)
          latest.current.onError?.(error instanceof Error ? error.message : String(error))
      }
    })()

    return () => {
      disposed = true
      observer?.disconnect()
      offData()
      offExit()
      offInput()
      term.dispose()
    }
  }, [store, interactive])

  return <div className="term-host" ref={hostRef} />
}
