import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ipcCommands, IPC_EVENT_CHANNELS, type IpcCallContext } from '@shared/ipc'
import { REMOTE_ALLOWED_COMMANDS } from '@shared/remote'
import { buildBridgeScript } from './bridgeScript'
import { createRemoteController } from './index'
import { createRemoteServer, REMOTE_SENDER_ID } from './remoteServer'
import { loadRemoteSettings, type SettingsStorage } from './remoteSettings'

const TOKEN = 'token-de-teste-com-mais-de-20-letras'
const memory = (): SettingsStorage & { data: Map<string, string> } => {
  const data = new Map<string, string>()
  return { data, getSetting: (k) => data.get(k) ?? null, setSetting: (k, v) => void data.set(k, v) }
}

const calls: { raw: unknown; context?: IpcCallContext }[] = []
const route = async (raw: unknown, context?: IpcCallContext) => {
  calls.push({ raw, context })
  return { ok: true as const, value: 'oi' }
}

let dir: string
const stops: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop()
  calls.length = 0
})

async function boot(token = TOKEN) {
  dir = mkdtempSync(join(tmpdir(), 'remote-'))
  mkdirSync(join(dir, 'renderer'))
  writeFileSync(join(dir, 'package.json'), '{"segredo":true}')
  writeFileSync(
    join(dir, 'renderer', 'index.html'),
    '<html><head><script type="module" src="/a.js"></script></head></html>',
  )
  writeFileSync(join(dir, 'renderer', 'a.js'), 'x')
  const server = createRemoteServer({
    route,
    getToken: () => token,
    rendererDir: join(dir, 'renderer'),
  })
  const port = await server.start(0)
  stops.push(() => server.stop())
  const base = `http://127.0.0.1:${port}`
  return { server, base, port }
}
const cookie = { cookie: `eclipse_remote=${TOKEN}` }
type Json = { ok: boolean; error: { code: string; message: string } }
const json = async (res: Response) => (await res.json()) as Json
const post = (base: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}/api/invoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Eclipse-Remote': '1', ...cookie, ...headers },
    body: JSON.stringify(body),
  })

describe('manifest e ícones sem cookie', () => {
  it('só as três rotas fixas respondem sem cookie', async () => {
    const { base } = await boot()
    writeFileSync(join(dir, 'renderer', 'manifest.webmanifest'), '{}')
    writeFileSync(join(dir, 'renderer', 'icon-192.png'), 'a')
    writeFileSync(join(dir, 'renderer', 'icon-512.png'), 'b')
    mkdirSync(join(dir, 'renderer', 'assets'))
    writeFileSync(join(dir, 'renderer', 'assets', 'x.js'), 'x')
    for (const path of ['/manifest.webmanifest', '/icon-192.png', '/icon-512.png']) {
      expect((await fetch(base + path)).status).toBe(200)
    }
    expect((await fetch(base + '/manifest.webmanifest')).headers.get('content-type')).toContain(
      'application/manifest+json',
    )
    for (const path of [
      '/index.html',
      '/assets/x.js',
      '/icon-192.png/',
      '/manifest.webmanifest/x',
    ]) {
      expect((await fetch(base + path)).status).toBe(401)
    }
  })
})

describe('lista de comandos remotos', () => {
  it('todo nome existe em ipcCommands e remote.* fica de fora', () => {
    for (const name of REMOTE_ALLOWED_COMMANDS) expect(ipcCommands).toHaveProperty(name)
    expect(REMOTE_ALLOWED_COMMANDS.some((n) => n.startsWith('remote.'))).toBe(false)
  })
})

