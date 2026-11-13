/**
 * acp/: membros do time pelo ACP. Implementa MemberRuntime (src/shared/ports.ts).
 *
 * Referencia: /data/Projects/paperclip packages/adapter-utils/src/acpx-engine/execute.ts,
 * adapters/claude-local/src/server/acp.ts, adapters/codex-local/src/server/acp.ts.
 * Pacotes: @agentclientprotocol/sdk, @agentclientprotocol/claude-agent-acp, @agentclientprotocol/codex-acp.
 *
 * TODO(acp):
 *  - startSession: spawn do agente ACP, initialize, session/new (ou session/load) com mcpServers.
 *    Claude: settingSources user/project/local para herdar ~/.claude (MCPs, ganchos).
 *  - prompt: session/prompt; cada session/update vira ActivityEventDraft; a resposta
 *    fecha o turno com stopReason. Processo morto, vigia de silencio e tempo maximo
 *    viram TurnResult com erro. finalText via assembleFinalText (src/shared/subtaskRules.ts).
 *  - Testes com agente ACP falso (nunca modelo real).
 */
export {}
