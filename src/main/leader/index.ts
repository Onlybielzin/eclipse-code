/**
 * leader/: abrir o Lider (Claude/Codex) num pty e falar com ele.
 * Implementa LeaderLauncher e LeaderRelay (src/shared/ports.ts).
 *
 * Origem: agent/infrastructure/{cli,providers,watchers,terminal-activity},
 * AgentSessionLocator e TeamTurnRelay do app antigo (so Claude e Codex).
 *
 * TODO(leader):
 *  - buildCommand: claude [--model] [--resume <id>] --mcp-config <json>;
 *    codex [resume <id>] -c mcp_servers.eclipse=... .
 *  - locateProviderSessionId: ~/.claude/projects e ~/.codex/sessions.
 *  - LeaderRelay.deliver: esperar o Lider ocioso, colar e enviar, com novas tentativas.
 */
export {}
