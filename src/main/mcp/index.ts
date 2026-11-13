/**
 * mcp/: servidor MCP stdio do app e ponte com o main. Implementa McpBridgeServer
 * (lado main) e McpBridgeClient (lado servidor MCP) de src/shared/ports.ts, com o
 * protocolo NDJSON e as ferramentas de src/shared/mcp.ts.
 *
 * Origem: /data/Projects/eclipse-code/src/app/cli/mcp/server.ts (reescrito para
 * subtarefa_criar, entregar, subtarefa_responder, subtarefa_cancelar, subtarefas_ver,
 * pergunta_repassar).
 *
 * TODO(mcp):
 *  - Socket unix em AppPaths.runtime com permissao 0600; token por sessao.
 *  - Entrada separada do build (out/mcp/server.js) usando @modelcontextprotocol/sdk.
 */
export {}
