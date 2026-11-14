// Gera o instalador NSIS x64 a partir do Linux. Uso: pnpm build:win
// O electron-builder não consegue recompilar o node-pty em build cruzado (node-gyp),
// mas o node-pty traz prebuilds win32-x64. Só o better-sqlite3 precisa do binário Windows:
// trocamos o .node por um prebuild win32 e restauramos o do Linux no fim, para o pnpm test seguir ok.
import { spawn } from 'node:child_process'
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const sqliteDir = dirname(require.resolve('better-sqlite3/package.json'))
const electronVersion = require('electron/package.json').version
const nativeFile = join(sqliteDir, 'build', 'Release', 'better_sqlite3.node')
// O makensis aborta ("stack smashing") quando o caminho de um include passa de ~260 caracteres.
const longPathProbe = join(
  dirname(
    require.resolve('app-builder-lib/package.json', {
      paths: [dirname(require.resolve('electron-builder/package.json'))],
    }),
  ),
  'templates',
  'nsis',
  'include',
  'StdUtils.nsh',
)
if (longPathProbe.length > 260) {
  throw new Error(
    `Caminho longo demais para o makensis (${longPathProbe.length} > 260). Rode de uma pasta mais curta, como /data/Projects/eclipse-code.`,
  )
}
const backupDir = mkdtempSync(join(tmpdir(), 'eclipse-sqlite-'))
const backup = join(backupDir, 'better_sqlite3.node')

let child = null
function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    child = spawn(command, args, { stdio: 'inherit', cwd, shell: process.platform === 'win32' })
    child.on('error', reject)
    child.on('close', (status) =>
      status === 0
        ? resolve()
        : reject(new Error(`${command} ${args.join(' ')} falhou (${status})`)),
    )
  })
}

function restore() {
  copyFileSync(backup, nativeFile)
  rmSync(backupDir, { recursive: true, force: true })
}

// Ctrl+C ou kill no meio do build: devolve o .node do Linux antes de sair.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    child?.kill(signal)
    restore()
    process.exit(signal === 'SIGINT' ? 130 : 143)
  })
}

copyFileSync(nativeFile, backup)
try {
  await run(
    'pnpm',
    [
      'exec',
      'prebuild-install',
      '--force',
      '--platform=win32',
      '--arch=x64',
      '--runtime=electron',
      `--target=${electronVersion}`,
    ],
    sqliteDir,
  )
  await run('pnpm', ['exec', 'electron-vite', 'build'])
  await run('pnpm', [
    'exec',
    'electron-builder',
    '--win',
    'nsis',
    '--x64',
    '--config.npmRebuild=false',
  ])
} finally {
  restore()
}
