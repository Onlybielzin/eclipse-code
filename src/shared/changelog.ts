/** Corpo da seção "## versão" do CHANGELOG.md (sem o título), ou null se não existe ou está vazia. */
export function changelogSection(markdown: string, version: string): string | null {
  const lines = markdown.split(/\r?\n/)
  const isTitle = (l: string) => l.startsWith('## ')
  const start = lines.findIndex((l) => isTitle(l) && l.slice(3).trim().split(/\s+/)[0] === version)
  if (start < 0) return null
  const rest = lines.slice(start + 1)
  const end = rest.findIndex(isTitle)
  const body = (end < 0 ? rest : rest.slice(0, end)).join('\n').trim()
  return body === '' ? null : body
}
