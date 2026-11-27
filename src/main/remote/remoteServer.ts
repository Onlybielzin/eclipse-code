import { createHash, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { extname, join, resolve, sep } from 'node:path'
import type { IpcCallContext, IpcEventMessage, IpcResult } from '@shared/ipc'
import type { DomainErrorCode } from '@shared/domain'
import { REMOTE_ALLOWED_COMMANDS, REMOTE_BLOCKED_EVENT_PREFIX } from '@shared/remote'
import { buildBridgeScript } from './bridgeScript'

/** Id de remetente das chamadas do celular (webContents reais sao positivos). */
export const REMOTE_SENDER_ID = -1
const COOKIE = 'eclipse_remote'
const MAX_BODY = 1_500_000
const KEEPALIVE_MS = 25_000
// Lista fixa: o navegador busca o manifest e os icones sem cookie. Nada de prefixo ou curinga.
const PUBLIC_FILES = new Set(['/manifest.webmanifest', '/icon-192.png', '/icon-512.png'])
const allowed = new Set<string>(REMOTE_ALLOWED_COMMANDS)

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
}

export interface RemoteServerOptions {
  route: (raw: unknown, context?: IpcCallContext) => Promise<IpcResult<unknown>>
  getToken: () => string
  /** Pasta do renderer construido; null = app em dev (responde 503). */
  rendererDir: string | null
}

export interface RemoteServer {
  /** Escuta em 127.0.0.1. Rejeita se a porta estiver ocupada. Devolve a porta real. */
  start(port: number): Promise<number>
  stop(): Promise<void>
  /** Manda o evento aos clientes SSE (brain.* nao sai). */
  emit(message: IpcEventMessage): void
  /** Derruba os clientes SSE (token trocado). */
  closeClients(): void
}

const digest = (s: string) => createHash('sha256').update(s).digest()
const sameSecret = (a: string, b: string) => timingSafeEqual(digest(a), digest(b))

function readCookie(req: IncomingMessage, name: string): string | null {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim()
  }
  return null
}

function send(
  res: ServerResponse,
  status: number,
  type: string,
  body: string | Buffer,
  extra = {},
) {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extra,
  })
  res.end(body)
}

const sendJson = (res: ServerResponse, value: IpcResult<unknown>) =>
  send(res, 200, 'application/json; charset=utf-8', JSON.stringify(value))

const fail = (res: ServerResponse, code: DomainErrorCode, message: string) =>
  sendJson(res, { ok: false, error: { code, message } })

const REPAIR_MESSAGE = 'Pareie de novo: abra o link de pareamento em Configurações > Celular no PC.'

const UNAUTHORIZED_PAGE = `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Eclipse Code</title><body style="font-family:sans-serif;padding:2rem"><p>Abra o link de pareamento mostrado em Configurações &gt; Celular no PC.</p></body></html>`

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((done) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY) {
        done(null)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => done(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => done(null))
  })
}

