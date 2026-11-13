import { spawn } from 'node:child_process'

export interface CliResult {
  code: number
  stdout: string
  stderr: string
}

/** Runs this same CLI as a child, inheriting the caller's terminal grant (ECLIPSE_CODE_*). */
export function runCli(args: string[], stdin?: string): Promise<CliResult> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [process.argv[1]!, ...args], {
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => (stdout += String(chunk)))
    child.stderr.on('data', chunk => (stderr += String(chunk)))
    child.on('error', error => resolve({ code: 1, stdout, stderr: stderr + String(error) }))
    child.on('close', code => resolve({ code: code ?? 1, stdout, stderr }))
    child.stdin.end(stdin ?? '')
  })
}
