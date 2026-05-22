/**
 * 按需 2 秒切片预览渲染。
 * - 接收 ObfuscationOptions（+ 可选的 stitch 参数）
 * - 用 -ss + -t 截取一段，跑相同的管线，输出到 tmpdir
 * - 返回成片二进制（base64），让渲染层用 Blob URL 播放，避开 file:// 协议限制
 */

import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { transformVideo, ffprobeDuration } from './ffmpeg-utils'
import { stitchVideo, type InsertPosition } from './stitch'
import type { ObfuscationOptions } from '../shared/obfuscation'

export type PreviewMode = 'transform' | 'stitch'

export interface PreviewRequest {
  mode: PreviewMode
  mainPath: string
  obfuscation: ObfuscationOptions
  /** 0 = 自动选源视频中段（≈ 1/3 处） */
  startSec?: number
  /** 默认 2 秒 */
  durationSec?: number

  /** stitch 模式独有 */
  insertPath?: string
  insertSizePx?: number
  insertPositions?: InsertPosition[]
}

export interface PreviewResult {
  ok: boolean
  /** 成片字节（base64），通常 <2MB */
  base64?: string
  mime?: string
  durationSec?: number
  error?: string
}

const PREVIEW_MAX_BYTES = 12 * 1024 * 1024

export async function renderPreview(
  ffmpeg: string,
  ffprobe: string,
  req: PreviewRequest
): Promise<PreviewResult> {
  const workDir = join(tmpdir(), `scissor-preview-${process.pid}-${Date.now()}`)
  mkdirSync(workDir, { recursive: true })
  const tmpInputCut = join(workDir, 'cut.mp4')
  const tmpOutput = join(workDir, 'out.mp4')

  try {
    // 1. 用 stream copy 切出原始片段，避免对完整文件做扰动浪费时间
    const dur = (await ffprobeDuration(ffprobe, req.mainPath)) ?? 0
    const wantDur = req.durationSec ?? 2
    const startSec =
      req.startSec != null
        ? Math.max(0, Math.min(dur - wantDur - 0.1, req.startSec))
        : Math.max(0, Math.min(dur - wantDur - 0.1, dur / 3))

    const cutOk = await cutWithStreamCopy(ffmpeg, req.mainPath, tmpInputCut, startSec, wantDur)
    if (!cutOk) {
      return { ok: false, error: '无法截取预览片段（可能 keyframe 间距太大或视频损坏）' }
    }

    // 2. 用预览特化的 ObfuscationOptions 跑：
    //    - 屏蔽掉 trim / concat（在源切片上已经裁过了）
    //    - encode.crf 降低到 28 以加快编码
    const previewObf: ObfuscationOptions = {
      ...req.obfuscation,
      trim: { startSec: 0, endSec: 0, middleRemoveSec: 0, randomStartJitter: false },
      concat: {},
      encode: { crf: Math.max(req.obfuscation.encode.crf, 28) }
    }

    if (req.mode === 'transform') {
      const r = await transformVideo(ffmpeg, ffprobe, tmpInputCut, tmpOutput, previewObf)
      if (!r.ok) return { ok: false, error: r.error || '预览渲染失败' }
    } else {
      if (!req.insertPath) return { ok: false, error: '预览模式 stitch 需要 insertPath' }
      const r = await stitchVideo(
        ffmpeg,
        ffprobe,
        tmpInputCut,
        req.insertPath,
        tmpOutput,
        req.insertSizePx ?? 1,
        req.insertPositions ?? [
          { side: 'top', offsetPx: 0 },
          { side: 'bottom', offsetPx: 0 }
        ],
        previewObf
      )
      if (!r.ok) return { ok: false, error: r.error || '预览渲染失败' }
    }

    const st = statSync(tmpOutput)
    if (st.size > PREVIEW_MAX_BYTES) {
      return { ok: false, error: `预览文件过大 (${(st.size / 1024 / 1024).toFixed(1)}MB)` }
    }
    const buf = readFileSync(tmpOutput)
    return {
      ok: true,
      base64: buf.toString('base64'),
      mime: 'video/mp4',
      durationSec: wantDur
    }
  } catch (e) {
    return { ok: false, error: String(e) }
  } finally {
    try {
      rmSync(workDir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
}

function cutWithStreamCopy(
  ffmpeg: string,
  input: string,
  out: string,
  startSec: number,
  durSec: number
): Promise<boolean> {
  return new Promise((resolve) => {
    // -ss 放在 -i 前以做关键帧搜索，速度快但精度差；预览容忍 100~500ms 偏差
    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-ss',
      startSec.toFixed(3),
      '-i',
      input,
      '-t',
      durSec.toFixed(3),
      '-c',
      'copy',
      '-avoid_negative_ts',
      'make_zero',
      '-y',
      out
    ]
    const child = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'ignore'] })
    child.on('error', () => resolve(false))
    child.on('close', (code) => resolve(code === 0))
  })
}
