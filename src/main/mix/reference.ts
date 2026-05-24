import { existsSync, statSync } from 'node:fs'
import { ffprobeDuration } from '../ffmpeg-utils'
import { detectScenes, consolidate, type SceneSegment } from '../library/scene-detect'
import type { ReferenceSegment } from '../../shared/mix'

export type AnalyzeReferenceRequest = {
  path: string
  /** scene detect 阈值，越小切越多；不传 = 0.25 */
  threshold?: number
  /** 合并短段阈值，不传 = 0.6 */
  minSegSec?: number
  /** 强切长段阈值，不传 = 8.0 */
  maxSegSec?: number
}

export type AnalyzeReferenceResult =
  | {
      ok: true
      durationSec: number
      sizeBytes: number
      segments: ReferenceSegment[]
      threshold: number
    }
  | { ok: false; error: string }

/**
 * 对一段参考视频做镜头节奏分析（不入库、不切片、不持久化）。
 */
export async function analyzeReference(
  ffmpeg: string,
  ffprobe: string,
  req: AnalyzeReferenceRequest
): Promise<AnalyzeReferenceResult> {
  try {
    if (!req.path || !existsSync(req.path)) return { ok: false, error: '参考视频不存在' }

    const st = statSync(req.path)
    const duration = await ffprobeDuration(ffprobe, req.path)
    if (!duration || duration <= 0) return { ok: false, error: '无法读取参考视频时长' }

    const threshold = req.threshold ?? 0.25
    const cuts = await detectScenes(ffmpeg, req.path, duration, { threshold })
    const segs: SceneSegment[] = consolidate(cuts, {
      minSegSec: req.minSegSec ?? 0.6,
      maxSegSec: req.maxSegSec ?? 8.0
    })

    return {
      ok: true,
      durationSec: duration,
      sizeBytes: st.size,
      threshold,
      segments: segs.map((s) => ({ start: s.startSec, end: s.endSec, dur: s.endSec - s.startSec }))
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, error: msg }
  }
}

/**
 * 读取任意绝对路径文件为 base64（限大小，给 reference 视频回显用）。
 * 由于 reference 视频在库外，library:readAsBase64 走不通，这里独立一条。
 */
export function readAbsAsBase64(
  path: string,
  maxBytes: number
):
  | { ok: true; base64: string; mime: string; sizeBytes: number }
  | { ok: false; error: string; sizeBytes?: number } {
  try {
    if (!existsSync(path)) return { ok: false, error: '文件不存在' }
    const st = statSync(path)
    if (st.size > maxBytes) {
      return {
        ok: false,
        sizeBytes: st.size,
        error: `参考视频过大（${(st.size / 1024 / 1024).toFixed(1)}MB），建议 < ${(
          maxBytes /
          1024 /
          1024
        ).toFixed(0)}MB；请先裁剪一段再用作参考`
      }
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readFileSync } = require('node:fs') as typeof import('node:fs')
    const buf = readFileSync(path)
    const ext = path.toLowerCase().split('.').pop() || ''
    const mime =
      ext === 'mp4'
        ? 'video/mp4'
        : ext === 'mov'
          ? 'video/quicktime'
          : ext === 'webm'
            ? 'video/webm'
            : ext === 'mkv'
              ? 'video/x-matroska'
              : 'video/mp4'
    return { ok: true, base64: buf.toString('base64'), mime, sizeBytes: st.size }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, error: msg }
  }
}
