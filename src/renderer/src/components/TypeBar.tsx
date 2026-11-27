import { useState, type FormEvent } from 'react'
import { useStore } from '../store/context'

const KEYS: { label: string; aria: string; data: string }[] = [
  { label: 'Esc', aria: 'Esc', data: '\x1b' },
  { label: '↑', aria: 'Subir', data: '\x1b[A' },
  { label: '↓', aria: 'Descer', data: '\x1b[B' },
  { label: 'Enter', aria: 'Enter', data: '\r' },
]

/**
 * Barra de digitar do celular: o xterm fica so de leitura e tudo o que o vings escreve
 * entra aqui. O texto vai primeiro e o Enter ('\r') numa segunda chamada, como uma colagem.
 */
export function TypeBar({ sessionId }: { sessionId: string | null }) {
  const store = useStore()
  const [text, setText] = useState('')
  const write = (data: string) =>
    sessionId ? store.api.invoke('terminal.write', { sessionId, data }) : Promise.resolve()

  const send = async (event: FormEvent) => {
    event.preventDefault()
    if (!text) return
    const value = text
    setText('')
    await write(value)
    await write('\r')
  }

  const interrupt = () => {
    if (
      window.confirm('Mandar Ctrl+C para o terminal? Isso interrompe o que o agente está fazendo.')
    )
      void write('\x03')
  }

  return (
    <form className="type-bar" onSubmit={(e) => void send(e)}>
      <div className="type-row">
        <input
          type="text"
          aria-label="Texto para o terminal"
          placeholder="Escreva para o Líder"
          autoComplete="off"
          autoCapitalize="off"
          enterKeyHint="send"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <button type="submit" disabled={!sessionId || !text}>
          Enviar
        </button>
      </div>
      <div className="type-keys">
        {KEYS.map((k) => (
          <button
            key={k.aria}
            type="button"
            aria-label={k.aria}
            disabled={!sessionId}
            onClick={() => void write(k.data)}
          >
            {k.label}
          </button>
        ))}
        <button type="button" className="danger" disabled={!sessionId} onClick={interrupt}>
          Ctrl+C
        </button>
      </div>
    </form>
  )
}
