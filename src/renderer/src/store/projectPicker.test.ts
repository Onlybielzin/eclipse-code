import { describe, expect, it } from 'vitest'
import { foldText, matchesProject, shortenPath, tildePath } from './projectPicker'

describe('seletor de projeto: busca', () => {
  const project = { name: 'Árvore Genealógica', rootPath: '/home/vings/Projetos/arvore' }

  it('ignora maiúsculas e acentos no nome e no caminho', () => {
    expect(foldText('Ação É')).toBe('acao e')
    expect(matchesProject(project, 'GENEALOGICA')).toBe(true)
    expect(matchesProject(project, 'projetos/arv')).toBe(true)
    expect(matchesProject(project, '  ')).toBe(true)
    expect(matchesProject(project, 'ereemby')).toBe(false)
  })
})

describe('seletor de projeto: caminho', () => {
  it('troca a home por ~ só dentro dela', () => {
    expect(tildePath('/home/vings/x', '/home/vings')).toBe('~/x')
    expect(tildePath('/home/vings', '/home/vings/')).toBe('~')
    expect(tildePath('/home/vingsdev/x', '/home/vings')).toBe('/home/vingsdev/x')
    expect(tildePath('/data/x', null)).toBe('/data/x')
  })

  it('caminho longo ganha reticências no meio com o tamanho máximo', () => {
    const long = '/data/Projects/um-nome-de-pasta-bem-comprido/sub/pasta/final-do-repo'
    const short = shortenPath(long, null, 30)
    expect(short).toHaveLength(30)
    expect(short.startsWith('/data/Proje')).toBe(true)
    expect(short.endsWith('final-do-repo')).toBe(true)
    expect(short).toContain('…')
    expect(shortenPath('/home/vings/curto', '/home/vings', 30)).toBe('~/curto')
  })
})
