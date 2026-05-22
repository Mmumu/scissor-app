import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { spawn } from 'node:child_process'
import {
  ffprobeDuration,
  ffprobeHasAudio,
  ffprobeVideoDims
} from '../ffmpeg-utils'
import type {
  AudioMeta,
  ClipMeta,
  ImportOptions,
  ImportProgressEvent,
  ImportRecord
} from '../../shared/library'
import {
  addAudio,
  addClip,
  addImport,
  findImportByHash,
  readIndex,
  removeImport
} from './index-store'
import { libraryRoot, tmpDir as libTmpDir } from './paths'
import { consolidate, detectScenes } from './scene-detect'
import { generateThumb, generateWaveform } from './thumb'

type ProgressFn = (ev: ImportProgressEvent) => void

const SAMPLE_BYTES = 8 * 1024 * 1024
const HASH_PREFIX_BYTES = 16

export async function importVideos(
  ffmpeg: string,
  ffprobe: string,
  opts: ImportOptions,
  onProgress: ProgressFn,
  signal?: AbortSignal
): Promise<ImportRecord[]> {
  const records: ImportRecord[] = []
  for (const path of opts.paths) {
    if (signal?.aborted) break
    try {
      const r = await importSingle(ffmpeg, ffprobe, path, opts, onProgress, signal)
      if (r) records.push(r)
    } catch (e) {
      onProgress({
        phase: 'error',
        sourcePath: path,
        importId: '',
        error: e instanceof Error ? e.message : String(e)
      })
    }
  }
  return records
}

