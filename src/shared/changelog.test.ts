import { describe, expect, it } from 'vitest'
import { changelogSection } from './changelog'

const MD = `# Changelog

## 0.2.0 - 2026-11-20

- Novo botão
- Outra coisa

## 0.1.0

Primeira versão.
`

describe('changelogSection', () => {
  it('devolve o corpo da versão, sem o título', () => {
    expect(changelogSection(MD, '0.2.0')).toBe('- Novo botão\n- Outra coisa')
  })
  it('aceita título com data e a última seção', () => {
    expect(changelogSection(MD, '0.1.0')).toBe('Primeira versão.')
  })
  it('devolve null se a versão não existe ou a seção está vazia', () => {
    expect(changelogSection(MD, '0.3.0')).toBeNull()
    expect(changelogSection('## 1.0.0\n\n## 0.9.0\ntexto', '1.0.0')).toBeNull()
  })
  it('não confunde 0.1.0 com 0.1.01', () => {
    expect(changelogSection('## 0.1.01\nx', '0.1.0')).toBeNull()
  })
})
