import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import { APP_ID, APP_PRODUCT_NAME, ENV } from '@shared/app'
import { IPC_INVOKE_CHANNEL, type AppInfo } from '@shared/ipc'
import { createIpcRouter, resolveAppPaths } from './app'

// Pasta de dados propria: nunca a do app antigo. Precisa vir antes de 'ready'.
const paths = resolveAppPaths()
app.setName(APP_PRODUCT_NAME)
app.setPath('userData', paths.userData)

const isTestRun = process.env[ENV.runtime] === 'test'

const route = createIpcRouter({
  'app.info': async (): Promise<AppInfo> => ({
    version: app.getVersion(),
    appId: APP_ID,
    userDataPath: paths.userData,
    platform: process.platform,
    electron: process.versions.electron ?? '',
  }),
})

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1400,
    height: 900,
    // Testes nunca mostram janela no monitor do usuario.
    show: false,
    title: APP_PRODUCT_NAME,
    backgroundColor: '#0d0f14',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })
  if (!isTestRun) window.once('ready-to-show', () => window.show())

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) void window.loadURL(devUrl)
  else void window.loadFile(join(__dirname, '../renderer/index.html'))
  return window
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  ipcMain.handle(IPC_INVOKE_CHANNEL, (_event, raw: unknown) => route(raw))
  void app.whenReady().then(() => {
    app.setAppUserModelId(APP_ID)
    createMainWindow()
  })
  app.on('window-all-closed', () => app.quit())
}
