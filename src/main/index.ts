import { app, BrowserWindow, dialog, ipcMain, safeStorage, type OpenDialogOptions } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { APP_ID, APP_PRODUCT_NAME, ENV } from '@shared/app'
import {
  IPC_EVENT_CHANNEL,
  IPC_INVOKE_CHANNEL,
  type AppInfo,
  type IpcEventMessage,
  type PickedFolder,
} from '@shared/ipc'
import {
  createIpcHandlers,
  createIpcRouter,
  resolveAppPaths,
  runSmokeChecks,
  startAppServices,
  type AppLogger,
  type AppServices,
} from './app'
import { autoUpdater } from 'electron-updater'
import { createUpdater, createWhatsNew } from './app/updater'
import { ensureNodePtySpawnHelperExecutable } from './terminal'

// Pasta de dados propria: nunca a do app antigo. Precisa vir antes de 'ready'.
// --user-data-dir (switch do Chromium) troca a pasta inteira, banco e socket inclusive.
const paths = resolveAppPaths(
  process.env,
  undefined,
  app.commandLine.getSwitchValue('user-data-dir') || undefined,
)
app.setName(APP_PRODUCT_NAME)
app.setPath('userData', paths.userData)

/** --smoke: sobe tudo sem mostrar janela, confere as pecas nativas e sai com 0 ou 1. */
const isSmokeRun = process.argv.includes('--smoke')
const isTestRun = process.env[ENV.runtime] === 'test' || isSmokeRun

const log: AppLogger = {
  info: (message, meta) => console.info(`[eclipse] ${message}`, meta ?? ''),
  warn: (message, meta) => console.warn(`[eclipse] ${message}`, meta ?? ''),
  error: (message, meta) => console.error(`[eclipse] ${message}`, meta ?? ''),
}

/** Janelas do app: so elas falam com o main. */
const windows = new Set<number>()
/** Solta o que a janela assinou no main (ligado em boot). */
let releaseWindow: (id: number) => void = () => {}
let updater: ReturnType<typeof createUpdater> | null = null

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1400,
    height: 900,
    // Testes nunca mostram janela no monitor do usuario.
    show: false,
    title: APP_PRODUCT_NAME,
    backgroundColor: '#0e1211',
    // Icone da janela (X11 e barra de tarefas); no Wayland vale o Icon= do .desktop.
    icon: app.isPackaged
      ? join(process.resourcesPath, 'icon.png')
      : join(__dirname, '../../resources/icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })
  const id = window.webContents.id
  windows.add(id)
  window.on('closed', () => windows.delete(id))
  // Recarregar ou fechar a janela nao avisa a tela: o main solta as assinaturas dela.
  window.webContents.on('destroyed', () => releaseWindow(id))
  window.webContents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) releaseWindow(id)
  })
  if (!isTestRun) window.once('ready-to-show', () => window.show())

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) void window.loadURL(devUrl)
  else void window.loadFile(join(__dirname, '../renderer/index.html'))
  return window
}

async function boot(): Promise<AppServices> {
  ensureNodePtySpawnHelperExecutable()
  const services = await startAppServices({
    paths,
    // Dentro do app.asar no app empacotado: o Electron com ELECTRON_RUN_AS_NODE le o asar.
    mcpServerScript: join(__dirname, 'mcp-server.js'),
    // Primeira partida: projetos e times do app antigo (produção, depois o perfil de dev).
    // O smoke e os testes partem de um banco vazio de verdade.
    legacyDatabases:
      isSmokeRun || process.env.ECLIPSE_CODE_ENV === 'test'
        ? []
        : [
            join(homedir(), '.config', 'eclipse-code', 'eclipse-code.db'),
            join(homedir(), '.config', 'eclipse-code-dev', 'eclipse-code.db'),
          ],
    brainCipher: safeStorage,
    log,
  })
  releaseWindow = (id) => services.brain.unsubscribe(id)
  const emitToWindows = (message: IpcEventMessage) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed() && windows.has(window.webContents.id)) {
        window.webContents.send(IPC_EVENT_CHANNEL, message)
      }
    }
  }
  updater = createUpdater({
    autoUpdater,
    enabled: app.isPackaged && !isTestRun,
    emit: emitToWindows,
    log,
  })
  updater.start()
  const whatsNew = createWhatsNew({
    version: () => app.getVersion(),
    readChangelog: () => {
      // Empacotado: extraResources; em dev: o da raiz do repo.
      const file = app.isPackaged
        ? join(process.resourcesPath, 'CHANGELOG.md')
        : join(__dirname, '../../CHANGELOG.md')
      return existsSync(file) ? readFileSync(file, 'utf8') : null
    },
    getSeen: () => services.tasks.getLastSeenVersion(),
    setSeen: (version) => services.tasks.saveLastSeenVersion(version),
  })
  const route = createIpcRouter({
    ...createIpcHandlers(services),
    'projects.pickFolder': async (): Promise<PickedFolder | null> => {
      const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      const options: OpenDialogOptions = {
        title: 'Escolha a pasta do projeto',
        buttonLabel: 'Escolher pasta',
        defaultPath: homedir(),
        properties: ['openDirectory', 'createDirectory'],
      }
      const result = parent
        ? await dialog.showOpenDialog(parent, options)
        : await dialog.showOpenDialog(options)
      const picked = result.canceled ? undefined : result.filePaths[0]
      if (!picked) return null
      const root = picked.length > 1 ? picked.replace(/\/+$/, '') : picked
      return {
        path: root,
        name: basename(root) || root,
        isGitRepo: existsSync(join(root, '.git')),
        alreadyAdded: services.tasks.listProjects().some((p) => p.rootPath === root),
      }
    },
    'app.whatsNew': async () => whatsNew.get(),
    'app.whatsNewSeen': async () => whatsNew.markSeen(),
    'update.state': async () => updater?.state() ?? { status: 'idle', version: null },
    'update.install': async () => updater?.install(),
    'app.info': async (): Promise<AppInfo> => ({
      version: app.getVersion(),
      appId: APP_ID,
      userDataPath: paths.userData,
      platform: process.platform,
      electron: process.versions.electron ?? '',
    }),
  })
  ipcMain.handle(IPC_INVOKE_CHANNEL, (event, raw: unknown) => {
    if (!windows.has(event.sender.id)) {
      return { ok: false, error: { code: 'forbidden', message: 'origem desconhecida' } }
    }
    return route(raw, { senderId: event.sender.id })
  })
  services.onUiEvent(emitToWindows)
  return services
}

