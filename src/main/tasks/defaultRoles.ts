import type { RoleAccess } from '@shared/domain'
import type { SaveRoleInput } from '@shared/ports'
import { roleNameKey } from './sqliteTaskStore'

type DefaultRole = Omit<SaveRoleInput, 'projectId' | 'roleId'>

/** Time padrao: todo projeto novo nasce com estes papeis (provedor claude, modelo padrao). */
export const DEFAULT_ROLES: readonly DefaultRole[] = [
  {
    name: 'Líder',
    description: 'Planeja, divide em subtarefas e coordena o time.',
    provider: 'claude',
    model: null,
    isLead: true,
    access: 'full',
    promptTemplate: [
      'Você é o Líder do time nesta tarefa: {{tarefa}}',
      'A worktree da tarefa é {{worktree}} e a branch é {{branch}}.',
      '',
      '1. Leia o código relacionado antes de planejar.',
      '2. Se uma decisão cabe só ao usuário, pergunte com pergunta_repassar. Dê as opções, o custo de cada uma e marque a recomendada.',
      '3. Divida o trabalho em subtarefas pequenas. O Dev implementa com teste. O Revisor revisa o diff.',
      '4. Espere as entregas e leia cada uma com atenção.',
      '5. Se a revisão achar um problema, abra uma subtarefa nova para a correção.',
      '6. Quando os checks do projeto passarem e não houver achado aberto, faça o commit na branch da tarefa.',
    ].join('\n'),
  },
  {
    name: 'Dev',
    description: 'Implementa o pedido, com teste, na worktree.',
    provider: 'claude',
    model: null,
    isLead: false,
    access: 'no_commit',
    promptTemplate: [
      'Você é o Dev do time. A tarefa é: {{tarefa}}',
      'Trabalhe só na worktree {{worktree}}.',
      '',
      '- Implemente somente o que a subtarefa pede.',
      '- Escreva o teste antes da mudança e rode os testes do projeto.',
      '- Não faça commit, push nem merge. O Líder faz o commit.',
      '- Na entrega, liste os arquivos alterados e diga como você testou.',
    ].join('\n'),
  },
  {
    name: 'Revisor',
    description: 'Revisa o diff da tarefa sem editar código.',
    provider: 'claude',
    model: null,
    isLead: false,
    access: 'read_only',
    promptTemplate: [
      'Você é o Revisor do time. A tarefa é: {{tarefa}}',
      'Revise o diff da branch {{branch}} na worktree {{worktree}}.',
      '',
      '- Não edite código.',
      '- Leia o diff e o código em volta antes de opinar.',
      '- Entregue cada achado com arquivo:linha e gravidade: "bloqueia" ou "melhora".',
      '- Se não houver achado, diga isso e diga o que você conferiu.',
    ].join('\n'),
  },
]

/** Acesso padrao pelo nome do papel (mesma regra da migracao 8). O Lider e sempre full. */
export function defaultAccessFor(name: string, isLead: boolean): RoleAccess {
  if (isLead) return 'full'
  const key = roleNameKey(name)
  return key === 'revisor' ? 'read_only' : key === 'dev' ? 'no_commit' : 'full'
}
