import { describe, expect, it } from 'vitest'
import {
  appendQuestionsToCard,
  composeAnswerPrompt,
  ensureQuestionCardData,
  ensureTodosCardData,
  isQuestionCardClosable,
  normalizeQuestionCardInput,
  normalizeTodoItems,
  resolveQuestionAnswer,
  summarizeTodoProgress,
} from '../../../src/contexts/workspace/domain/canvasCards'

const single = ensureQuestionCardData({
  questions: [
    {
      header: 'Botão',
      question: 'Onde fica o botão?',
      context: 'A tela tem e-mail e senha.',
      options: [
        { label: 'Acima do e-mail', detail: '1 arquivo', recommended: true },
        { label: 'Abaixo do Entrar', detail: 'mesmo custo', recommended: false },
      ],
    },
  ],
  askedByNodeId: 'lead-1',
  status: 'pending',
  createdAt: '2026-11-11T14:00:00.000Z',
})

const multi = ensureQuestionCardData({
  questions: [
    {
      header: 'Login',
      question: 'Onde fica o botão?',
      options: [{ label: 'Acima' }, { label: 'Abaixo' }],
    },
    {
      header: 'Telas',
      question: 'Quais telas mudam?',
      multiSelect: true,
      options: [{ label: 'Login' }, { label: 'Cadastro' }, { label: 'Perfil' }],
    },
    { header: 'Deploy', question: 'Sobe hoje?', allowOther: false, options: [{ label: 'Sim' }] },
  ],
  askedByNodeId: 'lead-1',
  status: 'pending',
})

describe('question card input', () => {
  it('keeps at most one recommended option per question, trims text and numbers the ids', () => {
    const result = normalizeQuestionCardInput({
      questions: [
        {
          header: ' Banco de dados de sessão longo ',
          question: '  Qual?  ',
          options: [
            { label: ' A ', recommended: true },
            { label: 'B', detail: ' custo ', recommended: true },
          ],
        },
        { question: 'E o resto?', multiSelect: true, options: [{ label: 'C' }] },
      ],
    })
    expect(result).toEqual({
      ok: true,
      value: {
        questions: [
          {
            id: 'q1',
            header: 'Banco de dados de sessão',
            question: 'Qual?',
            context: '',
            multiSelect: false,
            allowOther: true,
            options: [
              { label: 'A', detail: '', recommended: true },
              { label: 'B', detail: 'custo', recommended: false },
            ],
          },
          {
            id: 'q2',
            header: '',
            question: 'E o resto?',
            context: '',
            multiSelect: true,
            allowOther: true,
            options: [{ label: 'C', detail: '', recommended: false }],
          },
        ],
      },
    })
  })

  it('still accepts the single-question shape', () => {
    const result = normalizeQuestionCardInput({
      question: 'Qual?',
      context: 'ctx',
      options: [{ label: 'A' }],
      allowOther: false,
    })
    expect(result.ok && result.value.questions).toEqual([
      {
        id: 'q1',
        header: '',
        question: 'Qual?',
        context: 'ctx',
        multiSelect: false,
        allowOther: false,
        options: [{ label: 'A', detail: '', recommended: false }],
      },
    ])
  })

  it('refuses empty questions, missing options and too many questions or options', () => {
    expect(normalizeQuestionCardInput({ question: ' ', options: [{ label: 'A' }] }).ok).toBe(false)
    expect(normalizeQuestionCardInput({ question: 'Qual?', options: [] }).ok).toBe(false)
    expect(normalizeQuestionCardInput({ questions: [] }).ok).toBe(false)
    expect(
      normalizeQuestionCardInput({
        question: 'Qual?',
        options: Array.from({ length: 7 }, (_, index) => ({ label: `O${index}` })),
      }).ok,
    ).toBe(false)
    expect(
      normalizeQuestionCardInput({
        questions: Array.from({ length: 9 }, (_, index) => ({
          question: `Q${index}`,
          options: [{ label: 'A' }],
        })),
      }).ok,
    ).toBe(false)
  })
})

