import {
  app,
  BrowserWindow,
  Notification,
  dialog,
  ipcMain,
  Menu,
  safeStorage,
  shell,
  type OpenDialogOptions,
} from 'electron'
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
import { createNotificationHolder } from './app/electronNotifier'
import { attachExternalLinks } from './app/externalLinks'
import { applyLoginShellPath } from './app/loginShellPath'
import { DomainError } from '@shared/domain'
import { parseCliArgs, runCliTask } from './cli/cliTask'
import { createUpdater, createWhatsNew } from './app/updater'
import { ensureNodePtySpawnHelperExecutable } from './terminal'
import { runGit } from './worktree'
import { createRemoteController, type RemoteController } from './remote'

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
  // Sem a barra File/Edit/View/Window padrao do Electron (a tela tem o proprio topo).
  Menu.setApplicationMenu(null)
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
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  attachExternalLinks(window.webContents, {
    openExternal: (url) => shell.openExternal(url),
    isAppUrl: (url) => url.startsWith('file:') || (!!devUrl && url.startsWith(devUrl)),
  })
  if (!isTestRun) window.once('ready-to-show', () => window.show())

  if (devUrl) void window.loadURL(devUrl)
  else void window.loadFile(join(__dirname, '../renderer/index.html'))
  return window
}

const notifications = createNotificationHolder(Notification)

async function boot(): Promise<AppServices> {
  // Antes de qualquer spawn: aberto pelo menu ou pelo auto-update, o PATH vem sem ~/.local/bin.
  // Testes e smoke não rodam o shell de login (lento e depende do rc do usuário).
  if (!isTestRun) await applyLoginShellPath({ log })
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
    // Sem foco na janela, o aviso tambem vira notificacao do sistema (nunca em teste ou smoke).
    systemNotifier: {
      isSupported: () => !isTestRun && Notification.isSupported(),
      isWindowFocused: () => BrowserWindow.getAllWindows().some((w) => w.isFocused()),
      focusWindow: () => {
        const [window] = BrowserWindow.getAllWindows()
        if (!window) return
        if (window.isMinimized()) window.restore()
        window.show()
        window.focus()
      },
      show: (title, body, onClick) => notifications.show(title, body, onClick),
    },
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
    version: app.getVersion(),
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
  let remote: RemoteController | null = null
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
        // .git sem HEAD (commit inicial falhou) conta como sem git: a tela oferece o init de novo.
        isGitRepo:
          existsSync(join(root, '.git')) &&
          (await runGit(['rev-parse', '--verify', 'HEAD'], root, 'observation')).exitCode === 0,
        alreadyAdded: services.tasks.listProjects().some((p) => p.rootPath === root),
      }
    },
    'remote.get': async () => remote!.get(),
    'remote.save': async (input) => remote!.save(input),
    'remote.rotateToken': async () => remote!.rotateToken(),
    'remote.testNotify': async () => remote!.testNotify(),
    'app.whatsNew': async () => whatsNew.get(),
    'app.whatsNewSeen': async () => whatsNew.markSeen(),
    'update.state': async () => updater?.state() ?? { status: 'idle', version: null },
    'update.check': async () => {
      if (!updater)
        throw new DomainError('unavailable', 'A atualização só funciona no app instalado.')
      return updater.checkNow()
    },
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
  // Celular: no app construido serve a tela de out/renderer; em dev responde 503.
  remote = createRemoteController({
    storage: services.settings,
    route,
    rendererDir: process.env['ELECTRON_RENDERER_URL'] ? null : join(__dirname, '../renderer'),
    // Em teste e no smoke nunca sai aviso de verdade.
    ntfyFetch: isTestRun ? null : fetch,
    lookup: (taskId) => {
      const task = services.tasks.getTask(taskId)
      return { taskName: task.name, projectName: services.tasks.getProject(task.projectId).name }
    },
    log,
  })
  const remoteController = remote
  const offRemote = services.onUiEvent((message) => remoteController.emit(message))
  const disposeServices = services.dispose.bind(services)
  services.dispose = async () => {
    offRemote()
    await remoteController.dispose()
    await disposeServices()
  }
  await remoteController.init()
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

// Comando de linha (`eclipse-code tarefa ...`): fala com o app aberto e sai. Sem lock, sem janela, sem serviços.
const cliParse = parseCliArgs(process.argv)
if (cliParse.kind !== 'none') {
  // `| head -0` fecha o pipe: EPIPE em stdout/stderr não pode derrubar o comando.
  process.stdout.on('error', () => {})
  process.stderr.on('error', () => {})
  void runCliTask(cliParse, {
    env: process.env,
    readStdin: async () => {
      const chunks: Buffer[] = []
      for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer))
      return Buffer.concat(chunks).toString('utf8')
    },
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      return 1
    })
    .then((code) => process.stdout.write('', () => process.stderr.write('', () => app.exit(code))))
} else if (!app.requestSingleInstanceLock()) {
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
    notifications.dispose()
    const current = services
    services = null
    void current
      .dispose()
      .catch((error: unknown) => log.error('falha ao desligar', { error: String(error) }))
      .finally(() => app.quit())
  })
  app.on('window-all-closed', () => app.quit())
}
