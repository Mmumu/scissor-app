import type { VideoInfo } from './types'

export function normFormat(name: string): string {
  return (name || '').split(',')[0]?.trim().toLowerCase() || ''
}

export function fpsMatch(a: number, b: number): boolean {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return a === b
  if (a <= 0 && b <= 0) return true
  return Math.abs(a - b) < 0.051 || Math.round(a * 100) === Math.round(b * 100)
}

export function durationMatch(d1: number, d2: number): boolean {
  if (!Number.isFinite(d1) || !Number.isFinite(d2)) return false
  const max = Math.max(d1, d2)
  if (max <= 0) return d1 === d2
  const rel = Math.abs(d1 - d2) / max
  return rel <= 0.005 || Math.abs(d1 - d2) <= 0.12
}

export function bitrateMatch(b1: number, b2: number): boolean {
  const max = Math.max(b1, b2)
  if (max <= 0) return b1 === b2
  return Math.abs(b1 - b2) / max <= 0.12
}

export function sizeMatch(s1: number, s2: number): boolean {
  const max = Math.max(s1, s2)
  if (max <= 0) return s1 === s2
  return Math.abs(s1 - s2) / max <= 0.03
}

type Dim = { weight: number; match: boolean }

function scoreFromDims(dims: Dim[]): number {
  const total = dims.reduce((s, d) => s + d.weight, 0)
  if (total <= 0) return 0
  const got = dims.reduce((s, d) => s + (d.match ? d.weight : 0), 0)
  return Math.round((got / total) * 100)
}

/** 元数据相似度 0–100（不含 MD5） */
export function metadataSimilarityPercent(a: VideoInfo, b: VideoInfo): number {
  const dims: Dim[] = [
    { weight: 18, match: a.videoCodec === b.videoCodec },
    { weight: 18, match: a.resolution === b.resolution },
    { weight: 12, match: fpsMatch(a.fps, b.fps) },
    { weight: 18, match: durationMatch(a.duration, b.duration) },
    { weight: 10, match: a.audioCodec === b.audioCodec },
    { weight: 10, match: a.audioSampleRate === b.audioSampleRate },
    {
      weight: 5,
      match: normFormat(a.formatName) === normFormat(b.formatName) && normFormat(a.formatName) !== ''
    },
    { weight: 6, match: bitrateMatch(a.bitrate, b.bitrate) },
    { weight: 3, match: sizeMatch(a.size, b.size) }
  ]
  return scoreFromDims(dims)
}

/**
 * 去重专用：仅靠元数据也可并组（阈值高 + 硬指标），仍可能误伤，主要抓「同参数导出 / 同压制批次」。
 */
export function dedupeMetadataLikelyDuplicatePair(a: VideoInfo, b: VideoInfo): boolean {
  if (a.videoCodec !== b.videoCodec || a.resolution !== b.resolution) return false
  if (!durationMatch(a.duration, b.duration)) return false
  if (metadataSimilarityPercent(a, b) < 90) return false
  if (a.audioCodec !== 'none' && b.audioCodec !== 'none' && a.audioCodec !== b.audioCodec) return false
  return true
}
