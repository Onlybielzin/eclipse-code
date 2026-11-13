import { beforeEach, describe, expect, it, vi } from 'vitest'

const calls: Array<{ args: string[]; stdin?: string }> = []
vi.mock('../../../src/app/cli/mcp/runCli', () => ({
  runCli: vi.fn(async (args: string[], stdin?: string) => {
    calls.push({ args, stdin })
    return { code: 0, stdout: '{"nodeId":"q1"}', stderr: '' }
  }),
}))

const { CARD_TOOLS } = await import('../../../src/app/cli/mcp/cardTools')
const tool = (name: string) => CARD_TOOLS.find(candidate => candidate.name === name)!

beforeEach(() => {
  calls.length = 0
})

describe('eclipse-code mcp: question cards', () => {
  it('pergunta_criar sends every question with its options, cost and the recommended one', async () => {
    expect(tool('pergunta_criar').leadOnly).toBe(true)
    await tool('pergunta_criar').run({
      perguntas: [
        {
          rotulo: 'Botão',
          pergunta: 'Onde fica o botão?',
          contexto: 'Tela de login',
          opcoes: [{ texto: 'Acima', custo: '1 arquivo', recomendada: true }, { texto: 'Abaixo' }],
          permitir_outra: false,
        },
        { pergunta: 'Quais telas mudam?', varias: true, opcoes: [{ texto: 'Login' }] },
      ],
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.args).toEqual(['api', 'call', 'question.create', '--input-file', '-'])
    expect(JSON.parse(calls[0]!.stdin!)).toEqual({
      questions: [
        {
          header: 'Botão',
          question: 'Onde fica o botão?',
          context: 'Tela de login',
          options: [
            { label: 'Acima', detail: '1 arquivo', recommended: true },
            { label: 'Abaixo' },
          ],
          allowOther: false,
        },
        { question: 'Quais telas mudam?', options: [{ label: 'Login' }], multiSelect: true },
      ],
    })
  })

  it('pergunta_criar refuses more than 8 questions before calling the app', async () => {
    const one = { pergunta: 'Q', opcoes: [{ texto: 'A' }] }
    await expect(
      tool('pergunta_criar').run({ perguntas: Array.from({ length: 9 }, () => one) }),
    ).rejects.toThrow(/8 perguntas/)
    expect(calls).toHaveLength(0)
  })

  it('pergunta_criar tells the agent to write plainly (ASD-STE100 at about 80%)', () => {
    const description = tool('pergunta_criar').description
    expect(description).toContain('ASD-STE100')
    expect(description).toContain('80%')
    expect(description).toContain('até 20 palavras')
  })

  it('pergunta_criar refuses an option without text before calling the app', async () => {
    await expect(
      tool('pergunta_criar').run({ perguntas: [{ pergunta: 'Q', opcoes: [{ custo: 'x' }] }] }),
    ).rejects.toThrow(/obrigatório/)
    expect(calls).toHaveLength(0)
  })

  it('perguntas_historico reads the decisions of the given Space', async () => {
    await tool('perguntas_historico').run({ space: 'task-1' })
    expect(calls[0]!.args).toEqual([
      'api',
      'call',
      'question.history',
      '--input',
      '{"spaceId":"task-1"}',
    ])
  })
})
