/** Texto que o terminal recebe ao soltar arquivos: caminhos como digitados no shell. */
const SAFE = /^[A-Za-z0-9_./~@%+=:,-]+$/

const quote = (p: string): string => (SAFE.test(p) ? p : `'${p.replace(/'/g, "'\\''")}'`)

export function dropPathsText(paths: string[]): string {
  return paths.map((p) => `${quote(p)} `).join('')
}
