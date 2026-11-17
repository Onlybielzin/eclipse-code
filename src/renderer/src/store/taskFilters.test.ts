import { describe, expect, it } from 'vitest'
import { TASK_WORKFLOW_STATUSES } from '@shared/domain'
import { makeSubtask, makeTask } from '../test/fakeApi'
import {
  activePreset,
  activeTaskFilterCount,
  applyPreset,
  EMPTY_TASK_FILTERS,
  filterTasks,
  includeStatus,
  normalizeTaskFilters,
  parseTaskFilters,
  removeTaskFilter,
  taskFilterChips,
  type TaskFilters,
} from './taskFilters'

const tasks = [
  makeTask('a', 'Relatório por oferta', { workflowStatus: 'a_fazer' }),
  makeTask('b', 'checkout novo', { workflowStatus: 'em_revisao', kind: 'solo' }),
  makeTask('c', 'pergunta solta', { workflowStatus: 'pergunta', kind: 'solo' }),
  makeTask('d', 'antigo', { workflowStatus: 'lancado' }),
]
const subtasks = {
  a: [makeSubtask('s1', 'a', { state: 'working' })],
  b: [makeSubtask('s2', 'b', { state: 'completed' })],
  c: [makeSubtask('s3', 'c', { state: 'submitted' })],
}
const ids = (f: TaskFilters, q = '') => filterTasks(tasks, f, q, subtasks).map((t) => t.id)

describe('filterTasks', () => {
  it('sem filtro mostra tudo', () => {
    expect(ids(EMPTY_TASK_FILTERS)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('status, tipo e rodando se somam (E)', () => {
    expect(ids({ ...EMPTY_TASK_FILTERS, statuses: ['a_fazer', 'pergunta'] })).toEqual(['a', 'c'])
    expect(ids({ ...EMPTY_TASK_FILTERS, kinds: ['solo'] })).toEqual(['b', 'c'])
    // working e submitted contam; completed não.
    expect(ids({ ...EMPTY_TASK_FILTERS, runningOnly: true, showDoneSubtasks: false })).toEqual([
      'a',
      'c',
    ])
    expect(
      ids({
        statuses: ['pergunta', 'a_fazer'],
        kinds: ['solo'],
        runningOnly: true,
        showDoneSubtasks: false,
      }),
    ).toEqual(['c'])
  })

  it('busca ignora maiúsculas e acentos', () => {
    expect(ids(EMPTY_TASK_FILTERS, 'RELATORIO')).toEqual(['a'])
    expect(ids(EMPTY_TASK_FILTERS, '  check ')).toEqual(['b'])
    expect(ids(EMPTY_TASK_FILTERS, 'nada')).toEqual([])
  })

  it('busca casa o nome ou o pedido original', () => {
    const one = [makeTask('n', 'pedido longo do vings', { name: 'Nome curto' })]
    const find = (q: string) => filterTasks(one, EMPTY_TASK_FILTERS, q, {}).length
    expect(find('pedido')).toBe(1)
    expect(find('curto')).toBe(1)
    expect(find('nada')).toBe(0)
  })
})

describe('presets e normalização', () => {
  it('"Abertas" esconde Concluída e Cancelada; "Todas" limpa os status', () => {
    const open = applyPreset({ ...EMPTY_TASK_FILTERS, kinds: ['team'] }, 'open')
    expect(open.statuses).not.toContain('lancado')
    expect(open.statuses).not.toContain('cancelado')
    expect(open.statuses).toHaveLength(5)
    expect(open.kinds).toEqual(['team'])
    expect(activePreset(open)).toBe('open')
    expect(applyPreset(open, 'all').statuses).toEqual([])
    expect(activePreset(EMPTY_TASK_FILTERS)).toBe('all')
    expect(applyPreset(EMPTY_TASK_FILTERS, 'needs_me').statuses).toEqual(['pergunta', 'em_revisao'])
  })

  it('marcar todos equivale a nenhum e a ordem é a da tela', () => {
    expect(
      normalizeTaskFilters({
        statuses: [...TASK_WORKFLOW_STATUSES].reverse(),
        kinds: ['solo', 'team'],
        runningOnly: false,
        showDoneSubtasks: false,
      }),
    ).toEqual(EMPTY_TASK_FILTERS)
    expect(
      normalizeTaskFilters({ ...EMPTY_TASK_FILTERS, statuses: ['lancado', 'a_fazer'] }).statuses,
    ).toEqual(['a_fazer', 'lancado'])
  })

  it('includeStatus inclui só quando o status está escondido', () => {
    const f: TaskFilters = { ...EMPTY_TASK_FILTERS, statuses: ['a_fazer'] }
    expect(includeStatus(f, 'a_fazer')).toBe(f)
    expect(includeStatus(EMPTY_TASK_FILTERS, 'lancado')).toBe(EMPTY_TASK_FILTERS)
    expect(includeStatus(f, 'lancado').statuses).toEqual(['a_fazer', 'lancado'])
    // Abertas + Concluída + Cancelada = todos = sem filtro.
    const aberta = includeStatus(applyPreset(f, 'open'), 'lancado')
    expect(includeStatus(aberta, 'cancelado').statuses).toEqual([])
  })
})

describe('chips', () => {
  it('um chip por categoria com rótulo curto', () => {
    const f: TaskFilters = {
      statuses: applyPreset(EMPTY_TASK_FILTERS, 'open').statuses,
      kinds: ['solo'],
      runningOnly: true,
      showDoneSubtasks: false,
    }
    expect(taskFilterChips(f)).toEqual([
      { key: 'status', label: 'Sem Concluída, Cancelada' },
      { key: 'kind', label: 'Avulso' },
      { key: 'running', label: 'Agente rodando' },
    ])
    expect(activeTaskFilterCount(f)).toBe(3)
    expect(taskFilterChips(applyPreset(EMPTY_TASK_FILTERS, 'needs_me'))[0]?.label).toBe(
      'Precisam de mim',
    )
    expect(taskFilterChips({ ...EMPTY_TASK_FILTERS, statuses: ['a_fazer'] })[0]?.label).toBe(
      'A fazer',
    )
  })

  it('remover um chip limpa só aquela categoria', () => {
    const f: TaskFilters = {
      statuses: ['a_fazer'],
      kinds: ['team'],
      runningOnly: true,
      showDoneSubtasks: false,
    }
    expect(removeTaskFilter(f, 'kind')).toEqual({ ...f, kinds: [] })
    expect(removeTaskFilter(f, 'status')).toEqual({ ...f, statuses: [] })
    expect(removeTaskFilter(f, 'running')).toEqual({
      ...f,
      runningOnly: false,
      showDoneSubtasks: false,
    })
  })
})

describe('parseTaskFilters', () => {
  it('aceita o salvo e descarta lixo', () => {
    expect(
      parseTaskFilters(
        JSON.stringify({
          statuses: ['em_revisao', 'xx', 3],
          kinds: ['solo'],
          runningOnly: true,
          showDoneSubtasks: false,
        }),
      ),
    ).toEqual({
      statuses: ['em_revisao'],
      kinds: ['solo'],
      runningOnly: true,
      showDoneSubtasks: false,
    })
    expect(parseTaskFilters('{quebrado')).toEqual(EMPTY_TASK_FILTERS)
    expect(parseTaskFilters('null')).toEqual(EMPTY_TASK_FILTERS)
    expect(parseTaskFilters(null)).toEqual(EMPTY_TASK_FILTERS)
  })
})
