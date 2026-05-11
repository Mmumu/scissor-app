import { spawn } from 'node:child_process'
import {
  ffprobeHasAudio,
  ffprobeDuration,
  resolveBinariesSync,
  ffmpegMissingUserHint
} from './ffmpeg-utils'

export type Clip = {
  path: string
  startSec: number
  endSec: number
}

/** Build filter_complex for ordered clips; re-encodes for frame-accurate cuts. */
export async function exportTimeline(
  clips: Clip[],
  outPath: string,
  onLog?: (s: string) => void
): Promise<{ ok: boolean; error?: string }> {
  const bins = resolveBinariesSync()
  if (!bins) return { ok: false, error: ffmpegMissingUserHint() }
  const { ffmpeg, ffprobe } = bins

  if (!clips.length) return { ok: false, error: 'No clips' }

  for (const c of clips) {
    if (!(c.endSec > c.startSec)) return { ok: false, error: `Invalid range ${c.startSec}–${c.endSec}` }
  }

  const uniquePaths = [...new Set(clips.map((c) => c.path))]
  const pathToInput: Record<string, number> = {}
  uniquePaths.forEach((p, i) => {
    pathToInput[p] = i
  })

  const audioPerPath: Record<string, boolean> = {}
  for (const p of uniquePaths) {
    audioPerPath[p] = await ffprobeHasAudio(ffprobe, p)
  }
  const anyAudio = uniquePaths.some((p) => audioPerPath[p])
  const allAudio = uniquePaths.every((p) => audioPerPath[p])

  if (anyAudio && !allAudio) {
    return {
      ok: false,
      error:
        'Mixed audio/no-audio sources: use only videos that all have sound, or only silent videos.'
    }
  }

  const inputArgs: string[] = []
  for (const p of uniquePaths) {
    inputArgs.push('-i', p)
  }

  const segments: string[] = []
  let seg = 0
  for (const clip of clips) {
    const idx = pathToInput[clip.path]
    const start = clip.startSec
    const dur = clip.endSec - clip.startSec
    const vLabel = `v${seg}`
    const aLabel = `a${seg}`

    segments.push(
      `[${idx}:v]trim=start=${start}:duration=${dur},setpts=PTS-STARTPTS[${vLabel}]`
    )

    if (allAudio) {
      segments.push(
        `[${idx}:a]atrim=start=${start}:duration=${dur},asetpts=PTS-STARTPTS[${aLabel}]`
      )
    }
    seg++
  }

  const vLabels = clips.map((_, i) => `[v${i}]`).join('')
  const concatN = clips.length

  if (allAudio) {
    const aLabels = clips.map((_, i) => `[a${i}]`).join('')
    segments.push(`${vLabels}${aLabels}concat=n=${concatN}:v=1:a=1[outv][outa]`)
  } else {
    segments.push(`${vLabels}concat=n=${concatN}:v=1:a=0[outv]`)
  }

  const filter = segments.join(';')

  const args = [
    '-hide_banner',
    '-y',
    ...inputArgs,
    '-filter_complex',
    filter,
    '-map',
    '[outv]',
    ...(allAudio ? (['-map', '[outa]'] as const) : []),
    '-c:v',
    'libx264',
    '-preset',
    'fast',
    '-crf',
    '20',
    ...(allAudio ? (['-c:a', 'aac', '-b:a', '192k'] as const) : []),
    outPath
  ]

  onLog?.(`ffmpeg ${args.join(' ')}`)

  return await new Promise((resolve) => {
    const child = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let err = ''
    child.stderr?.on('data', (d: Buffer) => {
      err += d.toString()
    })
    child.on('error', (e) => resolve({ ok: false, error: String(e) }))
    child.on('close', (code) => {
      if (code === 0) resolve({ ok: true })
      else resolve({ ok: false, error: err.slice(-4000) || `exit ${code}` })
    })
  })
}

export async function probeDurationSafe(path: string): Promise<number | null> {
  const bins = resolveBinariesSync()
  if (!bins) return null
  return ffprobeDuration(bins.ffprobe, path)
}
