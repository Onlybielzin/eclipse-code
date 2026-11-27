import { useEffect, useState } from 'react'
import type { EclipseApi } from '@shared/ipc'
import { REMOTE_MAX_PORT, REMOTE_MIN_PORT, type RemoteStatus } from '@shared/remote'

/** Seção "Celular" de Configurações: liga o servidor remoto do main e mostra o pareamento. */
export function RemoteSettings({ api }: { api: EclipseApi }) {
  const [status, setStatus] = useState<RemoteStatus | null>(null)
  const [enabled, setEnabled] = useState(false)
  const [port, setPort] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [ntfyEnabled, setNtfyEnabled] = useState(false)
  const [ntfyServer, setNtfyServer] = useState('')
  const [ntfyToken, setNtfyToken] = useState('')
  const [publicUrl, setPublicUrl] = useState('')
  const [topicCopied, setTopicCopied] = useState(false)
  const [testNote, setTestNote] = useState<string | null>(null)

  const apply = (next: RemoteStatus) => {
    setStatus(next)
    setEnabled(next.enabled)
    setPort(String(next.port))
    setNtfyEnabled(next.ntfyEnabled)
    setNtfyServer(next.ntfyServer)
    setNtfyToken('')
    setPublicUrl(next.publicUrl ?? '')
  }

  useEffect(() => {
    let alive = true
    void api.invoke('remote.get', {}).then((r) => {
      if (!alive) return
      if (r.ok) apply(r.value)
      else setError(r.error.message)
    })
    return () => {
      alive = false
    }
  }, [api])

  const portNumber = Number(port)
  const portOk =
    Number.isInteger(portNumber) && portNumber >= REMOTE_MIN_PORT && portNumber <= REMOTE_MAX_PORT
  const dirty =
    status !== null &&
    (enabled !== status.enabled ||
      portNumber !== status.port ||
      ntfyEnabled !== status.ntfyEnabled ||
      ntfyServer.trim() !== status.ntfyServer ||
      ntfyToken !== '' ||
      (publicUrl.trim() || null) !== status.publicUrl)

  async function testNotify() {
    setBusy(true)
    setError(null)
    setTestNote(null)
    const r = await api.invoke('remote.testNotify', {})
    setBusy(false)
    if (r.ok) setTestNote('Aviso de teste enviado. Confira o celular.')
    else setError(r.error.message)
  }

  async function run(call: () => ReturnType<EclipseApi['invoke']>) {
    setBusy(true)
    setError(null)
    const r = await call()
    setBusy(false)
    if (r.ok) apply(r.value as RemoteStatus)
    else setError(r.error.message)
  }

  const pair = status ? `https://<nome-do-pc>.<tailnet>.ts.net${status.pairUrlPath}` : ''
  const state = !status
    ? 'Carregando...'
    : status.error
      ? status.error
      : status.running
        ? `Ligado em 127.0.0.1:${status.port}`
        : 'Desligado'

  return (
    <section id="celular" aria-labelledby="h-celular">
      <header>
        <h2 id="h-celular">Celular</h2>
        <p>
          Use o Eclipse Code pelo celular como página web, pela Tailscale. O app fica só neste PC; o
          celular mostra a tela.
        </p>
      </header>
      <div className="settings-card">
        <div className="settings-row">
          <div>
            <div className="lab">Ligar acesso pelo celular</div>
            <div className="exp">O servidor escuta só em 127.0.0.1 e exige o token.</div>
          </div>
          <div className="ctl">
            <label className="settings-switch">
              <input
                type="checkbox"
                role="switch"
                aria-label="Ligar acesso pelo celular"
                checked={enabled}
                disabled={!status || busy}
                onChange={(e) => setEnabled(e.target.checked)}
              />
              <span>{enabled ? 'Ligado' : 'Desligado'}</span>
            </label>
          </div>
        </div>
        <div className="settings-row">
          <div>
            <div className="lab">Porta</div>
            <div className="exp" role="status" aria-live="polite">
              {state}
            </div>
          </div>
          <div className="ctl">
            <input
              className="field num"
              type="number"
              min={REMOTE_MIN_PORT}
              max={REMOTE_MAX_PORT}
              aria-label="Porta"
              value={port}
              disabled={!status || busy}
              onChange={(e) => setPort(e.target.value)}
            />
          </div>
        </div>
        {status && (
          <div className="settings-row">
            <div>
              <ol className="exp">
                <li>
                  No PC, rode uma vez: <code>tailscale serve --bg {status.port}</code>
                </li>
                <li>
                  No celular, abra <code>{pair}</code>
                </li>
                <li>No Chrome do celular, use Adicionar à tela inicial.</li>
              </ol>
              <p className="exp">
                Quem tiver este link controla os agentes e o terminal deste PC. Se perder o celular,
                use Trocar token.
              </p>
            </div>
            <div className="ctl">
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  void navigator.clipboard
                    ?.writeText(status.pairUrlPath)
                    .then(() => setCopied(true))
                }}
              >
                {copied ? 'Copiado' : 'Copiar caminho'}
              </button>
            </div>
          </div>
        )}
        <div className="settings-row">
          <div>
            <div className="lab">Aviso no celular</div>
            <div className="exp">
              Manda um aviso pelo ntfy quando uma tarefa pede você ou termina. O texto das perguntas
              e dos avisos vai para o servidor ntfy.
            </div>
          </div>
          <div className="ctl">
            <label className="settings-switch">
              <input
                type="checkbox"
                role="switch"
                aria-label="Ligar aviso no celular"
                checked={ntfyEnabled}
                disabled={!status || busy}
                onChange={(e) => setNtfyEnabled(e.target.checked)}
              />
              <span>{ntfyEnabled ? 'Ligado' : 'Desligado'}</span>
            </label>
          </div>
        </div>
        <div className="settings-row">
          <div>
            <div className="lab">Servidor ntfy</div>
          </div>
          <div className="ctl">
            <input
              className="field"
              type="url"
              aria-label="Servidor ntfy"
              value={ntfyServer}
              disabled={!status || busy}
              onChange={(e) => setNtfyServer(e.target.value)}
            />
          </div>
        </div>
        {status && (
          <div className="settings-row">
            <div>
              <div className="lab">Tópico</div>
              <div className="exp">
                <code>{status.ntfyTopic}</code>
                <br />
                No app ntfy do celular, assine este tópico no servidor acima.
              </div>
            </div>
            <div className="ctl">
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  void navigator.clipboard
                    ?.writeText(status.ntfyTopic)
                    .then(() => setTopicCopied(true))
                }}
              >
                {topicCopied ? 'Copiado' : 'Copiar'}
              </button>
            </div>
          </div>
        )}
        <div className="settings-row">
          <div>
            <div className="lab">Token do ntfy (opcional)</div>
            <div className="exp">
              {status?.ntfyTokenSet
                ? 'Há um token salvo. Deixe vazio para mantê-lo.'
                : 'Só para servidor que exige login.'}
            </div>
          </div>
          <div className="ctl">
            <input
              className="field"
              type="password"
              autoComplete="off"
              aria-label="Token do ntfy"
              value={ntfyToken}
              disabled={!status || busy}
              onChange={(e) => setNtfyToken(e.target.value)}
            />
            {status?.ntfyTokenSet && (
              <button
                type="button"
                className="ghost"
                disabled={busy}
                onClick={() =>
                  void run(() =>
                    api.invoke('remote.save', {
                      enabled: status.enabled,
                      port: status.port,
                      removeNtfyToken: true,
                    }),
                  )
                }
              >
                Remover token
              </button>
            )}
          </div>
        </div>
        <div className="settings-row">
          <div>
            <div className="lab">Endereço público</div>
            <div className="exp">O aviso abre este endereço ao ser tocado.</div>
          </div>
          <div className="ctl">
            <input
              className="field"
              type="url"
              aria-label="Endereço público"
              placeholder="https://seu-pc.sua-tailnet.ts.net"
              value={publicUrl}
              disabled={!status || busy}
              onChange={(e) => setPublicUrl(e.target.value)}
            />
          </div>
        </div>
        {testNote && (
          <p className="exp" role="status">
            {testNote}
          </p>
        )}
        {error && (
          <p className="modal-note bad settings-error" role="alert">
            {error}
          </p>
        )}
        <div className="settings-foot">
          <button
            type="button"
            className="ghost"
            disabled={!status || busy}
            onClick={() => void run(() => api.invoke('remote.rotateToken', {}))}
          >
            Trocar token
          </button>
          <button
            type="button"
            className="ghost"
            disabled={!status || busy || dirty}
            title={dirty ? 'Salve antes de testar.' : undefined}
            onClick={() => void testNotify()}
          >
            Mandar aviso de teste
          </button>
          <button
            type="button"
            className="primary"
            disabled={!status || busy || !dirty || !portOk}
            onClick={() =>
              void run(() =>
                api.invoke('remote.save', {
                  enabled,
                  port: portNumber,
                  ntfyEnabled,
                  ntfyServer: ntfyServer.trim(),
                  ...(ntfyToken !== '' && { ntfyToken }),
                  publicUrl: publicUrl.trim() || null,
                }),
              )
            }
          >
            Salvar celular
          </button>
        </div>
      </div>
    </section>
  )
}
