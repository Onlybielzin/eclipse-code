# Changelog

Cada versão tem uma seção `## X.Y.Z - AAAA-MM-DD` com itens `- `. O app mostra a seção da versão nova depois de atualizar.

## 0.1.10 - 2026-11-15

- Ao voltar para um projeto, o app reabre a última tarefa que estava selecionada nele, com a subtarefa que estava aberta.

## 0.1.9 - 2026-11-15

- Ao abrir o app, os Líderes voltam com a conversa anterior, mas nenhum começa a trabalhar sozinho.
- Avisos ao Líder Claude (reinício do app e fim de turno de subtarefa) chegam pelo gancho, sem texto colado no terminal.
- Tarefa nova mostra só "Tarefa: <título>. Comece." no terminal. O papel do Líder vai escondido, no prompt de sistema.

## 0.1.8 - 2026-11-15

- Criar tarefa agora abre um modal com 3 tipos: Com Líder e time, Agente avulso e Terminal.
- Novo tipo Terminal: abre só o shell, sem agente. Por padrão roda na pasta do projeto, sem worktree.
- Tarefa com Líder e time pode rodar sem worktree, na pasta do projeto e na branch atual.
- O modal mostra antes de criar a branch ou a pasta que a tarefa vai usar, e aceita uma branch de origem.

## 0.1.7 - 2026-11-14

- Projeto novo já nasce com o time padrão: Líder, Dev e Revisor. Antes não dava para criar tarefa de time num projeto novo.

## 0.1.6 - 2026-11-14

- Terminal do Líder: selecionar texto já copia, Ctrl+C com seleção copia e Ctrl+V cola. Sem seleção, Ctrl+C continua interrompendo.
- Saiu o botão Abrir no terminal e a seção Terminal das Configurações.

## 0.1.5 - 2026-11-14

- Novo botão Abrir no terminal: abre a pasta da tarefa no terminal que você escolher nas Configurações.
- Ao voltar para uma tarefa, o app reabre o último chat que você deixou aberto nela.

## 0.1.4 - 2026-11-14

- Versão para Windows: o release ganha o instalador .exe, que também se atualiza sozinho.

## 0.1.3 - 2026-11-14

- O app acha o claude e o codex mesmo quando é aberto pelo menu ou depois de atualizar.
- Botão Verificar atualização nas Configurações.

## 0.1.2 - 2026-11-14

- Nova aba Iniciar: você salva o comando da tarefa (por exemplo, `pnpm dev`) e liga o projeto na worktree com um clique. O log aparece no meio, com Parar e Reiniciar.
- Nova aba Terminal: um shell livre na pasta da tarefa.

## 0.1.1 - 2026-11-14

- Nova Parede: um painel com todas as tarefas abertas e o que cada uma está fazendo agora.
- As Configurações abrem como página, no lugar do terminal.
- A tela ganhou hierarquia de cor, com fundos em camadas.
- O Líder recebe os avisos das subtarefas sem que o app digite no terminal dele.
- O aviso de uma subtarefa não cola mais sobre o que você está escrevendo para o Líder.
- Primeiros ajustes para rodar no Windows: caminhos de projeto e PATH do Windows.

## 0.1.0 - 2026-11-14

- Lista de tarefas por projeto, com os status A fazer, Em andamento, Pergunta para você, Em revisão, Pronto pra lançar e Concluída.
- Cada tarefa ganha uma worktree e uma branch próprias.
- O Líder trabalha num terminal no meio da tela, com Claude Code ou Codex.
- O Líder divide o pedido em subtarefas para Dev e Revisor, que rodam sem terminal.
- A aba Atividade mostra o que cada membro fez; a entrega abre primeiro.
- Perguntas do Líder aparecem embaixo do terminal e no botão "precisa de você" do topo.
- Configurações com limite de agentes ao mesmo tempo.
- Plugin Cérebro, ligado ao second-brain.
- Atualização automática: o app baixa a versão nova e avisa no topo. Ele só reinicia quando você clica.
- Janela "Novidades da versão" na primeira abertura depois de atualizar.
