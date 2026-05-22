import { spawn } from 'node:child_process'

export type SceneCut = {
  /** 镜头变化的精确秒（pts_time） */
  t: number
  /** 该 cut 的 scene 分数（仅在用 select 时有） */
  score?: number
}

export type SceneDetectOptions = {
  /** 0.15 严格切多；0.5 宽松切少 */
  threshold: number
  /** 仅检测前 N 秒，0 = 全片 */
  maxScanSec?: number
}

/**
 * 用 ffmpeg 的 select 滤镜扫一遍源视频，从 stderr 抽 pts_time。
 * 同时解析 `time=` 行报告进度。
 */
export async function detectScenes(
  ffmpeg: string,
  videoPath: string,
  durationSec: number,
  opts: SceneDetectOptions,
  onPct?: (pct: number) => void
): Promise<SceneCut[]> {
  const t = Math.max(0.05, Math.min(0.9, opts.threshold))
  const args = [
    '-hide_banner',
    '-stats',
    ...(opts.maxScanSec && opts.maxScanSec > 0 ? ['-t', String(opts.maxScanSec)] : []),
    '-i',
    videoPath,
    '-vf',
    `select='gt(scene,${t})',showinfo`,
    '-an',
    '-f',
    'null',
    '-'
  ]

  const cuts: SceneCut[] = []

  await new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let buf = ''
    let lastPct = 0
    child.stderr.on('data', (d: Buffer) => {
      const chunk = d.toString()
      buf += chunk
      let idx = buf.indexOf('\n')
      while (idx >= 0) {
        const line = buf.slice(0, idx)
        buf = buf.slice(idx + 1)
        idx = buf.indexOf('\n')
        const m = line.match(/pts_time:([\d.]+)/)
        if (m) {
          const v = parseFloat(m[1])
          if (Number.isFinite(v) && v > 0.01) cuts.push({ t: v })
        }
      }
      if (onPct && durationSec > 0) {
        const tm = chunk.match(/time=(\d+):(\d+):(\d+\.\d+)/g)
        if (tm && tm.length > 0) {
          const last = tm[tm.length - 1].slice(5)
          const [hh, mm, ss] = last.split(':')
          const tt = Number(hh) * 3600 + Number(mm) * 60 + Number(ss)
          const pct = Math.min(0.999, tt / durationSec)
          if (pct - lastPct > 0.01) {
            lastPct = pct
            onPct(pct)
          }
        }
      }
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        onPct?.(1)
        resolve()
      } else reject(new Error(`scene detect exit ${code}`))
    })
  })

  // 加首尾边界保证有完整段
  const all = [...cuts.map((c) => c.t).sort((a, b) => a - b)]
  if (all[0] !== 0) all.unshift(0)
  if (all[all.length - 1] < durationSec - 0.05) all.push(durationSec)

  return all.map((t) => ({ t }))
}

export type SceneSegment = { startSec: number; endSec: number }

/**
 * 把 detectScenes 的边界数组转成段数组，并合并过短段 / 强切过长段。
 */
export function consolidate(
  cuts: SceneCut[],
  opts: { minSegSec: number; maxSegSec: number }
): SceneSegment[] {
  const cutTimes = cuts.map((c) => c.t)
  if (cutTimes.length < 2) return []

  // 初始段
  const initial: SceneSegment[] = []
  for (let i = 0; i < cutTimes.length - 1; i++) {
    initial.push({ startSec: cutTimes[i], endSec: cutTimes[i + 1] })
  }

  // 1) 合并过短段
  const merged = mergeShortSegments(initial, opts.minSegSec)
  // 2) 强切过长段
  const final = splitLongSegments(merged, opts.maxSegSec)
  return final
}

function mergeShortSegments(segs: SceneSegment[], minSec: number): SceneSegment[] {
  if (segs.length === 0) return segs
  const out: SceneSegment[] = []
  for (const s of segs) {
    const dur = s.endSec - s.startSec
    if (out.length > 0 && dur < minSec) {
      // 并入上一段
      out[out.length - 1].endSec = s.endSec
    } else {
      out.push({ ...s })
    }
  }
  // 最后一段太短：合并到倒数第二
  if (out.length >= 2) {
    const last = out[out.length - 1]
    if (last.endSec - last.startSec < minSec) {
      out[out.length - 2].endSec = last.endSec
      out.pop()
    }
  }
  return out
}

function splitLongSegments(segs: SceneSegment[], maxSec: number): SceneSegment[] {
  const out: SceneSegment[] = []
  for (const s of segs) {
    const dur = s.endSec - s.startSec
    if (dur <= maxSec) {
      out.push(s)
      continue
    }
    // 强切：每 (maxSec * 0.8 ~ 1.0) 一刀，带 ±15% jitter
    let cursor = s.startSec
    while (cursor < s.endSec - 0.05) {
      const span = maxSec * (0.85 + Math.random() * 0.3) // 0.85~1.15 × maxSec
      const next = Math.min(s.endSec, cursor + span)
      out.push({ startSec: cursor, endSec: next })
      cursor = next
    }
  }
  return out
}