async function importSingle(
  ffmpeg: string,
  ffprobe: string,
  sourcePath: string,
  opts: ImportOptions,
  onProgress: ProgressFn,
  signal?: AbortSignal
): Promise<ImportRecord | null> {
  if (!existsSync(sourcePath)) throw new Error('源文件不存在: ' + sourcePath)

  const sourceHash = await hashFilePrefix(sourcePath)
  const existing = findImportByHash(sourceHash)
  if (existing) {
    if (opts.duplicatePolicy === 'skip' || !opts.duplicatePolicy) {
      onProgress({
        phase: 'duplicate',
        sourcePath,
        sourceHash,
        existingImportId: existing.id
      })
      return null
    }
    if (opts.duplicatePolicy === 'reimport-replace') {
      removeImportPhysical(existing.id)
    }
  }

  const importId = makeId('imp')
  onProgress({ phase: 'queued', sourcePath, importId })

  const duration = (await ffprobeDuration(ffprobe, sourcePath)) ?? 0
  if (!duration || duration < 0.2) throw new Error('视频时长无效')
  const dims = await ffprobeVideoDims(ffprobe, sourcePath)
  if (!dims) throw new Error('无法读取视频分辨率')
  const hasAudio = await ffprobeHasAudio(ffprobe, sourcePath)

  const tmpWork = join(libTmpDir(), `work-${importId}`)
  mkdirSync(tmpWork, { recursive: true })

  try {
    // ① 在源视频上做 scene detect（像素更准，不受清洗模糊影响）
    onProgress({ phase: 'detecting', sourcePath, importId, pct: 0 })
    const cuts = await detectScenes(
      ffmpeg,
      sourcePath,
      duration,
      { threshold: opts.sceneThreshold },
      (pct) => onProgress({ phase: 'detecting', sourcePath, importId, pct })
    )
    const segments = consolidate(cuts, {
      minSegSec: opts.minSegSec,
      maxSegSec: opts.maxSegSec
    })
    if (segments.length === 0) segments.push({ startSec: 0, endSec: duration })

    // 切点时间（除掉起点 0）：这些时间会被强制变成关键帧 + segment_times
    const cutTimes = segments.slice(1).map((s) => s.startSec)

    // ② 清洗：剥 metadata + 重编码 + force_key_frames 精准对齐
    const cleanedPath = join(tmpWork, 'cleaned.mp4')
    onProgress({ phase: 'cleaning', sourcePath, importId, pct: 0 })
    await runCleanup(
      ffmpeg,
      sourcePath,
      cleanedPath,
      opts,
      duration,
      hasAudio && opts.audioMode !== 'none',
      cutTimes,
      (pct) => onProgress({ phase: 'cleaning', sourcePath, importId, pct }),
      signal
    )

    // ③ segment muxer：因为 ② 已经在 cutTimes 处插入了关键帧，这里 -c copy 能精确切
    onProgress({ phase: 'segmenting', sourcePath, importId, pct: 0 })
    const segDir = join(tmpWork, 'segs')
    mkdirSync(segDir, { recursive: true })
    const cutSecsCsv = cutTimes.map((t) => t.toFixed(3)).join(',')
    await runSegment(
      ffmpeg,
      cleanedPath,
      segDir,
      cutSecsCsv,
      duration,
      hasAudio && opts.audioMode === 'embed',
      (pct) => onProgress({ phase: 'segmenting', sourcePath, importId, pct }),
      signal
    )

    // ④ 移到 clips/，写 ClipMeta + 缩略图
    const clipIds: string[] = []
    for (let i = 0; i < segments.length; i++) {
      if (signal?.aborted) break
      const seg = segments[i]
      const srcSeg = join(segDir, `seg_${String(i).padStart(3, '0')}.mp4`)
      if (!existsSync(srcSeg)) {
        console.warn('[library] missing segment file:', srcSeg)
        continue
      }
      const id = makeId('clip')
      const videoRel = join('clips', `${id}.mp4`)
      const thumbRel = join('clips', `${id}.jpg`)
      renameSync(srcSeg, join(libraryRoot(), videoRel))

      const segDur = seg.endSec - seg.startSec
      onProgress({
        phase: 'thumbing',
        sourcePath,
        importId,
        current: i + 1,
        total: segments.length
      })
      await generateThumb(
        ffmpeg,
        join(libraryRoot(), videoRel),
        segDur,
        join(libraryRoot(), thumbRel)
      )

      const meta: ClipMeta = {
        id,
        importId,
        index: i,
        sourceStartSec: seg.startSec,
        sourceEndSec: seg.endSec,
        durationSec: segDur,
        width: dims.w,
        height: dims.h,
        fps: 0,
        hasAudio: hasAudio && opts.audioMode === 'embed',
        videoRel,
        thumbRel,
        createdAt: Date.now()
      }
      addClip(meta)
      clipIds.push(id)
    }

    // ⑤ 抽出完整音轨（extract 模式）
    let audioId: string | undefined
    if (hasAudio && opts.audioMode === 'extract') {
      onProgress({ phase: 'audio', sourcePath, importId })
      audioId = makeId('aud')
      const audioRel = join('audios', `${audioId}.m4a`)
      const waveformRel = join('audios', `${audioId}.png`)
      await runAudioExtract(ffmpeg, sourcePath, join(libraryRoot(), audioRel), signal)
      await generateWaveform(
        ffmpeg,
        join(libraryRoot(), audioRel),
        join(libraryRoot(), waveformRel)
      )
      const audioMeta: AudioMeta = {
        id: audioId,
        importId,
        label: basename(sourcePath, extname(sourcePath)),
        durationSec: duration,
        audioRel,
        waveformRel,
        createdAt: Date.now()
      }
      addAudio(audioMeta)
    }

    const record: ImportRecord = {
      id: importId,
      sourcePath,
      sourceHash,
      importedAt: Date.now(),
      audioMode: opts.audioMode,
      cleanup: opts.cleanup,
      sceneThreshold: opts.sceneThreshold,
      clipIds,
      audioId
    }
    addImport(record)

    onProgress({ phase: 'done', sourcePath, importId, clipCount: clipIds.length })
    return record
  } finally {
    try {
      rmSync(tmpWork, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
}

// ─── 子任务 ───────────────────────────────────────────────

function runCleanup(
  ffmpeg: string,
  src: string,
  dst: string,
  opts: ImportOptions,
  totalDur: number,
  keepAudioInVideo: boolean,
  forceKeyTimes: number[],
  onPct: (pct: number) => void,
  signal?: AbortSignal
): Promise<void> {
  const vf: string[] = []
  if (opts.cleanup === 'standard') {
    vf.push('crop=iw-4:ih-4:2:2')
    vf.push('scale=iw+4:ih+4:flags=lanczos')
    vf.push('gblur=sigma=0.2:steps=1')
    vf.push('unsharp=3:3:0.3:3:3:0')
    vf.push('noise=alls=1:allf=t')
  }
  vf.push('format=yuv420p')

  const args: string[] = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-stats',
    '-i',
    src,
    '-map_metadata',
    '-1',
    '-map_chapters',
    '-1'
  ]

  if (opts.cleanup === 'metadata-only') {
    // 只能 copy，但 copy 没法插入关键帧→后续 segment 不精确
    // 折中：仍然走 H.264 重编码以便精确切，但不动像素
    args.push(
      '-c:v',
      'libx264',
      '-preset',
      'medium',
      '-crf',
      '20',
      '-pix_fmt',
      'yuv420p'
    )
  } else {
    args.push(
      '-vf',
      vf.join(','),
      '-c:v',
      'libx264',
      '-preset',
      'medium',
      '-crf',
      '23',
      '-pix_fmt',
      'yuv420p'
    )
  }

  // 关键点：force_key_frames 精确在 cutTimes 插 I 帧
  // 同时保留全局每秒一帧的关键帧（兜底）
  const expr =
    forceKeyTimes.length > 0
      ? `expr:gte(t,n_forced*1.0)|${forceKeyTimes.map((t) => t.toFixed(3)).join('|')}`
      : 'expr:gte(t,n_forced*1.0)'
  // 把 expr: 改成纯时间列表更稳：ffmpeg 接受 "t1,t2,..." 直接当时间数组
  const keyArg =
    forceKeyTimes.length > 0 ? forceKeyTimes.map((t) => t.toFixed(3)).join(',') : '0'
  args.push('-force_key_frames', keyArg)
  void expr

  if (keepAudioInVideo) {
    args.push('-c:a', 'aac', '-b:a', '192k')
  } else {
    args.push('-an')
  }
  args.push('-movflags', '+faststart', '-y', dst)

  return runFf(ffmpeg, args, totalDur, onPct, signal)
}

function runSegment(
  ffmpeg: string,
  src: string,
  segDir: string,
  cutSecsCsv: string,
  totalDur: number,
  withAudio: boolean,
  onPct: (pct: number) => void,
  signal?: AbortSignal
): Promise<void> {
  const outPattern = join(segDir, 'seg_%03d.mp4')
  const args: string[] = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-stats',
    '-i',
    src,
    '-c',
    'copy',
    ...(withAudio ? [] : ['-an']),
    '-map',
    '0',
    '-f',
    'segment',
    ...(cutSecsCsv.length > 0 ? ['-segment_times', cutSecsCsv] : []),
    '-reset_timestamps',
    '1',
    '-segment_format',
    'mp4',
    '-segment_format_options',
    'movflags=+faststart',
    '-y',
    outPattern
  ]
  return runFf(ffmpeg, args, totalDur, onPct, signal)
}

function runAudioExtract(
  ffmpeg: string,
  src: string,
  dst: string,
  signal?: AbortSignal
): Promise<void> {
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    src,
    '-vn',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-map_metadata',
    '-1',
    '-y',
    dst
  ]
  return runFf(ffmpeg, args, 0, () => undefined, signal)
}

