import { open, stat } from 'node:fs/promises'

/**
 * Le linhas novas de um arquivo JSONL que cresce (eventos dos ganchos, transcript do Codex).
 * Por sondagem (fs.watch nao e confiavel em todo sistema de arquivos). O arquivo pode
 * ainda nao existir; truncamento recomeca do inicio.
 */
export interface JsonlTailOptions {
  pollMs?: number
  /** true le o arquivo desde o comeco; false comeca no fim atual. */
  fromStart?: boolean
  /** Limite de bytes lidos por sondagem. */
  maxReadBytes?: number
}

export class JsonlTail {
  private offset = 0
  private remainder = ''
  private timer: NodeJS.Timeout | null = null
  private polling: Promise<void> | null = null
  private initialized = false
  private stopped = false
  private readonly pollMs: number
  private readonly fromStart: boolean
  private readonly maxReadBytes: number

  constructor(
    readonly filePath: string,
    private readonly onRecord: (record: unknown) => void,
    options: JsonlTailOptions = {},
  ) {
    this.pollMs = options.pollMs ?? 250
    this.fromStart = options.fromStart ?? true
    this.maxReadBytes = options.maxReadBytes ?? 1024 * 1024
  }

  start(): void {
    if (this.timer || this.stopped) return
    this.timer = setInterval(() => void this.poll(), this.pollMs)
    this.timer.unref?.()
    void this.poll()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Uma leitura (exposto para testes e para forcar leitura imediata). */
  poll(): Promise<void> {
    if (this.polling) return this.polling
    this.polling = this.readNew().finally(() => {
      this.polling = null
    })
    return this.polling
  }

  private async readNew(): Promise<void> {
    if (this.stopped) return
    let size: number
    try {
      size = (await stat(this.filePath)).size
    } catch {
      return
    }
    if (!this.initialized) {
      this.initialized = true
      if (!this.fromStart) this.offset = size
    }
    if (size < this.offset) {
      this.offset = 0
      this.remainder = ''
    }
    if (size === this.offset) return
    const length = Math.min(size - this.offset, this.maxReadBytes)
    const handle = await open(this.filePath, 'r').catch(() => null)
    if (!handle) return
    try {
      const buffer = Buffer.alloc(length)
      const { bytesRead } = await handle.read(buffer, 0, length, this.offset)
      this.offset += bytesRead
      const text = this.remainder + buffer.subarray(0, bytesRead).toString('utf8')
      const lines = text.split('\n')
      this.remainder = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('{')) continue
        let record: unknown
        try {
          record = JSON.parse(trimmed)
        } catch {
          continue
        }
        if (this.stopped) return
        this.onRecord(record)
      }
    } finally {
      await handle.close().catch(() => undefined)
    }
  }
}
