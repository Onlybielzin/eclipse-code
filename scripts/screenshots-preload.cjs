// Preload so das capturas do README: expoe window.eclipse com dados FALSOS (projeto
// "loja-exemplo"). Nao le o SQLite nem nenhuma pasta do usuario. A cena vem do hash da URL.
const scene = globalThis.location.hash.slice(1)
const now = Date.now()
const min = (n) => now - n * 60_000
const P = 'p1'

const project = {
  id: P,
  name: 'loja-exemplo',
  rootPath: '/home/dev/loja-exemplo',
  createdAt: min(900),
  updatedAt: min(900),
}
const role = (id, name, extra = {}) => ({
  id,
  projectId: P,
  name,
  description: '',
  provider: 'claude',
  model: 'sonnet',
  promptTemplate: '',
  isLead: false,
  createdAt: min(900),
  updatedAt: min(900),
  ...extra,
})
const roles = [
  role('lead', 'Líder', { model: 'opus', isLead: true }),
  role('dev', 'Dev'),
  role('rev', 'Revisor', { provider: 'codex', model: null }),
]
const task = (id, title, workflowStatus, extra = {}) => ({
  id,
  projectId: P,
  contextId: `ctx-${id}`,
  title,
  kind: 'team',
  worktreePath: `/home/dev/.eclipse/worktrees/${id}`,
  branch: `feat/${id}`,
  baseBranch: 'main',
  leadRoleId: 'lead',
  soloProvider: null,
  status: 'open',
  workflowStatus,
  createdAt: min(300),
  updatedAt: min(5),
  archivedAt: null,
  ...extra,
})
function wallTask(id, title, workflowStatus, branch, ago, extra = {}) {
  return {
    id,
    projectId: P,
    projectName: 'loja-exemplo',
    title,
    workflowStatus,
    branch,
    updatedAt: min(ago),
    members: [],
    linesAdded: 0,
    linesRemoved: 0,
    lastFile: null,
    lastLines: [],
    openQuestions: 0,
    ...extra,
  }
}

const tasks = [
  task('busca-categoria', 'Adicionar busca por categoria', 'em_andamento', { updatedAt: min(1) }),
  task('total-carrinho', 'Corrigir total do carrinho', 'pergunta', { updatedAt: min(3) }),
  task('pagina-pedidos', 'Página de pedidos', 'a_fazer', { updatedAt: min(40) }),
  task('frete-cep', 'Calcular frete por CEP', 'em_revisao', { updatedAt: min(25) }),
  task('layout-produto', 'Novo layout da página de produto', 'lancado', {
    status: 'archived',
    archivedAt: min(120),
    updatedAt: min(120),
  }),
]
const sub = (id, taskId, roleId, title, state, extra = {}) => ({
  id,
  taskId,
  roleId,
  title,
  instructions: 'Siga o critério de pronto da tarefa.',
  state,
  statusMessage: null,
  failureCode: null,
  referenceTaskIds: [],
  sessionId: `sess-${id}`,
  createdAt: min(60),
  updatedAt: min(2),
  finishedAt: null,
  ...extra,
})
const subtasks = [
  sub('s1', 'busca-categoria', 'dev', 'Filtro por categoria em search.ts', 'completed', {
    finishedAt: min(20),
  }),
  sub('s2', 'busca-categoria', 'dev', 'Campo de categoria na tela de busca', 'working'),
  sub('s3', 'busca-categoria', 'rev', 'Revisar o filtro por categoria', 'working'),
  sub('s4', 'total-carrinho', 'dev', 'Somar o frete no total do carrinho', 'input_required'),
  sub('s5', 'frete-cep', 'dev', 'Cálculo de frete por faixa de CEP', 'completed', {
    finishedAt: min(35),
  }),
  sub('s6', 'frete-cep', 'rev', 'Revisar o cálculo de frete', 'completed', { finishedAt: min(26) }),
]
const delivery = (summary, files, tests) => ({
  state: 'completed',
  summary,
  files,
  tests,
  questions: [],
})
const artifacts = [
  {
    id: 'a1',
    taskId: 'busca-categoria',
    subtaskId: 's1',
    sessionId: 'sess-s1',
    turnId: 'turn1',
    format: 'structured',
    parts: [],
    createdAt: min(20),
    delivery: delivery(
      'O filtro por categoria agora aceita uma ou várias categorias e mantém a ordenação por relevância. A busca sem categoria continua igual.',
      [
        { path: 'src/busca/search.ts', change: 'modified' },
        { path: 'src/busca/categorias.ts', change: 'added' },
        { path: 'src/busca/search.test.ts', change: 'modified' },
      ],
      [
        { command: 'pnpm test src/busca', result: '14 testes passaram', passed: true },
        { command: 'pnpm typecheck', result: 'sem erros', passed: true },
      ],
    ),
  },
]
const act = (seq, payload) => ({
  seq,
  sessionId: 'sess-s2',
  subtaskId: 's2',
  turnId: 'turn1',
  at: min(12) + seq * 20_000,
  payload,
})
const activity = [
  act(1, {
    kind: 'prompt',
    text: 'Adicione o campo de categoria na tela de busca e ligue ao filtro de search.ts.',
  }),
  act(2, {
    kind: 'tool_call',
    toolCallId: 'c1',
    title: 'Ler src/telas/Busca.tsx',
    toolKind: 'read',
    status: 'completed',
    input: null,
  }),
  act(3, {
    kind: 'text',
    text: 'A tela já tem o campo de texto. Vou incluir um seletor de categoria ao lado.',
  }),
  act(4, {
    kind: 'tool_call',
    toolCallId: 'c2',
    title: 'Editar src/telas/Busca.tsx',
    toolKind: 'edit',
    status: 'completed',
    input: null,
  }),
  act(5, {
    kind: 'tool_call',
    toolCallId: 'c3',
    title: 'Rodar pnpm test src/telas',
    toolKind: 'execute',
    status: 'in_progress',
    input: null,
  }),
]
const questions =
  scene === 'pergunta'
    ? [
        {
          id: 'q1',
          taskId: 'total-carrinho',
          subtaskId: null,
          status: 'open',
          answers: null,
          createdAt: min(3),
          answeredAt: null,
          items: [
            {
              id: 'i1',
              multiSelect: false,
              allowFreeText: false,
              prompt:
                'O frete entra no desconto do cupom? Isso muda o total de todos os pedidos com cupom.',
              options: [
                {
                  id: 'o1',
                  label: 'Não, o cupom vale só para os produtos',
                  description: 'Custo: o cliente paga o frete cheio.',
                },
                {
                  id: 'o2',
                  label: 'Sim, o cupom vale para o total com frete',
                  description: 'Custo: a loja perde margem no frete.',
                },
                {
                  id: 'o3',
                  label: 'Só em cupons de frete grátis',
                  description: 'Custo: uma regra a mais para manter.',
                },
              ],
            },
          ],
        },
      ]
    : []

