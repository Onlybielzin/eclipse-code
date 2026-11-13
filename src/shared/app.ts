/**
 * Identidade do app novo. Tudo aqui e proprio do Eclipse Code novo para que ele
 * rode lado a lado com o app antigo (dev.vings.eclipsecode, ~/.config/Eclipse Code)
 * sem dividir pasta de dados, socket ou porta.
 */

export const APP_ID = 'app.eclipsecode.next'
export const APP_PRODUCT_NAME = 'Eclipse Code'

/** Nome da pasta de dados em ~/.config (Linux). O main chama app.setPath('userData', ...) com ela. */
export const USER_DATA_DIR_NAME = 'eclipse-code-next'

/** Arquivo SQLite dentro da pasta de dados. */
export const DATABASE_FILE_NAME = 'eclipse-code.sqlite'

/** Prefixo das variaveis de ambiente que o app injeta nos agentes e no servidor MCP. */
export const ENV_PREFIX = 'ECLIPSE_NEXT_'

/** Variaveis de ambiente usadas entre main, agentes e servidor MCP. */
export const ENV = {
  /** '1' em todo processo aberto pelo app novo (Lider, membro, servidor MCP). */
  marker: 'ECLIPSE_NEXT_ENV',
  /** Caminho do socket unix local do McpBridge. */
  mcpSocket: 'ECLIPSE_NEXT_MCP_SOCKET',
  /** Token opaco que identifica a sessao que chama o servidor MCP. */
  mcpToken: 'ECLIPSE_NEXT_MCP_TOKEN',
  /** 'test' nos testes: o main nunca mostra janela (BrowserWindow show:false). */
  runtime: 'ECLIPSE_CODE_ENV',
} as const

/** Caminhos resolvidos pelo main na partida. */
export interface AppPaths {
  /** ~/.config/eclipse-code-next */
  userData: string
  /** <userData>/eclipse-code.sqlite */
  database: string
  /** <userData>/logs */
  logs: string
  /**
   * Pasta curta para sockets ($XDG_RUNTIME_DIR/eclipse-code-next ou /tmp/eclipse-code-next-<uid>).
   * Socket unix tem limite de ~108 bytes no caminho, por isso nao fica em userData.
   */
  runtime: string
  /** Raiz padrao das worktrees de tarefa: <userData>/worktrees */
  worktrees: string
}