export function createRemoteServer(options: RemoteServerOptions): RemoteServer {
  const clients = new Set<ServerResponse>()
  let server: Server | null = null
  const root = options.rendererDir === null ? null : resolve(options.rendererDir)

  const authed = (req: IncomingMessage) => {
    const cookie = readCookie(req, COOKIE)
    return cookie !== null && sameSecret(cookie, options.getToken())
  }

  async function serveStatic(pathname: string, res: ServerResponse) {
    if (root === null) {
      send(res, 503, 'text/plain; charset=utf-8', 'Disponível só no app construído.')
      return
    }
    let rel: string
    try {
      rel = decodeURIComponent(pathname)
    } catch {
      send(res, 400, 'text/plain; charset=utf-8', 'Pedido inválido.')
      return
    }
    if (rel === '/' || rel === '') rel = '/index.html'
    const file = resolve(join(root, rel))
    if (rel.includes('\0') || !file.startsWith(root + sep)) {
      send(res, 404, 'text/plain; charset=utf-8', 'Não encontrado.')
      return
    }
    let data: Buffer
    try {
      data = await readFile(file)
    } catch {
      send(res, 404, 'text/plain; charset=utf-8', 'Não encontrado.')
      return
    }
    const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream'
    if (file === join(root, 'index.html')) {
      const html = data.toString('utf8')
      const tag = '<script src="/remote-bridge.js"></script>'
      const at = html.indexOf('<script')
      send(res, 200, type, at < 0 ? html + tag : html.slice(0, at) + tag + html.slice(at))
      return
    }
    send(res, 200, type, data)
  }

  async function invoke(req: IncomingMessage, res: ServerResponse) {
    if (req.method !== 'POST' || req.headers['x-eclipse-remote'] !== '1') {
      fail(res, 'forbidden', 'Pedido recusado.')
      return
    }
    const origin = req.headers.origin
    if (origin !== undefined) {
      let host = ''
      try {
        host = new URL(origin).host
      } catch {
        // Origin ilegivel: cai na recusa abaixo.
      }
      if (host === '' || host !== req.headers.host) {
        fail(res, 'forbidden', 'Origem recusada.')
        return
      }
    }
    const text = await readBody(req)
    if (text === null) {
      fail(res, 'invalid_input', 'Corpo grande demais.')
      return
    }
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      fail(res, 'invalid_input', 'Corpo não é JSON.')
      return
    }
    const channel = (body as { channel?: unknown } | null)?.channel
    if (typeof channel !== 'string' || !allowed.has(channel)) {
      fail(res, 'forbidden', 'Este comando só funciona no PC.')
      return
    }
    sendJson(res, await options.route(body, { senderId: REMOTE_SENDER_ID }))
  }

  function events(res: ServerResponse) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    res.write(': ok\n\n')
    clients.add(res)
    const timer = setInterval(() => res.write(': keepalive\n\n'), KEEPALIVE_MS)
    res.on('close', () => {
      clearInterval(timer)
      clients.delete(res)
    })
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname === '/pair') {
      const token = url.searchParams.get('token')
      if (token === null || !sameSecret(token, options.getToken())) {
        send(res, 401, 'text/html; charset=utf-8', UNAUTHORIZED_PAGE)
        return
      }
      send(res, 302, 'text/plain; charset=utf-8', '', {
        Location: '/',
        'Set-Cookie': `${COOKIE}=${options.getToken()}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=31536000`,
      })
      return
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && PUBLIC_FILES.has(url.pathname)) {
      return serveStatic(url.pathname, res)
    }
    if (!authed(req)) {
      if (url.pathname === '/api/invoke' || url.pathname === '/api/events') {
        send(
          res,
          401,
          'application/json; charset=utf-8',
          JSON.stringify({ ok: false, error: { code: 'forbidden', message: REPAIR_MESSAGE } }),
        )
        return
      }
      send(res, 401, 'text/html; charset=utf-8', UNAUTHORIZED_PAGE)
      return
    }
    if (url.pathname === '/api/invoke') return invoke(req, res)
    if (url.pathname === '/api/events') return events(res)
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(res, 405, 'text/plain; charset=utf-8', 'Método não permitido.')
      return
    }
    if (url.pathname === '/remote-bridge.js') {
      send(res, 200, MIME['.js']!, buildBridgeScript())
      return
    }
    return serveStatic(url.pathname, res)
  }

  return {
    start(port) {
      return new Promise((done, reject) => {
        const next = createServer((req, res) => {
          handle(req, res).catch(() => {
            if (!res.headersSent) send(res, 500, 'text/plain; charset=utf-8', 'Erro interno.')
            else res.end()
          })
        })
        next.once('error', reject)
        // Nunca 0.0.0.0: a Tailscale entrega pelo `tailscale serve`, que fala com o loopback.
        next.listen(port, '127.0.0.1', () => {
          next.off('error', reject)
          server = next
          done((next.address() as AddressInfo).port)
        })
      })
    },
    async stop() {
      this.closeClients()
      const current = server
      server = null
      if (current) {
        await new Promise<void>((done) => {
          current.close(() => done())
          current.closeAllConnections()
        })
      }
    },
    emit(message) {
      if (message.channel.startsWith(REMOTE_BLOCKED_EVENT_PREFIX)) return
      if (clients.size === 0) return
      const frame = `data: ${JSON.stringify(message)}\n\n`
      for (const client of clients) client.write(frame)
    },
    closeClients() {
      for (const client of clients) client.end()
      clients.clear()
    },
  }
}
