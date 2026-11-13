import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// Testes rodam dentro do Node do Electron (ELECTRON_RUN_AS_NODE=1, ver
// scripts/vitest-electron.mjs) para que node-pty e better-sqlite3, compilados
// para a ABI do Electron, carreguem sem segundo build. Nenhuma janela abre.
export default defineConfig({
  resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    pool: 'forks',
    testTimeout: 20_000,
  },
})
