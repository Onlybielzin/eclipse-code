// Gera os PNGs do README em docs/screenshots/ com dados falsos (scripts/screenshots-preload.cjs).
// Uso: pnpm screenshots (roda o build e depois este arquivo dentro do Electron).
// Sem janela: --ozone-platform=headless, show:false e offscreen:true. Nada abre no monitor.
import { app, BrowserWindow } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'docs', 'screenshots')
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

// Cada cena: arquivo, e os cliques depois de carregar (seletores do app).
const scenes = [
  { name: 'principal', click: ['[data-testid="task-busca-categoria"]'] },
  { name: 'pergunta', click: ['[data-testid="task-total-carrinho"]'] },
  {
    name: 'subtarefa',
    click: ['[data-testid="task-busca-categoria"]', '[data-testid="subtask-s1"]'],
  },
  { name: 'novidades', click: [] },
  { name: 'configuracoes', click: ['button[aria-label="Configurações"]'] },
  { name: 'parede', click: ['button[aria-label="Parede"]'] },
]

// Sem await no topo: o Electron so dispara 'ready' depois que o modulo principal termina de carregar.
async function main() {
  await app.whenReady()
  mkdirSync(outDir, { recursive: true })

  for (const scene of scenes) {
    const win = new BrowserWindow({
      show: false,
      width: 1440,
      height: 900,
      useContentSize: true,
      webPreferences: {
        preload: join(root, 'scripts', 'screenshots-preload.cjs'),
        contextIsolation: false,
        sandbox: false,
        offscreen: true,
        backgroundThrottling: false,
      },
    })
    // No ozone headless a janela nasce 1x1; o tamanho certo vem daqui.
    win.setContentSize(1440, 900)
    await win.loadFile(join(root, 'out', 'renderer', 'index.html'), { hash: scene.name })
    await wait(1500)
    for (const selector of scene.click) {
      await win.webContents.executeJavaScript(
        `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('sem ' + ${JSON.stringify(selector)}); el.click() })()`,
      )
      await wait(800)
    }
    await wait(1200)
    const image = await win.webContents.capturePage()
    writeFileSync(join(outDir, `${scene.name}.png`), image.toPNG())
    console.log(`ok ${scene.name} ${image.getSize().width}x${image.getSize().height}`)
    // a janela fica viva: destruir uma janela offscreen derruba a carga da proxima
  }
  app.quit()
}

main().catch((error) => {
  console.error(error)
  app.exit(1)
})
