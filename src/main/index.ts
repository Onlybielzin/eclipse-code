import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { join } from 'node:path'
import { APP_ID, APP_PRODUCT_NAME, ENV } from '@shared/app'
import { IPC_EVENT_CHANNEL, IPC_INVOKE_CHANNEL, type AppInfo } from '@shared/ipc'
import {
  createIpcHandlers,
  createIpcRouter,
  resolveAppPaths,
  startAppServices,
  type AppLogger,
  type AppServices,
} from './app'
import { ensureNodePtySpawnHelperExecutable } from './terminal'

// Pasta de dados propria: nunca a do app antigo. Precisa vir antes de 'ready'.
const paths = resolveAppPaths()
app.setName(APP_PRODUCT_NAME)
app.setPath('userData', paths.userData)

const isTestRun = process.env[ENV.runtime] === 'test'

const log: AppLogger = {
  info: (message, meta) => console.info(`[eclipse] ${message}`, meta ?? ''),
  warn: (message, meta) => console.warn(`[eclipse] ${message}`, meta ?? ''),
  error: (message, meta) => console.error(`[eclipse] ${message}`, meta ?? ''),
}

/** Janelas do app: so elas falam com o main. */
const windows = new Set<number>()

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1400,
    height: 900,
    // Testes nunca mostram janela no monitor do usuario.
    show: false,
    title: APP_PRODUCT_NAME,
    backgroundColor: '#0e1211',
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
    log,
  })
  const route = createIpcRouter({
    ...createIpcHandlers(services),
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
    return route(raw)
  })
  services.onUiEvent((message) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed() && windows.has(window.webContents.id)) {
        window.webContents.send(IPC_EVENT_CHANNEL, message)
      }
    }
  })
  return services
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
    createMainWindow()
  })

  // Desligamento ordenado: mata membros e Lideres sem fechar turnos; a proxima partida recupera.
  app.on('before-quit', (event) => {
    if (quitting || !services) return
    event.preventDefault()
    quitting = true
    const current = services
    services = null
    void current
      .dispose()
      .catch((error: unknown) => log.error('falha ao desligar', { error: String(error) }))
      .finally(() => app.quit())
  })
  app.on('window-all-closed', () => app.quit())
}
