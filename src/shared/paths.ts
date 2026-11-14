// Sem node:path: roda tambem na tela. Aceita POSIX, letra de unidade e UNC.
export function isAbsolutePath(p: string): boolean {
  return /^(\/|[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/]+[^\\/])/.test(p)
}
