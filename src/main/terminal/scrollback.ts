/**
 * Ring buffer de saida do pty, para repintar a tela ao reabrir o terminal.
 * Copiado de src/shared/pty/snapshot.ts do app antigo, com o limite injetavel.
 */

export const DEFAULT_SCROLLBACK_CHARS = 400_000

export class ScrollbackBuffer {
  private chunks: string[] = []
  private head = 0
  private length = 0

  constructor(private readonly maxChars = DEFAULT_SCROLLBACK_CHARS) {
    if (!Number.isInteger(maxChars) || maxChars <= 0) {
      throw new RangeError('maxChars precisa ser inteiro positivo')
    }
  }

  get size(): number {
    return this.length
  }

  append(data: string): void {
    if (data.length === 0) return
    if (data.length >= this.maxChars) {
      this.chunks = [data.slice(-this.maxChars)]
      this.head = 0
      this.length = this.maxChars
      return
    }
    this.chunks.push(data)
    this.length += data.length
    this.trim()
  }

  toString(): string {
    if (this.length === 0 || this.head >= this.chunks.length) return ''
    return this.chunks.slice(this.head).join('')
  }

  private trim(): void {
    if (this.length <= this.maxChars) return
    let excess = this.length - this.maxChars
    while (excess > 0 && this.head < this.chunks.length) {
      const headChunk = this.chunks[this.head] ?? ''
      if (headChunk.length <= excess) {
        excess -= headChunk.length
        this.length -= headChunk.length
        this.head += 1
        continue
      }
      this.chunks[this.head] = headChunk.slice(excess)
      this.length -= excess
      excess = 0
    }
    if (this.head > 64) {
      this.chunks = this.chunks.slice(this.head)
      this.head = 0
    }
  }
}