const C = '\x1b[38;5;75m',
  G = '\x1b[32m',
  D = '\x1b[90m',
  B = '\x1b[1m',
  R = '\x1b[0m'
const leaderText = (lines) => lines.join('\r\n')
const scrollbacks = {
  'busca-categoria': leaderText([
    `${D}~/loja-exemplo (feat/busca-categoria)${R}`,
    `${C}${B}Líder${R} Li a tarefa e o código de src/busca. Plano:`,
    `  1. Filtro por categoria em search.ts  ${G}(Dev, pronto)${R}`,
    `  2. Campo de categoria na tela de busca  (Dev, em andamento)`,
    `  3. Revisão do filtro  (Revisor, em andamento)`,
    '',
    `${C}${B}Líder${R} O Dev entregou o filtro com 14 testes passando.`,
    `  O Revisor confere agora. Aviso quando as duas subtarefas terminarem.`,
    '',
    `${D}> ${R}`,
  ]),
  'total-carrinho': leaderText([
    `${D}~/loja-exemplo (feat/total-carrinho)${R}`,
    `${C}${B}Líder${R} O total do carrinho ignora o frete quando há cupom.`,
    `  A causa está em src/carrinho/total.ts, na ordem do desconto.`,
    '',
    `${C}${B}Líder${R} Antes de corrigir, preciso de uma decisão sua.`,
    `  A pergunta está embaixo do terminal.`,
    '',
    `${D}> ${R}`,
  ]),
}

