import type { ClipMeta } from '../../../shared/library'

/** 按源时间轴顺序排列（同 import 内） */
export function sortClipsBySourceTime(clips: ClipMeta[]): ClipMeta[] {
  return [...clips].sort(
    (a, b) => a.sourceStartSec - b.sourceStartSec || a.index - b.index
  )
}

/** 段在源时间轴上的时长（优先用入库的入出点） */
export function clipSourceSpanSec(c: ClipMeta): number {
  const span = c.sourceEndSec - c.sourceStartSec
  if (span > 0.001) return span
  return Math.max(0.05, c.durationSec)
}

/**
 * 相邻段 source 边界有缝隙时，把后段平移以接上（保持每段自身跨度不变）。
 * 不用 durationSec 重算整条时间轴，避免与播放器 currentTime 错位。
 */
export function alignClipSourceTimes(clips: ClipMeta[]): ClipMeta[] {
  const sorted = sortClipsBySourceTime(clips)
  if (sorted.length <= 1) return sorted

  let maxGap = 0
  for (let i = 1; i < sorted.length; i++) {
    maxGap = Math.max(maxGap, Math.abs(sorted[i].sourceStartSec - sorted[i - 1].sourceEndSec))
  }
  if (maxGap < 0.12) return sorted

  const out = sorted.map((c) => ({ ...c }))
  for (let i = 1; i < out.length; i++) {
    const span = clipSourceSpanSec(out[i])
    out[i].sourceStartSec = out[i - 1].sourceEndSec
    out[i].sourceEndSec = out[i].sourceStartSec + span
  }
  return out
}

/** 时间轴总长度：覆盖全部 clip 与播放器 duration */
export function sourceTimelineDuration(clips: ClipMeta[], videoDurSec: number): number {
  const clipEnd = clips.length ? clips[clips.length - 1].sourceEndSec : 0
  return Math.max(0.01, videoDurSec, clipEnd)
}

/** 半开区间 [start, end)：与 HTML5 currentTime 一致 */
export function findClipAtSourceTime(
  clips: ClipMeta[],
  sec: number
): { clip: ClipMeta; index: number } | null {
  if (clips.length === 0) return null
  const t = Math.max(0, sec)
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i]
    if (t >= c.sourceStartSec && t < c.sourceEndSec) {
      return { clip: c, index: i }
    }
  }
  const last = clips[clips.length - 1]
  if (t >= last.sourceStartSec) {
    return { clip: last, index: clips.length - 1 }
  }
  return { clip: clips[0], index: 0 }
}
