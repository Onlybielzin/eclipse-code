import { useEffect, useRef } from 'react'
import type { WhatsNew } from '@shared/ipc'
import { useStore } from '../store/context'

/** Janela "Novidades da versão X": linhas "- " viram lista; o resto vira parágrafo. Sem HTML cru. */
export function WhatsNewModal({ whatsNew }: { whatsNew: WhatsNew }) {
  const store = useStore()
  const close = () => void store.dismissWhatsNew()
  const button = useRef<HTMLButtonElement>(null)
  useEffect(() => button.current?.focus(), [])

  const lines = whatsNew.notes.split('\n').filter((l) => l.trim() !== '')
  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="whatsnew-title">
        <header className="modal-head">
          <h2 id="whatsnew-title">Novidades da versão {whatsNew.version}</h2>
        </header>
        <div className="modal-field">
          {lines.map((line, i) =>
            /^[-*] /.test(line) ? (
              <p key={i}>• {line.slice(2)}</p>
            ) : (
              <p key={i}>{line.replace(/^#+\s*/, '')}</p>
            ),
          )}
        </div>
        <footer className="modal-actions">
          <button ref={button} type="button" className="primary" onClick={close}>
            Entendi
          </button>
        </footer>
      </div>
    </div>
  )
}
