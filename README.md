# Eclipse Code

App de tarefas com um Líder e subtarefas de agentes. O Líder conversa com você num terminal. Ele divide o trabalho em subtarefas para membros Dev e Revisor. Cada tarefa usa a própria worktree.

O projeto nasceu como fork do OpenCove (MIT) e foi reescrito.

## Requisitos

- Linux x64.
- Claude Code e/ou Codex no PATH.

## Instalar

1. Baixe o AppImage na página de [Releases](../../releases).
2. Rode `chmod +x Eclipse-Code-*.AppImage`.
3. Abra o arquivo.

## Atualização automática

O app procura versões novas ao abrir e mostra as notas do CHANGELOG. Isso só funciona no AppImage.

## Desenvolver

```
pnpm install
pnpm dev
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Os testes rodam dentro do Electron e precisam de display.

## Lançar versão

1. Escreva a seção nova no `CHANGELOG.md` ("## X.Y.Z - AAAA-MM-DD").
2. Suba a versão no `package.json`.
3. Faça o commit.
4. Rode `git tag vX.Y.Z && git push --tags`.

O workflow `.github/workflows/release.yml` confere a tag, roda typecheck e lint, gera o AppImage e publica o release com as notas do CHANGELOG.

## Licença

MIT. Veja [LICENSE](LICENSE).
