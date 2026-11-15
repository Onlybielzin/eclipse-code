/** Nome de branch a partir do título da tarefa; usado pelo main e pela prévia da tela. */
export const DEFAULT_BRANCH_PREFIX = 'feat/'
const MAX_SLUG_CHARS = 48

/** "Corrigir Login Já!" -> "corrigir-login-ja". Vazio vira "tarefa". */
export function slugify(text: string): string {
  const slug = text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_CHARS)
    .replace(/-+$/g, '')
  return slug.length > 0 ? slug : 'tarefa'
}