/**
 * 启动 ffmpeg，监听 stderr 解析 `time=HH:MM:SS.MS` 转成 pct，回调上去。
 * 必须在 args 里加 `-stats` 才会输出。
 */
function runFf(
  ffmpeg: string,
  args: string[],
  totalDur: number,
  onPct: (pct: number) => void,
  signal?: AbortSignal
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let errTail = ''
    let lastPct = 0
    child.stderr.on('data', (d: Buffer) => {
      const s = d.toString()
      // 保留最后 4KB 作为错误回显
      errTail = (errTail + s).slice(-4096)
      if (totalDur > 0) {
        // 一个 chunk 里可能有多行 `time=...`，取最后一个
        const m = s.match(/time=(\d+):(\d+):(\d+\.\d+)/g)
        if (m && m.length > 0) {
          const last = m[m.length - 1]
          const t = parseHms(last.slice(5))
          const pct = Math.min(0.999, Math.max(0, t / totalDur))
          if (pct - lastPct > 0.01 || pct >= 0.999) {
            lastPct = pct
            onPct(pct)
          }
        }
      }
    })
    const onAbort = (): void => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* ignore */
      }
    }
    signal?.addEventListener('abort', onAbort)
    child.on('error', (e) => {
      signal?.removeEventListener('abort', onAbort)
      reject(e)
    })
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort)
      if (code === 0) {
        if (totalDur > 0) onPct(1)
        resolve()
      } else {
        reject(new Error(errTail.slice(-2000) || `ffmpeg exit ${code}`))
      }
    })
  })
}

function parseHms(s: string): number {
  const [h, m, rest] = s.split(':')
  return Number(h) * 3600 + Number(m) * 60 + Number(rest)
}

// ─── 工具 ───────────────────────────────────────────────

function makeId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

async function hashFilePrefix(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path, { start: 0, end: SAMPLE_BYTES - 1 })
    stream.on('data', (c) => hash.update(c))
    stream.on('error', reject)
    stream.on('end', () => {
      const hex = hash.digest('hex')
      resolve(hex.slice(0, HASH_PREFIX_BYTES * 2))
    })
  })
}

function removeImportPhysical(importId: string): void {
  const i = readIndex()
  const r = i.imports.find((x) => x.id === importId)
  if (!r) return
  for (const cid of r.clipIds) {
    const c = i.clips.find((x) => x.id === cid)
    if (!c) continue
    safeUnlink(join(libraryRoot(), c.videoRel))
    safeUnlink(join(libraryRoot(), c.thumbRel))
  }
  if (r.audioId) {
    const a = i.audios.find((x) => x.id === r.audioId)
    if (a) {
      safeUnlink(join(libraryRoot(), a.audioRel))
      safeUnlink(join(libraryRoot(), a.waveformRel))
    }
  }
  removeImport(importId)
}

function safeUnlink(p: string): void {
  try {
    if (existsSync(p)) rmSync(p)
  } catch {
    /* ignore */
  }
}
