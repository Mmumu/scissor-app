import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { ffprobeVideoDims, ffprobeHasAudio, spawnFfmpeg, anchorToXY, enableExpr } from './ffmpeg-utils'
import {
  buildAudioFingerprintFilters,
  buildMetadataArgs,
  buildVideoFingerprintFilters,
  computeEffectiveTrimStart
} from './obfuscation-filter'
import type { ObfuscationOptions } from '../shared/obfuscation'

const execFileAsync = promisify(execFile)

export type StitchDirection = 'vertical' | 'horizontal'
export type InsertSide = 'top' | 'bottom' | 'left' | 'right'
export interface InsertPosition {
  side: InsertSide
  offsetPx: number
}

/**
 * 边缘条带混剪：在主视频 A 的上下/左右某些边缘叠加来自 B 视频的细条带。
 * 视频/音频/metadata 扰动全部走 ObfuscationOptions 共享层。
 */
export async function stitchVideo(
  ffmpeg: string,
  ffprobe: string,
  mainPath: string,
  insertPath: string,
  outputPath: string,
  insertSizePx: number,
  insertPositions: InsertPosition[],
  obf: ObfuscationOptions,
  onProgress?: (msg: string) => void,
  signal?: AbortSignal
): Promise<{ ok: boolean; error?: string }> {
  if (!existsSync(mainPath)) return { ok: false, error: '主视频不存在' }
  if (!existsSync(insertPath)) return { ok: false, error: '插入视频不存在' }

  const dims = await ffprobeVideoDims(ffprobe, mainPath)
  if (!dims) return { ok: false, error: '无法读取主视频分辨率' }

  // 用 A 的帧率归一化 B，避免慢动作
  let fps = '30'
  try {
    const probeArgs = [
      '-v',
      'quiet',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=r_frame_rate',
      '-of',
      'csv=p=0',
      mainPath
    ]
    const { stdout } = await execFileAsync(ffprobe, probeArgs)
    const raw = stdout.trim()
    const [num, den] = raw.split('/').map(Number)
    if (num > 0 && den > 0) fps = String((num / den).toFixed(6))
  } catch {
    /* keep default 30 */
  }

  const P = Math.max(2, Math.round(insertSizePx / 2) * 2)
  const fcParts: string[] = []

  // ── 1. 主视频时间裁剪（trim） ────────────────────────
  const startTrimSec = computeEffectiveTrimStart(obf)
  const trimEndSec = Math.max(0, obf.trim.endSec || 0)
  const needsTrim = startTrimSec > 0 || trimEndSec > 0

  let vBase = '[0:v]'
  let aBase = '[0:a]'
  if (needsTrim) {
    let trimExpr = ''
    if (startTrimSec > 0) trimExpr += `start=${startTrimSec}`
    if (trimEndSec > 0) {
      const d = await ffprobeDurationSafe(ffprobe, mainPath)
      if (d && d > startTrimSec + trimEndSec + 0.15) {
        const end = +(d - trimEndSec).toFixed(3)
        trimExpr += (trimExpr ? ':' : '') + `end=${end}`
      }
    }
    if (trimExpr) {
      fcParts.push(`[0:v]trim=${trimExpr},setpts=PTS-STARTPTS[v_trim]`)
      fcParts.push(`[0:a]atrim=${trimExpr},asetpts=PTS-STARTPTS[a_trim]`)
      vBase = '[v_trim]'
      aBase = '[a_trim]'
    }
  }

  // ── 2. 应用共享视频扰动滤镜（含最后的强制 scale） ─────
  const vFingerprint = buildVideoFingerprintFilters(obf, dims)
  if (vFingerprint.length > 0) {
    fcParts.push(`${vBase}${vFingerprint.join(',')}[v0_obf]`)
  } else {
    fcParts.push(`${vBase}copy[v0_obf]`)
  }

  // ── 3. 底部遮挡 ────────────────────────────────────
  let currentH = dims.h
  const currentW = dims.w
  const r = Math.min(0.5, obf.cover.bottomRatio || 0)
  if (r > 0) {
    const rs = r.toFixed(3)
    if (obf.cover.bottomType === 'crop') {
      fcParts.push(`[v0_obf]crop=trunc(iw/2)*2:trunc((ih-ih*${rs})/2)*2:0:0[vmain]`)
      currentH = Math.floor(currentH * (1 - r))
    } else if (obf.cover.bottomType === 'black') {
      fcParts.push(`[v0_obf]drawbox=x=0:y=ih-ih*${rs}:w=iw:h=ih*${rs}:color=black@1.0:t=fill[vmain]`)
    } else {
      const cropH = Math.max(4, Math.floor(currentH * r))
      fcParts.push(`[v0_obf]split=2[base_orig][base_crop]`)
      fcParts.push(`[base_crop]crop=iw:${cropH}:0:ih-${cropH},gblur=sigma=20[blur_out]`)
      fcParts.push(`[base_orig][blur_out]overlay=0:main_h-overlay_h[vmain]`)
    }
  } else {
    fcParts.push(`[v0_obf]copy[vmain]`)
  }

  // ── 4. 插入条带 ────────────────────────────────────
  const positions =
    insertPositions.length > 0
      ? insertPositions
      : [
          { side: 'top' as InsertSide, offsetPx: 0 },
          { side: 'bottom' as InsertSide, offsetPx: 0 }
        ]
  const hasVertical = positions.some((p) => p.side === 'top' || p.side === 'bottom')
  const direction: StitchDirection = hasVertical ? 'vertical' : 'horizontal'

  if (direction === 'vertical') {
    const W = currentW
    const H = currentH
    if (H <= P + 2) return { ok: false, error: '主视频高度过小或插入像素过大' }
    fcParts.push(
      `[1:v]format=yuv420p,fps=${fps},scale=w=${W}:h=${P}:force_original_aspect_ratio=increase,crop=${W}:${P},setsar=1[bstrip_src]`
    )
    if (positions.length === 1) {
      fcParts.push(`[bstrip_src]copy[bstrip0]`)
    } else {
      fcParts.push(
        `[bstrip_src]split=${positions.length}${positions.map((_, i) => `[bstrip${i}]`).join('')}`
      )
    }
    let prevTag = '[vmain]'
    positions.forEach((pos, idx) => {
      const isLast = idx === positions.length - 1
      const outTag = isLast ? '[vcat_raw]' : `[vmid${idx}]`
      const offsetPx = Math.max(0, pos.offsetPx)
      const y = pos.side === 'top' ? offsetPx : H - P - offsetPx
      fcParts.push(`${prevTag}[bstrip${idx}]overlay=x=0:y=${y}:shortest=1${outTag}`)
      prevTag = outTag
    })
  } else {
    const W = currentW
    const H = currentH
    if (W <= P + 2) return { ok: false, error: '主视频宽度过小或插入像素过大' }
    fcParts.push(
      `[1:v]format=yuv420p,fps=${fps},scale=w=${P}:h=${H}:force_original_aspect_ratio=increase,crop=${P}:${H},setsar=1[bstrip_src]`
    )
    if (positions.length === 1) {
      fcParts.push(`[bstrip_src]copy[bstrip0]`)
    } else {
      fcParts.push(
        `[bstrip_src]split=${positions.length}${positions.map((_, i) => `[bstrip${i}]`).join('')}`
      )
    }
    let prevTag = '[vmain]'
    positions.forEach((pos, idx) => {
      const isLast = idx === positions.length - 1
      const outTag = isLast ? '[vcat_raw]' : `[vmid${idx}]`
      const offsetPx = Math.max(0, pos.offsetPx)
      const x = pos.side === 'left' ? offsetPx : W - P - offsetPx
      fcParts.push(`${prevTag}[bstrip${idx}]overlay=x=${x}:y=0:shortest=1${outTag}`)
      prevTag = outTag
    })
  }

  const finalW = dims.w & ~1
  fcParts.push(`[vcat_raw]scale=${finalW}:trunc(ih/2)*2,setsar=1,format=yuv420p[vcat]`)

  // ── 5. 贴纸 ────────────────────────────────────────
  const stickers = obf.stickers || []
  let pipeBase = '[vcat]'
  if (stickers.length > 0) {
    stickers.forEach((s, i) => {
      const alpha = Math.min(1, Math.max(0, s.opacity ?? 1)).toFixed(4)
      const fracRaw = s.widthFrac ?? 0
      const outTag = i === stickers.length - 1 ? '[vfinal]' : `[vst${i}]`
      let scaleChain: string
      if (fracRaw > 0) {
        const f = Math.min(0.95, Math.max(0.02, fracRaw))
        const tw = Math.max(4, Math.round((currentW * f) / 2) * 2)
        scaleChain = `scale=${tw}:-2:flags=lanczos,format=rgba,colorchannelmixer=aa=${alpha}`
      } else {
        scaleChain = `scale=iw:-1:flags=lanczos,format=rgba,colorchannelmixer=aa=${alpha}`
      }
      fcParts.push(`[${i + 2}:v]${scaleChain}[stimg${i}]`)
      fcParts.push(`${pipeBase}[stimg${i}]overlay=${anchorToXY(s)}${enableExpr(s)}:shortest=1${outTag}`)
      pipeBase = outTag
    })
  }

  // ── 6. 音频 ────────────────────────────────────────
  const hasAudio = await ffprobeHasAudio(ffprobe, mainPath)
  const aFingerprint = hasAudio ? buildAudioFingerprintFilters(obf) : []
  let audioMap: string | null = null
  if (hasAudio) {
    if (aFingerprint.length > 0) {
      fcParts.push(`${aBase}${aFingerprint.join(',')}[aobf]`)
      audioMap = '[aobf]'
    } else {
      audioMap = needsTrim ? '[a_trim]' : '0:a'
    }
  }

  // ── 7. 额外输入（贴纸图） ──────────────────────────
  const extraInputs: string[] = stickers.flatMap((s) => {
    if (s.imagePath.toLowerCase().endsWith('.gif')) {
      return ['-ignore_loop', '0', '-i', s.imagePath]
    }
    return ['-loop', '1', '-i', s.imagePath]
  })

  // ── 8. metadata ───────────────────────────────────
  const metaArgs = buildMetadataArgs(obf)

  const args = [
    '-hide_banner',
    '-v',
    'warning',
    '-stats',
    '-i',
    mainPath,
    '-stream_loop',
    '-1',
    '-i',
    insertPath,
    ...extraInputs,
    '-filter_complex',
    fcParts.join(';'),
    '-map',
    pipeBase,
    ...(audioMap ? ['-map', audioMap, '-c:a', 'aac', '-b:a', '192k'] : ['-an']),
    '-c:v',
    'libx264',
    '-preset',
    'medium',
    '-crf',
    String(obf.encode.crf ?? 26),
    '-movflags',
    '+faststart',
    ...metaArgs,
    '-y',
    outputPath
  ]

  onProgress?.(`边缘条带混剪: ffmpeg ${args.join(' ')}`)
  return spawnFfmpeg(ffmpeg, args, onProgress, 3_600_000, signal)
}

async function ffprobeDurationSafe(ffprobe: string, path: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync(ffprobe, [
      '-v',
      'quiet',
      '-show_entries',
      'format=duration',
      '-of',
      'csv=p=0',
      path
    ])
    const n = parseFloat(stdout.trim())
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}