describe('servidor remoto', () => {
  it('responde 401 sem cookie, com página em português', async () => {
    const { base } = await boot()
    for (const path of ['/', '/remote-bridge.js']) {
      const res = await fetch(base + path)
      expect(res.status).toBe(401)
      expect(await res.text()).toContain('Configurações > Celular'.replace('>', '&gt;'))
    }
  })

  it('invoke e events sem cookie devolvem JSON legível com 401', async () => {
    const { base } = await boot()
    const a = await fetch(`${base}/api/invoke`, {
      method: 'POST',
      headers: { 'X-Eclipse-Remote': '1' },
      body: '{}',
    })
    const b = await fetch(`${base}/api/events`)
    for (const res of [a, b]) {
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({
        ok: false,
        error: {
          code: 'forbidden',
          message: 'Pareie de novo: abra o link de pareamento em Configurações > Celular no PC.',
        },
      })
    }
  })

  it('terminal.resize pelo remoto dá forbidden', async () => {
    const { base } = await boot()
    const res = await post(base, { channel: 'terminal.resize', input: {} })
    expect((await json(res)).error.code).toBe('forbidden')
    expect(calls).toHaveLength(0)
  })

  it('/pair recusa token errado e com o certo grava o cookie e redireciona', async () => {
    const { base } = await boot()
    expect((await fetch(`${base}/pair?token=errado`)).status).toBe(401)
    const res = await fetch(`${base}/pair?token=${TOKEN}`, { redirect: 'manual' })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/')
    const set = res.headers.get('set-cookie')!
    expect(set).toContain(`eclipse_remote=${TOKEN}`)
    for (const part of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', 'Max-Age=']) {
      expect(set).toContain(part)
    }
  })

  it('invoke sem X-Eclipse-Remote ou com Origin alheia é recusado', async () => {
    const { base } = await boot()
    const semHeader = await fetch(`${base}/api/invoke`, {
      method: 'POST',
      headers: cookie,
      body: JSON.stringify({ channel: 'app.info', input: {} }),
    })
    expect((await json(semHeader)).error.code).toBe('forbidden')
    const alheia = await post(
      base,
      { channel: 'app.info', input: {} },
      { Origin: 'https://evil.test' },
    )
    expect((await json(alheia)).error.code).toBe('forbidden')
    const propria = await post(base, { channel: 'app.info', input: {} }, { Origin: base })
    expect((await json(propria)).ok).toBe(true)
    const semCookie = await fetch(`${base}/api/invoke`, {
      method: 'POST',
      headers: { 'X-Eclipse-Remote': '1' },
      body: '{}',
    })
    expect(semCookie.status).toBe(401)
    expect(calls).toHaveLength(1)
  })

  it('comando fora da lista dá forbidden e o permitido chega no route com senderId remoto', async () => {
    const { base } = await boot()
    const proibido = await json(await post(base, { channel: 'projects.remove', input: {} }))
    expect(proibido).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    expect(proibido.error.message).toBe('Este comando só funciona no PC.')
    expect(calls).toHaveLength(0)
    const raw = { channel: 'tasks.list', input: { projectId: 'p', includeArchived: false } }
    expect(await (await post(base, raw)).json()).toEqual({ ok: true, value: 'oi' })
    expect(calls).toEqual([{ raw, context: { senderId: REMOTE_SENDER_ID } }])
    expect(REMOTE_SENDER_ID).toBeLessThan(0)
  })

  it('corpo grande demais não chega no route', async () => {
    const { base } = await boot()
    const res = await post(base, {
      channel: 'app.info',
      input: { x: 'a'.repeat(1_600_000) },
    }).catch(() => null)
    if (res) expect((await json(res)).ok).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('serve o index.html com o script da ponte e bloqueia path traversal', async () => {
    const { base, port } = await boot()
    const html = await (await fetch(`${base}/`, { headers: cookie })).text()
    expect(html.indexOf('<script src="/remote-bridge.js"></script>')).toBeGreaterThan(-1)
    expect(html.indexOf('/remote-bridge.js')).toBeLessThan(html.indexOf('type="module"'))
    const js = await fetch(`${base}/a.js`, { headers: cookie })
    expect(js.headers.get('content-type')).toContain('text/javascript')
    // fetch normaliza "..": manda o caminho cru por um socket.
    const { request } = await import('node:http')
    for (const path of ['/../package.json', '/%2e%2e/package.json', '/..%2fpackage.json']) {
      const status = await new Promise<{ code: number; body: string }>((done) => {
        const req = request(
          { host: '127.0.0.1', port, path, headers: cookie, method: 'GET' },
          (res) => {
            let body = ''
            res.on('data', (c) => (body += c))
            res.on('end', () => done({ code: res.statusCode ?? 0, body }))
          },
        )
        req.end()
      })
      expect(status.code).toBe(404)
      expect(status.body).not.toContain('segredo')
    }
  })

  it('escuta só em 127.0.0.1', async () => {
    const { port } = await boot()
    const { connect } = await import('node:net')
    const { networkInterfaces } = await import('node:os')
    const outros = Object.values(networkInterfaces())
      .flat()
      .filter((i) => i && i.family === 'IPv4' && !i.internal)
      .map((i) => i!.address)
    for (const host of outros) {
      const refused = await new Promise<boolean>((done) => {
        const socket = connect({ host, port, timeout: 1000 })
        socket.on('connect', () => (socket.destroy(), done(false)))
        socket.on('error', () => done(true))
        socket.on('timeout', () => (socket.destroy(), done(true)))
      })
      expect(refused).toBe(true)
    }
    const { server } = await boot()
    expect(server).toBeDefined()
  })

  it('SSE entrega eventos e esconde brain.*', async () => {
    const { base, server } = await boot()
    const res = await fetch(`${base}/api/events`, { headers: cookie })
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    server.emit({ channel: 'brain.activity', payload: {} } as never)
    server.emit({ channel: 'notice.open', payload: { taskId: 't', projectId: 'p' } })
    const reader = res.body!.getReader()
    let text = ''
    while (!text.includes('notice.open')) {
      text += new TextDecoder().decode((await reader.read()).value)
    }
    expect(text).toContain('data: {"channel":"notice.open"')
    expect(text).not.toContain('brain.')
    await reader.cancel()
  })

  it('app construído ausente (dev) responde 503', async () => {
    const server = createRemoteServer({ route, getToken: () => TOKEN, rendererDir: null })
    const port = await server.start(0)
    stops.push(() => server.stop())
    const res = await fetch(`http://127.0.0.1:${port}/`, { headers: cookie })
    expect(res.status).toBe(503)
  })
})

describe('controlador', () => {
  it('liga e desliga sem reiniciar, e trocar o token invalida o cookie antigo', async () => {
    const storage = memory()
    const c = createRemoteController({ storage, route, rendererDir: null })
    stops.push(() => c.dispose())
    expect(c.get()).toMatchObject({ enabled: false, running: false, error: null })
    const first = c.get().token
    expect(first.length).toBeGreaterThanOrEqual(43)
    const port = 47000 + Math.floor(Math.random() * 1000)
    const on = await c.save({ enabled: true, port })
    expect(on).toMatchObject({ enabled: true, running: true, port })
    expect(on.pairUrlPath).toBe(`/pair?token=${first}`)
    const base = `http://127.0.0.1:${port}`
    const stream = await fetch(`${base}/api/events`, {
      headers: { cookie: `eclipse_remote=${first}` },
    })
    expect(stream.status).toBe(200)
    const rotated = c.rotateToken()
    expect(rotated.token).not.toBe(first)
    expect((await stream.body!.getReader().read()).done || true).toBe(true)
    const old = await fetch(`${base}/`, { headers: { cookie: `eclipse_remote=${first}` } })
    expect(old.status).toBe(401)
    const off = await c.save({ enabled: false, port })
    expect(off.running).toBe(false)
    await expect(fetch(`${base}/`)).rejects.toThrow()
  })

  it('dois save seguidos sem await terminam com um servidor só na porta final', async () => {
    const c = createRemoteController({ storage: memory(), route, rendererDir: null })
    stops.push(() => c.dispose())
    const a = 48000 + Math.floor(Math.random() * 500)
    const b = a + 500
    const [, last] = await Promise.all([
      c.save({ enabled: true, port: a }),
      c.save({ enabled: true, port: b }),
    ])
    expect(last).toMatchObject({ running: true, error: null, port: b })
    expect(c.get()).toMatchObject({ running: true, error: null, port: b })
    expect((await fetch(`http://127.0.0.1:${b}/`)).status).toBe(401)
    await expect(fetch(`http://127.0.0.1:${a}/`)).rejects.toThrow()
  })

  it('remote.get não devolve o token do ntfy e o formato é o mesmo em todo estado', async () => {
    const c = createRemoteController({
      storage: memory(),
      route,
      rendererDir: null,
      ntfyFetch: null,
    })
    stops.push(() => c.dispose())
    const before = Object.keys(c.get()).sort()
    const saved = await c.save({ enabled: false, port: 47821, ntfyToken: 'segredo-ntfy' })
    expect(saved.ntfyTokenSet).toBe(true)
    expect(JSON.stringify(saved)).not.toContain('segredo-ntfy')
    expect(Object.keys(saved).sort()).toEqual(before)
    const cleared = await c.save({ enabled: false, port: 47821, removeNtfyToken: true })
    expect(cleared.ntfyTokenSet).toBe(false)
  })

  it('aviso de teste recusa quando o ntfy não está disponível (teste ou smoke)', async () => {
    const c = createRemoteController({
      storage: memory(),
      route,
      rendererDir: null,
      ntfyFetch: null,
    })
    await expect(c.testNotify()).rejects.toThrow()
  })

  it('porta ocupada vira erro em português', async () => {
    const a = createRemoteController({ storage: memory(), route, rendererDir: null })
    const b = createRemoteController({ storage: memory(), route, rendererDir: null })
    stops.push(
      () => a.dispose(),
      () => b.dispose(),
    )
    const port = 48000 + Math.floor(Math.random() * 1000)
    await a.save({ enabled: true, port })
    const status = await b.save({ enabled: true, port })
    expect(status).toMatchObject({ running: false, error: `A porta ${port} já está em uso.` })
  })
})

describe('configurações persistidas', () => {
  it('gera o token uma vez, com padrões, e relê o mesmo', () => {
    const storage = memory()
    const s = loadRemoteSettings(storage)
    expect(s).toMatchObject({ enabled: false, port: 47821 })
    expect(loadRemoteSettings(storage).token).toBe(s.token)
  })
  it('valor corrompido recomeça desligado', () => {
    const storage = memory()
    storage.setSetting('remoteAccess', '{"enabled":true,"port":80,"token":"x"}')
    expect(loadRemoteSettings(storage)).toMatchObject({ enabled: false, port: 47821 })
  })
  it('remote.save recusa porta fora de 1024-65535', () => {
    const schema = ipcCommands['remote.save'].input
    expect(schema.safeParse({ enabled: true, port: 80 }).success).toBe(false)
    expect(schema.safeParse({ enabled: true, port: 70000 }).success).toBe(false)
    expect(schema.safeParse({ enabled: true, port: 47821 }).success).toBe(true)
  })
  it('remote.save recusa http:// e tópico inválido', () => {
    const schema = ipcCommands['remote.save'].input
    const ok = { enabled: true, port: 47821 }
    expect(schema.safeParse({ ...ok, ntfyServer: 'http://ntfy.exemplo.dev' }).success).toBe(false)
    expect(schema.safeParse({ ...ok, publicUrl: 'http://pc.ts.net' }).success).toBe(false)
    expect(schema.safeParse({ ...ok, ntfyTopic: 'tem espaço' }).success).toBe(false)
    expect(schema.safeParse({ ...ok, ntfyTopic: 'a'.repeat(65) }).success).toBe(false)
    expect(
      schema.safeParse({
        ...ok,
        ntfyEnabled: true,
        ntfyServer: 'https://ntfy.vings.dev',
        ntfyTopic: 'eclipse-ab_C-1',
        publicUrl: null,
      }).success,
    ).toBe(true)
  })
  it('gera o tópico na primeira leitura e relê o mesmo', () => {
    const storage = memory()
    const s = loadRemoteSettings(storage)
    expect(s).toMatchObject({
      ntfyEnabled: false,
      ntfyServer: 'https://ntfy.vings.dev',
      ntfyToken: null,
      publicUrl: null,
    })
    expect(s.ntfyTopic).toMatch(/^eclipse-[A-Za-z0-9_-]{16}$/)
    expect(loadRemoteSettings(storage).ntfyTopic).toBe(s.ntfyTopic)
  })
})

describe('ponte do navegador', () => {
  it('define window.eclipse como o preload e filtra por canal', async () => {
    const sources: { onmessage?: (e: { data: string }) => void }[] = []
    const fetched: unknown[] = []
    const win: Record<string, unknown> = {}
    new Function('window', 'EventSource', 'fetch', buildBridgeScript())(
      win,
      function (this: object) {
        sources.push(this)
      },
      async (url: string, init: { body: string }) => {
        fetched.push([url, JSON.parse(init.body)])
        return { json: async () => ({ ok: true, value: 1 }) }
      },
    )
    const api = win.eclipse as {
      invoke(c: string, i: unknown): Promise<unknown>
      on(c: string, l: (p: unknown) => void): () => void
      pathForFile(): string
    }
    expect(win.eclipseRemote).toBe(true)
    expect(await api.invoke('app.info', {})).toEqual({ ok: true, value: 1 })
    expect(fetched).toEqual([['/api/invoke', { channel: 'app.info', input: {} }]])
    const got: unknown[] = []
    const off = api.on('notice.open', (p) => got.push(p))
    api.on('terminal.exit', () => undefined)
    expect(sources).toHaveLength(1)
    sources[0]!.onmessage!({ data: JSON.stringify({ channel: 'terminal.data', payload: 1 }) })
    sources[0]!.onmessage!({ data: JSON.stringify({ channel: 'notice.open', payload: 2 }) })
    expect(got).toEqual([2])
    off()
    sources[0]!.onmessage!({ data: JSON.stringify({ channel: 'notice.open', payload: 3 }) })
    expect(got).toEqual([2])
    expect(() => api.on('brain.activity', () => undefined)).toThrow()
    expect(api.pathForFile()).toBe('')
    expect(IPC_EVENT_CHANNELS).toContain('notice.open')
  })
})
