import type { DedupeGroup, VideoInfo } from '../shared/types'
import { dedupeMetadataLikelyDuplicatePair } from '../shared/metadata-similarity'
import {
  chromaprintSimilar,
  fingerprintVideo,
  getVideoInfo,
  perceptualSimilar,
  resolveBinariesSync,
  sha256File,
  tryChromaprintFingerprint,
  type FrameSignature,
  ffmpegMissingUserHint
} from './ffmpeg-utils'

type Entry = {
  path: string
  sha256: string
  durationSec?: number
  info?: VideoInfo
  chromaprint?: number[] | null
}

type PrintRow = {
  entry: Entry
  sig: FrameSignature | null
}

function unionFind(n: number): { find: (i: number) => number; union: (a: number, b: number) => void } {
  const p = Array.from({ length: n }, (_, i) => i)
  const find = (i: number): number => (p[i] === i ? i : (p[i] = find(p[i])))
  const union = (a: number, b: number) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) p[rb] = ra
  }
  return { find, union }
}

function pairLikelyDuplicate(a: PrintRow, b: PrintRow): boolean {
  const sigA = a.sig
  const sigB = b.sig
  if (sigA && sigB && perceptualSimilar(sigA, sigB)) return true

  const cfA = a.entry.chromaprint
  const cfB = b.entry.chromaprint
  if (cfA && cfB && cfA.length >= 5 && cfB.length >= 5 && chromaprintSimilar(cfA, cfB)) return true

  const infoA = a.entry.info
  const infoB = b.entry.info
  if (infoA && infoB && dedupeMetadataLikelyDuplicatePair(infoA, infoB)) return true

  return false
}

export async function runDedupe(paths: string[]): Promise<DedupeGroup[]> {
  const bins = resolveBinariesSync()
  if (!bins) throw new Error(ffmpegMissingUserHint())

  const entries: Entry[] = []
  for (const path of paths) {
    const sha256 = await sha256File(path)
    entries.push({ path, sha256 })
  }

  const groups: DedupeGroup[] = []
  const used = new Set<string>()

  const shaBuckets = new Map<string, Entry[]>()
  for (const e of entries) {
    const list = shaBuckets.get(e.sha256) ?? []
    list.push(e)
    shaBuckets.set(e.sha256, list)
  }

  for (const [, list] of shaBuckets) {
    if (list.length >= 2) {
      const id = `sha:${list[0].sha256.slice(0, 16)}`
      groups.push({
        id,
        reason: 'sha256',
        files: list.map((e) => ({ path: e.path, sha256: e.sha256 }))
      })
      for (const e of list) used.add(e.path)
    }
  }

  const perceptualCandidates = entries.filter((e) => !used.has(e.path))
  if (perceptualCandidates.length < 2) return groups

  await Promise.all(
    perceptualCandidates.map(async (e) => {
      const [info, cf] = await Promise.all([
        getVideoInfo(bins.ffprobe, e.path, { md5: false }),
        Promise.resolve(tryChromaprintFingerprint(e.path))
      ])
      e.info = info
      e.chromaprint = cf
    })
  )

  const prints: PrintRow[] = []
  for (const e of perceptualCandidates) {
    const sig = await fingerprintVideo(bins.ffmpeg, bins.ffprobe, e.path)
    prints.push({ entry: e, sig })
  }

  const n = prints.length
  const { find, union } = unionFind(n)
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (pairLikelyDuplicate(prints[i], prints[j])) union(i, j)
    }
  }

  const clusters = new Map<number, typeof prints>()
  for (let i = 0; i < n; i++) {
    const r = find(i)
    const list = clusters.get(r) ?? []
    list.push(prints[i])
    clusters.set(r, list)
  }

  let pid = 0
  for (const [, list] of clusters) {
    if (list.length < 2) continue
    const id = `ph:${pid++}`
    groups.push({
      id,
      reason: 'perceptual',
      files: list.map((x) => ({
        path: x.entry.path,
        sha256: x.entry.sha256,
        durationSec: x.entry.durationSec ?? x.sig?.durationSec ?? x.entry.info?.duration
      }))
    })
  }
 
  return groups
}