describe('more questions for a card that is still waiting', () => {
  it('appends to the pending card with the next ids, while there is room', () => {
    const extra = normalizeQuestionCardInput({
      questions: [{ question: 'E o prazo?', options: [{ label: 'Hoje' }] }],
    })
    const merged = appendQuestionsToCard(multi, extra.ok ? extra.value.questions : [])
    expect(merged?.questions.map(item => item.id)).toEqual(['q1', 'q2', 'q3', 'q4'])
    expect(merged?.questions[3]).toMatchObject({ question: 'E o prazo?' })
  })

  it('refuses when the card would pass the limit or is already answered', () => {
    const many = normalizeQuestionCardInput({
      questions: Array.from({ length: 6 }, (_, index) => ({
        question: `Q${index}`,
        options: [{ label: 'A' }],
      })),
    })
    expect(appendQuestionsToCard(multi, many.ok ? many.value.questions : [])).toBeNull()
    expect(
      appendQuestionsToCard({ ...multi, status: 'answered' }, multi.questions.slice(0, 1)),
    ).toBeNull()
  })
})

describe('question card answer', () => {
  it('accepts an option or the user text on a single question (old input shape)', () => {
    expect(resolveQuestionAnswer(single, { optionIndex: 1 })).toEqual({
      ok: true,
      answers: [{ questionId: 'q1', optionIndexes: [1], text: '', skipped: false }],
      answerTexts: ['Abaixo do Entrar'],
    })
    expect(resolveQuestionAnswer(single, { text: '  Só no cadastro ' })).toEqual({
      ok: true,
      answers: [{ questionId: 'q1', optionIndexes: [], text: 'Só no cadastro', skipped: false }],
      answerTexts: ['Só no cadastro'],
    })
    expect(resolveQuestionAnswer(single, { optionIndex: 5 })).toEqual({
      ok: false,
      reason: 'invalid_option',
    })
    expect(resolveQuestionAnswer(single, { text: '  ' })).toEqual({
      ok: false,
      reason: 'empty_answer',
    })
  })

  it('answers every question at once: options, own text, several choices or skipped', () => {
    const result = resolveQuestionAnswer(multi, {
      answers: [
        { questionId: 'q1', text: 'Só no cadastro' },
        { questionId: 'q2', optionIndexes: [2, 0], text: 'Admin também' },
        { questionId: 'q3', skipped: true },
      ],
    })
    expect(result).toEqual({
      ok: true,
      answers: [
        { questionId: 'q1', optionIndexes: [], text: 'Só no cadastro', skipped: false },
        { questionId: 'q2', optionIndexes: [0, 2], text: 'Admin também', skipped: false },
        { questionId: 'q3', optionIndexes: [], text: '', skipped: true },
      ],
      answerTexts: ['Só no cadastro', 'Login, Perfil; Admin também', null],
    })
  })

  it('refuses a missing question, several options on a single choice and unknown ids', () => {
    expect(
      resolveQuestionAnswer(multi, {
        answers: [
          { questionId: 'q1', optionIndexes: [0] },
          { questionId: 'q2', optionIndexes: [0] },
        ],
      }),
    ).toEqual({ ok: false, reason: 'missing_answer' })
    expect(
      resolveQuestionAnswer(multi, {
        answers: [
          { questionId: 'q1', optionIndexes: [0, 1] },
          { questionId: 'q2', optionIndexes: [0] },
          { questionId: 'q3', skipped: true },
        ],
      }),
    ).toEqual({ ok: false, reason: 'invalid_option' })
    expect(
      resolveQuestionAnswer(multi, {
        answers: [
          { questionId: 'q1', optionIndexes: [0], text: 'e também isso' },
          { questionId: 'q2', optionIndexes: [0] },
          { questionId: 'q3', skipped: true },
        ],
      }),
    ).toEqual({ ok: false, reason: 'invalid_option' })
    expect(
      resolveQuestionAnswer(multi, {
        answers: [
          { questionId: 'q1', optionIndexes: [0] },
          { questionId: 'q2', optionIndexes: [0] },
          { questionId: 'q9', skipped: true },
        ],
      }),
    ).toEqual({ ok: false, reason: 'unknown_question' })
  })

  it('never answers twice', () => {
    const answered = { ...single, status: 'answered' as const }
    expect(resolveQuestionAnswer(answered, { optionIndex: 0 })).toEqual({
      ok: false,
      reason: 'already_answered',
    })
  })

  it('refuses free text when the agent did not allow it', () => {
    expect(
      resolveQuestionAnswer(multi, {
        answers: [
          { questionId: 'q1', optionIndexes: [0] },
          { questionId: 'q2', optionIndexes: [0] },
          { questionId: 'q3', text: 'amanhã' },
        ],
      }),
    ).toEqual({ ok: false, reason: 'other_not_allowed' })
  })

  it('keeps the single-question message short and lists every question when there are more', () => {
    const one = composeAnswerPrompt(single, ['Acima do e-mail'])
    expect(one).toContain('Onde fica o botão?')
    expect(one).toContain('Acima do e-mail')
    const many = composeAnswerPrompt(multi, ['Acima', 'Login, Perfil', null])
    expect(many).toContain('[perguntas respondidas] 3 perguntas')
    expect(many).toContain('1. Login: Onde fica o botão? -> Acima')
    expect(many).toContain('2. Telas: Quais telas mudam? -> Login, Perfil')
    expect(many).toContain('3. Deploy: Sobe hoje? -> pulada (você decide)')
  })
})

