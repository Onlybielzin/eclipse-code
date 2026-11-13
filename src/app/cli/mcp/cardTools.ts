import { QUESTION_CARD_MAX_QUESTIONS } from '../../../shared/contracts/canvasCards'
import { runCli } from './runCli'
import { text, type ToolDefinition } from './toolSupport'

/**
 * How the agent writes the card: ASD-STE100 (Simplified Technical English) applied at about 80%,
 * so the text is plain and fast to read without sounding childish.
 */
export const QUESTION_WRITING_RULES =
  'Escreva o card em português no estilo ASD-STE100 (escrita técnica simplificada), mas só uns 80%: claro e direto, sem ficar infantil nem telegráfico. Regras: uma ideia por frase; frases de até 20 palavras; voz ativa e verbo no lugar de substantivo ("crie a rota", não "realize a criação da rota"); o mesmo termo para a mesma coisa; número ou exemplo real em vez de adjetivo ("1 arquivo", "2 h", não "simples", "rápido"); explique o termo difícil na primeira vez ou troque por um comum; sem jargão interno, sem siglas soltas, sem emojis. Pode usar vírgula, "porque" e "mas" quando a frase pedir: o objetivo é ler rápido, não soar robótico.'

/** Question cards: the lead asks the user 1 to 4 questions on the canvas; the answers return as one new message. */
export const CARD_TOOLS: ToolDefinition[] = [
  {
    name: 'pergunta_criar',
    description:
      'Pergunta ao vings com um card no canvas, ao lado da sua janela, em vez de perguntar no terminal. Um card leva de 1 a 8 perguntas: chame UMA vez com todas as decisões que você precisa agora (ex.: banco, tela e prazo), nunca uma chamada por pergunta. Se você já tem um card esperando o vings, as perguntas novas entram nele. Cada pergunta tem opções com o custo de cada uma e no máximo uma recomendada. O vings responde todas e envia uma vez; ele pode pular uma pergunta ("você decide"). ' +
      QUESTION_WRITING_RULES +
      ' Depois termine o turno: as respostas chegam sozinhas como mensagem nova ("[pergunta respondida] ..." ou "[perguntas respondidas] ..."). Só o líder pode usar; membros do time perguntam ao líder.',
    leadOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        perguntas: {
          type: 'array',
          minItems: 1,
          maxItems: QUESTION_CARD_MAX_QUESTIONS,
          items: {
            type: 'object',
            properties: {
              rotulo: {
                type: 'string',
                description:
                  'Nome curto da aba, até 12 letras, ex.: "Banco", "Login", "Prazo". Obrigatório quando houver 2 ou mais perguntas.',
              },
              pergunta: {
                type: 'string',
                description:
                  'A pergunta, numa frase de até 20 palavras, do ponto de vista de quem decide. Ex.: "Onde o botão do Google aparece na tela de login?"',
              },
              contexto: {
                type: 'string',
                description:
                  'Só o que o vings precisa saber para decidir: 1 ou 2 frases curtas, uma ideia em cada, com número ou exemplo real.',
              },
              opcoes: {
                type: 'array',
                minItems: 1,
                maxItems: 6,
                items: {
                  type: 'object',
                  properties: {
                    texto: {
                      type: 'string',
                      description:
                        'A opção em até 8 palavras, começando pelo verbo ou pelo resultado.',
                    },
                    custo: {
                      type: 'string',
                      description:
                        'Custo ou consequência em 1 frase, com número real (arquivos, horas, risco). Ex.: "Muda 1 arquivo; quem já tem conta não vê."',
                    },
                    recomendada: { type: 'boolean', description: 'true em no máximo uma opção.' },
                  },
                  required: ['texto'],
                  additionalProperties: false,
                },
              },
              varias: {
                type: 'boolean',
                description:
                  'true quando o vings pode marcar mais de uma opção (ex.: "quais telas mudam?"). Padrão false.',
              },
              permitir_outra: {
                type: 'boolean',
                description: 'Deixa o vings escrever outra resposta (padrão true).',
              },
            },
            required: ['pergunta', 'opcoes'],
            additionalProperties: false,
          },
        },
      },
      required: ['perguntas'],
      additionalProperties: false,
    },
    run: async args => {
      const rawQuestions = Array.isArray(args.perguntas) ? args.perguntas : []
      if (rawQuestions.length === 0) {
        throw new Error('"perguntas" precisa de pelo menos uma pergunta.')
      }
      if (rawQuestions.length > QUESTION_CARD_MAX_QUESTIONS) {
        throw new Error(
          `No máximo ${QUESTION_CARD_MAX_QUESTIONS} perguntas por card. Mande as mais importantes agora e o resto depois da resposta.`,
        )
      }
      const questions = rawQuestions.map((rawQuestion, index) => {
        const item = (rawQuestion ?? {}) as Record<string, unknown>
        const options = (Array.isArray(item.opcoes) ? item.opcoes : []).map(raw => {
          const option = (raw ?? {}) as Record<string, unknown>
          return {
            label: text(option.texto, 'opcoes[].texto')!,
            ...(text(option.custo, 'custo', false) ? { detail: option.custo as string } : {}),
            ...(option.recomendada === true ? { recommended: true } : {}),
          }
        })
        if (options.length === 0) {
          throw new Error(`A pergunta ${index + 1} precisa de pelo menos uma opção.`)
        }
        const header = text(item.rotulo, 'rotulo', false)
        return {
          ...(header ? { header: header.slice(0, 24) } : {}),
          question: text(item.pergunta, 'pergunta')!,
          ...(text(item.contexto, 'contexto', false) ? { context: item.contexto as string } : {}),
          options,
          ...(item.varias === true ? { multiSelect: true } : {}),
          ...(item.permitir_outra === false ? { allowOther: false } : {}),
        }
      })
      return runCli(
        ['api', 'call', 'question.create', '--input-file', '-'],
        JSON.stringify({ questions }),
      )
    },
  },
  {
    name: 'perguntas_historico',
    description:
      'Lista as perguntas já respondidas pelo vings (decisões) da tarefa, da mais nova para a mais velha. Consulte antes de perguntar de novo algo já decidido.',
    inputSchema: {
      type: 'object',
      properties: {
        space: {
          type: 'string',
          description: 'ID do Space da tarefa. Vazio usa o seu Space atual (ou o projeto).',
        },
      },
      additionalProperties: false,
    },
    run: args => {
      const space = text(args.space, 'space', false) ?? process.env['ECLIPSE_CODE_SPACE_ID']
      const project = process.env['ECLIPSE_CODE_PROJECT_ID']
      const input = space ? { spaceId: space } : project ? { projectId: project } : {}
      return runCli(['api', 'call', 'question.history', '--input', JSON.stringify(input)])
    },
  },
]