/** Espera a tela carregar (preload + renderer do pacote) e roda as checagens do main. */
async function runSmoke(services: AppServices, window: BrowserWindow): Promise<void> {
  const renderer = await new Promise<{ ok: boolean; detail: string }>((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, detail: 'timeout' }), 20_000)
    window.webContents.once('did-finish-load', () => {
      // Página carregada não basta: o preload precisa ter exposto a ponte e a
      // tela precisa sair de "Carregando...". Espera até 10 s pelos dois.
      const probe = `new Promise((ok) => {
        const end = Date.now() + 10000
        const tick = () => {
          const bridge = typeof window.eclipse === 'object' && window.eclipse !== null
          const loading = document.body.innerText.includes('Carregando...')
          if (bridge && !loading) return ok({ bridge, loading })
          if (Date.now() > end) return ok({ bridge, loading })
          setTimeout(tick, 100)
        }
        tick()
      })`
      void window.webContents
        .executeJavaScript(probe)
        .then((state: { bridge: boolean; loading: boolean }) => {
          clearTimeout(timer)
          const ok = state.bridge && !state.loading
          resolve({
            ok,
            detail: ok
              ? window.webContents.getURL()
              : `ponte=${state.bridge} carregando=${state.loading}`,
          })
        })
        .catch((error: unknown) => {
          clearTimeout(timer)
          resolve({ ok: false, detail: String(error) })
        })
    })
    window.webContents.once('did-fail-load', (_event, code, description) => {
      clearTimeout(timer)
      resolve({ ok: false, detail: `${code} ${description}` })
    })
  })
  log.info('smoke: tela', renderer)
  let code = 1
  try {
    const report = await runSmokeChecks(services, paths)
    const ok = report.ok && renderer.ok
    console.info(
      `[eclipse] smoke ${ok ? 'OK' : 'FALHOU'} ${JSON.stringify({
        version: app.getVersion(),
        packaged: app.isPackaged,
        electron: process.versions.electron,
        userData: paths.userData,
        windowVisible: window.isVisible(),
        renderer,
        ...report,
      })}`,
    )
    code = ok ? 0 : 1
  } catch (error) {
    log.error('smoke quebrou', { error: error instanceof Error ? error.stack : String(error) })
  }
  log.info('smoke: desligando')
  await services.dispose().catch((error: unknown) => log.error('falha ao desligar', { error }))
  app.exit(code)
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  let services: AppServices | null = null
  let quitting = false

  app.on('second-instance', () => {
    const [window] = BrowserWindow.getAllWindows()
    if (window) {
      if (window.isMinimized()) window.restore()
      window.focus()
    }
  })

  void app.whenReady().then(async () => {
    app.setAppUserModelId(APP_ID)
    try {
      services = await boot()
    } catch (error) {
      log.error('o app não iniciou', {
        error: error instanceof Error ? error.stack : String(error),
      })
      if (!isTestRun) {
        dialog.showErrorBox(
          APP_PRODUCT_NAME,
          `O app não conseguiu iniciar: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      app.exit(1)
      return
    }
    const window = createMainWindow()
    if (isSmokeRun) void runSmoke(services, window)
  })

  // Desligamento ordenado: mata membros e Lideres sem fechar turnos; a proxima partida recupera.
  app.on('before-quit', (event) => {
    if (quitting || !services) return
    event.preventDefault()
    quitting = true
    updater?.dispose()
    const current = services
    services = null
    void current
      .dispose()
      .catch((error: unknown) => log.error('falha ao desligar', { error: String(error) }))
      .finally(() => app.quit())
  })
  app.on('window-all-closed', () => app.quit())
}