describe('answered question leaves the canvas', () => {
  it('closes as soon as it is answered, never while pending', () => {
    expect(isQuestionCardClosable(single)).toBe(false)
    expect(isQuestionCardClosable({ ...single, status: 'answered', answeredAt: null })).toBe(true)
  })
})

describe('persisted card data', () => {
  it('repairs missing or malformed fields instead of dropping the card', () => {
    expect(ensureQuestionCardData({ question: 'Q', options: 'bad' })).toMatchObject({
      questions: [{ id: 'q1', question: 'Q', options: [], allowOther: true, multiSelect: false }],
      status: 'pending',
      answers: null,
    })
    expect(ensureTodosCardData(null)).toEqual({ ownerNodeId: null, items: [], updatedAt: null })
  })

  it('opens a card saved before multi-question cards with its answer intact', () => {
    const legacy = ensureQuestionCardData({
      question: 'Onde?',
      context: 'ctx',
      options: [{ label: 'A' }, { label: 'B' }],
      allowOther: true,
      askedByNodeId: 'lead-1',
      status: 'answered',
      answer: { optionIndex: 1, text: '' },
      answeredAt: '2026-11-11T14:32:00.000Z',
      createdAt: '2026-11-11T14:00:00.000Z',
    })
    expect(legacy.questions).toHaveLength(1)
    expect(legacy.questions[0]).toMatchObject({ id: 'q1', question: 'Onde?', context: 'ctx' })
    expect(legacy.status).toBe('answered')
    expect(legacy.answers).toEqual([
      { questionId: 'q1', optionIndexes: [1], text: '', skipped: false },
    ])
    const legacyText = ensureQuestionCardData({
      question: 'Onde?',
      options: [{ label: 'A' }],
      status: 'answered',
      answer: { optionIndex: null, text: 'Outro lugar' },
    })
    expect(legacyText.answers).toEqual([
      { questionId: 'q1', optionIndexes: [], text: 'Outro lugar', skipped: false },
    ])
  })

  it('treats an answered card without answers as pending', () => {
    expect(
      ensureQuestionCardData({ questions: [{ question: 'Q', options: [] }], status: 'answered' })
        .status,
    ).toBe('pending')
  })
})

describe('todo items', () => {
  it('reads TodoWrite and task-list shapes and counts progress', () => {
    const items = normalizeTodoItems([
      { content: 'Ler a rota', status: 'completed', activeForm: 'Lendo' },
      { subject: 'Criar a rota', status: 'in_progress' },
      { text: 'Testes', status: 'weird' },
      { status: 'pending' },
      { text: 'Apagada', status: 'deleted' },
    ])
    expect(items).toEqual([
      { text: 'Ler a rota', status: 'completed' },
      { text: 'Criar a rota', status: 'in_progress' },
      { text: 'Testes', status: 'pending' },
    ])
    expect(summarizeTodoProgress(items)).toEqual({ done: 1, total: 3 })
  })
})
