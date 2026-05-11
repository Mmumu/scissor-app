import {
  bitrateMatch,
  durationMatch,
  fpsMatch,
  metadataSimilarityPercent,
  normFormat,
  sizeMatch
} from '../../shared/metadata-similarity'
import type { VideoInfo } from '../../shared/types'

export type CompareTableRow = {
  label: string
  valA: string
  valB: string
  match: boolean
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = n
  let i = 0
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024
    i++
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${u[i]}`
}

function formatBitrate(bps: number): string {
  if (!bps || !Number.isFinite(bps)) return '—'
  const kb = bps / 1000
  if (kb < 1000) return `${Math.round(kb)} kbps`
  return `${(kb / 1000).toFixed(2)} Mbps`
}

function formatDuration(sec: number): string {
  if (!Number.isFinite(sec)) return '—'
  if (sec < 60) return `${sec.toFixed(2)}s`
  const m = Math.floor(sec / 60)
  const s = sec - m * 60
  return `${m}m ${s.toFixed(1)}s`
}

function formatFps(f: number): string {
  if (!Number.isFinite(f) || f <= 0) return '—'
  return `${f.toFixed(3)}`.replace(/\.?0+$/, '') + ' fps'
}

export { metadataSimilarityPercent }

export function buildCompareRows(a: VideoInfo, b: VideoInfo): CompareTableRow[] {
  const rows: CompareTableRow[] = [
    {
      label: '文件大小',
      valA: formatBytes(a.size),
      valB: formatBytes(b.size),
      match: sizeMatch(a.size, b.size)
    },
    {
      label: 'MD5（全文）',
      valA: a.md5 ? `${a.md5.slice(0, 12)}…` : '未计算',
      valB: b.md5 ? `${b.md5.slice(0, 12)}…` : '未计算',
      match: !!(a.md5 && b.md5 && a.md5 === b.md5)
    },
    {
      label: '时长',
      valA: formatDuration(a.duration),
      valB: formatDuration(b.duration),
      match: durationMatch(a.duration, b.duration)
    },
    {
      label: '容器格式',
      valA: a.formatName || '—',
      valB: b.formatName || '—',
      match: normFormat(a.formatName) === normFormat(b.formatName) && normFormat(a.formatName) !== ''
    },
    {
      label: '视频编码',
      valA: a.videoCodec,
      valB: b.videoCodec,
      match: a.videoCodec === b.videoCodec
    },
    {
      label: '分辨率',
      valA: a.resolution,
      valB: b.resolution,
      match: a.resolution === b.resolution
    },
    {
      label: '帧率',
      valA: formatFps(a.fps),
      valB: formatFps(b.fps),
      match: fpsMatch(a.fps, b.fps)
    },
    {
      label: '音频编码',
      valA: a.audioCodec,
      valB: b.audioCodec,
      match: a.audioCodec === b.audioCodec
    },
    {
      label: '音频采样率',
      valA: a.audioSampleRate ? `${a.audioSampleRate} Hz` : '—',
      valB: b.audioSampleRate ? `${b.audioSampleRate} Hz` : '—',
      match: a.audioSampleRate === b.audioSampleRate
    },
    {
      label: '码率',
      valA: formatBitrate(a.bitrate),
      valB: formatBitrate(b.bitrate),
      match: bitrateMatch(a.bitrate, b.bitrate)
    }
  ]
  return rows
}

export function md5SameFile(a: VideoInfo, b: VideoInfo): boolean | null {
  if (!a.md5 || !b.md5) return null
  return a.md5 === b.md5
}