const listeners = new Map()
const handlers = {
  'app.info': () => ({
    version: '0.2.0',
    appId: 'app.eclipsecode.next',
    userDataPath: '/home/dev/.config/eclipse-code',
    platform: 'linux',
    electron: '41',
  }),
  'app.whatsNew': () =>
    scene === 'novidades'
      ? {
          version: '0.2.0',
          notes: [
            '- A pergunta do Líder aparece embaixo do terminal, com as opções e o custo de cada uma.',
            '- A lista de tarefas ganhou filtros por status e um seletor de projeto.',
            '- O app baixa a versão nova sozinho e só reinicia quando você clica.',
          ].join('\n'),
        }
      : null,
  'app.whatsNewSeen': () => undefined,
  'update.state': () =>
    // O fundo do modal borra o topo; por isso o botao "Fechar e instalar" fica fora desta cena.
    ({ status: 'idle', version: null }),
  'update.install': () => undefined,
  'projects.list': () => [project],
  'projects.summary': () => ({
    homeDir: '/home/dev',
    projects: [{ projectId: P, openTasks: 4, needsYou: 1 }],
  }),
  'settings.get': () => ({ maxLiveAgents: 6, maxLiveMembersPerTask: 3 }),
  'wall.snapshot': () => ({
    at: now,
    workingAgents: 3,
    maxLiveAgents: 6,
    doneToday: 4,
    inReview: 1,
    openQuestions: 1,
    tasks: [
      wallTask('t1', 'Adicionar busca por categoria', 'em_andamento', 'feat/busca-categoria', 1, {
        members: [
          {
            subtaskId: 's2',
            role: 'Dev',
            title: 'Campo de categoria na tela de busca',
            state: 'working',
          },
          {
            subtaskId: 's3',
            role: 'Revisor',
            title: 'Revisar o filtro por categoria',
            state: 'working',
          },
        ],
        linesAdded: 184,
        linesRemoved: 22,
        lastFile: 'src/busca/CampoCategoria.tsx',
        lastLines: [
          '+export function CampoCategoria({ valor, aoMudar }: Props) {',
          '+  const categorias = useCategorias()',
          '+  return (',
          '+    <select value={valor} onChange={(e) => aoMudar(e.target.value)}>',
          '-  return null',
        ],
      }),
      wallTask('t2', 'Corrigir total do carrinho', 'pergunta', 'feat/total-carrinho', 3, {
        members: [
          {
            subtaskId: 's4',
            role: 'Dev',
            title: 'Somar o frete no total do carrinho',
            state: 'input_required',
          },
        ],
        linesAdded: 12,
        linesRemoved: 5,
        lastFile: 'src/carrinho/total.ts',
        lastLines: [
          '-  const total = subtotal - desconto',
          '+  const total = subtotal + frete - desconto',
        ],
        openQuestions: 1,
      }),
      wallTask('t3', 'Calcular frete por CEP', 'em_revisao', 'feat/frete-cep', 25, {
        linesAdded: 96,
        linesRemoved: 8,
        lastFile: 'src/frete/cep.ts',
        lastLines: [
          '+export async function freteParaCep(cep: string) {',
          '+  const faixa = faixaDoCep(cep)',
        ],
      }),
      wallTask('t4', 'Página de pedidos', 'a_fazer', null, 40),
    ],
  }),
  'brain.status': () => ({ hasKey: false, keyLast4: null, connected: false, lastError: null }),
  'brain.graph': () => ({ nodes: [], edges: [] }),
  'brain.subscribe': () => undefined,
  'brain.unsubscribe': () => undefined,
  'roles.list': () => roles,
  'tasks.list': () => tasks,
  'questions.list': () => questions,
  'subtasks.list': ({ taskId }) => subtasks.filter((s) => s.taskId === taskId),
  'subtasks.detail': ({ subtaskId }) => ({
    subtask: subtasks.find((s) => s.id === subtaskId),
    messages: [],
    artifacts: artifacts.filter((a) => a.subtaskId === subtaskId),
    turns: [],
    session: null,
  }),
  'activity.list': ({ subtaskId }) => {
    const events = activity.filter((e) => e.subtaskId === subtaskId)
    return { events, lastSeq: events.at(-1)?.seq ?? null, hasMore: false }
  },
  'leader.ensure': ({ taskId }) => ({
    id: `lead-${taskId}`,
    taskId,
    subtaskId: null,
    roleId: 'lead',
    kind: 'leader-pty',
    provider: 'claude',
    model: 'opus',
    cwd: '/home/dev/loja-exemplo',
    providerSessionId: null,
    pid: 1,
    status: 'running',
    activeTurnId: null,
    startedAt: min(60),
    endedAt: null,
    endReason: null,
    exitCode: null,
  }),
  'terminal.attach': ({ sessionId }) => ({
    sessionId,
    alive: true,
    cols: 80,
    rows: 24,
    scrollback: scrollbacks[sessionId.replace('lead-', '')] ?? '',
  }),
  'terminal.write': () => undefined,
  'terminal.resize': () => undefined,
}

globalThis.eclipse = {
  invoke: async (channel, input) => {
    const handler = handlers[channel]
    if (!handler)
      return { ok: false, error: { code: 'invalid_input', message: `sem resposta: ${channel}` } }
    return { ok: true, value: handler(input ?? {}) }
  },
  on: (channel, listener) => {
    const set = listeners.get(channel) ?? new Set()
    set.add(listener)
    listeners.set(channel, set)
    return () => set.delete(listener)
  },
}
