/**
 * terminal/: hospedeiro de pty. Implementa PtyHost (src/shared/ports.ts).
 *
 * Origem: /data/Projects/eclipse-code/src/platform/process/ptyHost e pty
 * (copiar sem worker remoto, sem Windows console observer).
 *
 * TODO(terminal):
 *  - createPtyHost(): PtyHost sobre node-pty (de preferencia num utilityProcess).
 *  - Ring buffer de saida por pty (scrollback) com limite fixo.
 *  - liveCount() conta so processos vivos (fonte do limite de agentes).
 *  - Testes vitest com /bin/sh, sem Electron de janela.
 */
export {}
