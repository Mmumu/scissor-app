import { spawn } from 'node:child_process'

export function spawnWithStdout(cmd: string, args: string[], timeoutMs = 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false
    const done = (err: Error | null, val?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (err) reject(err)
      else resolve(val!)
    }

    const timer = setTimeout(() => {
      try { child.kill() } catch { /* ignore */ }
      done(new Error(`${cmd} timed out after ${timeoutMs / 1000}s`))
    }, timeoutMs)

    const child = spawn(cmd, args, { windowsHide: true })
    const chunks: Buffer[] = []
    child.stdout.on('data', (d: Buffer) => chunks.push(d))
    child.stderr.on('data', (d: Buffer) => chunks.push(d))
    child.on('error', (e) => done(e))
    child.on('close', (code) => {
      const out = Buffer.concat(chunks).toString('utf8')
      if (code === 0) done(null, out)
      else done(new Error(`${cmd} ${args.join(' ')} → exit ${code}\n${out}`))
    })
  })
}

export function spawnWithStdoutBuffer(cmd: string, args: string[], timeoutMs = 30_000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let settled = false
    const done = (err: Error | null, val?: Buffer) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (err) reject(err)
      else resolve(val!)
    }

    const timer = setTimeout(() => {
      try { child.kill() } catch { /* ignore */ }
      done(new Error(`${cmd} timed out after ${timeoutMs / 1000}s`))
    }, timeoutMs)

    const child = spawn(cmd, args, { windowsHide: true })
    const chunks: Buffer[] = []
    child.stdout.on('data', (d: Buffer) => chunks.push(d))
    child.stderr.on('data', () => {})
    child.on('error', (e) => done(e))
    child.on('close', (code) => {
      if (code === 0) done(null, Buffer.concat(chunks))
      else done(new Error(`${cmd} exited ${code}`))
    })
  })
}
