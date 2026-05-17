import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { ffprobeVideoDims, spawnFfmpeg, anchorToXY, enableExpr } from './ffmpeg-utils'

const execFileAsync = promisify(execFile)

import type { StickerItem } from '../shared/types'

export type StitchDirection = 'vertical' | 'horizontal'
export type InsertSide = 'top' | 'bottom' | 'left' | 'right'
export interface InsertPosition { side: InsertSide; offsetPx: number }

export async function stitchVideo(
  ffmpeg: string,
  ffprobe: string,
  mainPath: string,
  insertPath: string,
  outputPath: string,
  insertSizePx: number,
  insertPositions: InsertPosition[],
  obfOpts?: { flip?: boolean; colorNoise?: boolean; audioObf?: boolean; speedJitter?: boolean; trimStart?: boolean; hueSat?: boolean; cleanMeta?: boolean; blurSharpen?: boolean; audioEQ?: boolean; bottomCoverRatio?: number; bottomCoverType?: 'blur' | 'black' | 'crop'; stickers?: StickerItem[] },
  onProgress?: (msg: string) => void,
  signal?: AbortSignal
): Promise<{ ok: boolean; error?: string }> {
  if (!existsSync(mainPath)) return { ok: false, error: '主视频不存在' }
  if (!existsSync(insertPath)) return { ok: false, error: '插入视频不存在' }

  const dims = await ffprobeVideoDims(ffprobe, mainPath)
  if (!dims) return { ok: false, error: '无法读取主视频分辨率' }

  // Get A's framerate to normalize B — this is CRITICAL to avoid slow-motion
  let fps = '30'
  try {
    const probeArgs = ['-v', 'quiet', '-select_streams', 'v:0', '-show_entries', 'stream=r_frame_rate', '-of', 'csv=p=0', mainPath]
    const { stdout } = await execFileAsync(ffprobe, probeArgs)
    const raw = stdout.trim()
    const [num, den] = raw.split('/').map(Number)
    if (num > 0 && den > 0) fps = String((num / den).toFixed(6))
  } catch { /* keep default 30 */ }

  const P = Math.max(2, Math.round(insertSizePx / 2) * 2)
  const fcParts: string[] = []

  // Pre-compute random values for new obfuscation options
  const speedFactor = obfOpts?.speedJitter
    ? +(0.97 + Math.random() * 0.06).toFixed(5)   // 0.97~1.03
    : 1.0
  const startTrimSec = obfOpts?.trimStart
    ? +(0.1 + Math.random() * 0.4).toFixed(3)      // 0.1~0.5s
    : 0

  // Apply visual obfuscation to A if requested
  const aFilters: string[] = []

  // 0. Trim start (must be first in chain)
  if (startTrimSec > 0) {
    aFilters.push(`trim=start=${startTrimSec},setpts=PTS-STARTPTS`)
  }

  if (obfOpts?.flip) aFilters.push('hflip')
  
  if (obfOpts?.colorNoise) {
    // 1. 微量随机裁剪 (1~8像素，范围略扩)
    const L = 1 + Math.floor(Math.random() * 8)
    const R = 1 + Math.floor(Math.random() * 8)
    const T = 1 + Math.floor(Math.random() * 8)
    const B = 1 + Math.floor(Math.random() * 8)
    aFilters.push(`crop=iw-${L}-${R}:ih-${T}-${B}:${L}:${T}`)
    aFilters.push(`scale=trunc((iw+${L+R})/2)*2:trunc((ih+${T+B})/2)*2:flags=lanczos`)
    
    // 2. 极小随机旋转，就地旋转保持原始尺寸(角落黑边<3px不可见)
    const maxDeg = 0.1 + Math.random() * 0.4
    const deg = (Math.random() * 2 - 1) * maxDeg
    const rad = (deg * Math.PI / 180).toFixed(5)
    aFilters.push(`rotate=${rad}:ow=iw:oh=ih:c=black`)
    
    // 3. RGB 通道微调（已随机）+ 亮度/对比度也随机
    const rr = (0.99 + Math.random() * 0.02).toFixed(3)
    const gg = (0.99 + Math.random() * 0.02).toFixed(3)
    const bb = (0.99 + Math.random() * 0.02).toFixed(3)
    aFilters.push(`colorchannelmixer=rr=${rr}:gg=${gg}:bb=${bb}`)
    const brightness = (0.005 + Math.random() * 0.010).toFixed(4)  // 0.005~0.015
    const contrast = (1.005 + Math.random() * 0.010).toFixed(4)    // 1.005~1.015
    aFilters.push(`eq=brightness=${brightness}:contrast=${contrast}`)
    
    // 4. 微弱动态噪点，强度随机 1~3
    const noiseStr = 1 + Math.floor(Math.random() * 3)
    aFilters.push(`noise=alls=${noiseStr}:allf=t+u`)
  }

  // 5. 色调 + 饱和度随机偏移（±5°，±5%）
  if (obfOpts?.hueSat) {
    const hueDeg = (Math.random() * 10 - 5).toFixed(2)         // ±5°
    const satMult = (0.95 + Math.random() * 0.10).toFixed(3)   // 0.95~1.05
    aFilters.push(`hue=h=${hueDeg}:s=${satMult}`)
  }

  // 6. 全局变速（视频时间轴缩放）
  if (speedFactor !== 1.0) {
    aFilters.push(`setpts=${(1 / speedFactor).toFixed(6)}*PTS`)
  }

  // 7. 轻微虚化再锐化 — 改变像素纹理指纹，sigma 和锐化量随机
  if (obfOpts?.blurSharpen) {
    const sigma = (0.2 + Math.random() * 0.3).toFixed(2)          // 0.2~0.5
    const sharpenLuma = (0.2 + Math.random() * 0.4).toFixed(2)    // 0.2~0.6
    aFilters.push(`gblur=sigma=${sigma}:steps=1`)
    aFilters.push(`unsharp=3:3:${sharpenLuma}:3:3:0`)
  }
  
  if (aFilters.length > 0) {
    // 保底：还原到源视频精确尺寸，消除旋转/裁剪引入的浮点取整误差
    const tw = dims.w & ~1
    const th = dims.h & ~1
    aFilters.push(`scale=${tw}:${th}:flags=lanczos`)
    fcParts.push(`[0:v]${aFilters.join(',')}[v0_obf]`)
  } else {
    fcParts.push(`[0:v]copy[v0_obf]`)
  }

  let currentH = dims.h
  let currentW = dims.w

  if (obfOpts?.bottomCoverRatio && obfOpts.bottomCoverRatio > 0) {
    const r = Math.min(0.5, obfOpts.bottomCoverRatio).toFixed(3)
    if (obfOpts.bottomCoverType === 'crop') {
      fcParts.push(`[v0_obf]crop=trunc(iw/2)*2:trunc((ih-ih*${r})/2)*2:0:0[vmain]`)
      currentH = Math.floor(currentH * (1 - Number(r)))
    } else if (obfOpts.bottomCoverType === 'black') {
      fcParts.push(`[v0_obf]drawbox=x=0:y=ih-ih*${r}:w=iw:h=ih*${r}:color=black@1.0:t=fill[vmain]`)
    } else {
      const cropH = Math.max(4, Math.floor(currentH * Number(r)))
      fcParts.push(`[v0_obf]split=2[base_orig][base_crop]`)
      fcParts.push(`[base_crop]crop=iw:${cropH}:0:ih-${cropH},gblur=sigma=20[blur_out]`)
      fcParts.push(`[base_orig][blur_out]overlay=0:main_h-overlay_h[vmain]`)
    }
  } else {
    fcParts.push(`[v0_obf]copy[vmain]`)
  }

  // Determine direction from insert positions (top/bottom → vertical, left/right → horizontal)
  const positions = insertPositions.length > 0 ? insertPositions : [{ side: 'top' as InsertSide, offsetPx: 0 }, { side: 'bottom' as InsertSide, offsetPx: 0 }]
  const hasVertical = positions.some(p => p.side === 'top' || p.side === 'bottom')
  const direction: StitchDirection = hasVertical ? 'vertical' : 'horizontal'

  // Prepare B strip — if multiple positions, split into N copies (FFmpeg pads can only be consumed once)
  if (direction === 'vertical') {
    const W = currentW
    const H = currentH
    if (H <= P + 2) return { ok: false, error: '主视频高度过小或插入像素过大' }
    fcParts.push(`[1:v]format=yuv420p,fps=${fps},scale=w=${W}:h=${P}:force_original_aspect_ratio=increase,crop=${W}:${P},setsar=1[bstrip_src]`)
    if (positions.length === 1) {
      fcParts.push(`[bstrip_src]copy[bstrip0]`)
    } else {
      fcParts.push(`[bstrip_src]split=${positions.length}${positions.map((_, i) => `[bstrip${i}]`).join('')}`)
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
    fcParts.push(`[1:v]format=yuv420p,fps=${fps},scale=w=${P}:h=${H}:force_original_aspect_ratio=increase,crop=${P}:${H},setsar=1[bstrip_src]`)
    if (positions.length === 1) {
      fcParts.push(`[bstrip_src]copy[bstrip0]`)
    } else {
      fcParts.push(`[bstrip_src]split=${positions.length}${positions.map((_, i) => `[bstrip${i}]`).join('')}`)
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

  // 确保最终输出宽度 = 源视频宽度（偶数），高度偶数对齐
  const finalW = dims.w & ~1
  fcParts.push(`[vcat_raw]scale=${finalW}:trunc(ih/2)*2,setsar=1,format=yuv420p[vcat]`)

  const stickers = obfOpts?.stickers || []
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
      // stickers start at index 2 (0: main, 1: insert)
      fcParts.push(`[${i + 2}:v]${scaleChain}[stimg${i}]`)
      fcParts.push(`${pipeBase}[stimg${i}]overlay=${anchorToXY(s)}${enableExpr(s)}:shortest=1${outTag}`)
      pipeBase = outTag
    })
  }

  // Audio: combine trim + speed + pitch obfuscation
  let audioMap = '0:a?'
  const needAudio = obfOpts?.audioObf || obfOpts?.audioEQ || speedFactor !== 1.0 || startTrimSec > 0
  if (needAudio) {
    const audioFilters: string[] = []
    // Trim audio start to match video
    if (startTrimSec > 0) {
      audioFilters.push(`atrim=start=${startTrimSec},asetpts=PTS-STARTPTS`)
    }
    if (obfOpts?.audioObf) {
      // 变调幅度随机 0.8%~2.5%，与变速合并成单个 atempo
      const pitchRate = 1.008 + Math.random() * 0.017
      const combinedTempo = (1.005 / pitchRate) * speedFactor
      const volume = (1.01 + Math.random() * 0.03).toFixed(3)
      const highpass = Math.floor(70 + Math.random() * 31)
      audioFilters.push(`asetrate=44100*${pitchRate.toFixed(5)},aresample=44100,atempo=${combinedTempo.toFixed(5)},volume=${volume},highpass=f=${highpass}`)
    } else if (speedFactor !== 1.0) {
      // 仅变速，不变调
      audioFilters.push(`atempo=${speedFactor.toFixed(5)}`)
    }
    if (obfOpts?.audioEQ) {
      // 3 个随机频段轻微增益/衰减（±1.5dB），每段各自随机中心频率
      const bands = [
        { f: Math.floor(100 + Math.random() * 200), g: (Math.random() * 3 - 1.5).toFixed(1) },   // 低频 100~300Hz
        { f: Math.floor(500 + Math.random() * 1500), g: (Math.random() * 3 - 1.5).toFixed(1) },  // 中频 500~2000Hz
        { f: Math.floor(3000 + Math.random() * 5000), g: (Math.random() * 3 - 1.5).toFixed(1) } // 高频 3000~8000Hz
      ]
      audioFilters.push(bands.map(b => `equalizer=f=${b.f}:width_type=o:width=1:g=${b.g}`).join(','))
    }
    if (audioFilters.length > 0) {
      fcParts.push(`[0:a]${audioFilters.join(',')}[aobf]`)
      audioMap = '[aobf]'
    }
  }

  const extraInputs: string[] = stickers.flatMap((s) => {
    if (s.imagePath.toLowerCase().endsWith('.gif')) {
      return ['-ignore_loop', '0', '-i', s.imagePath]
    }
    return ['-loop', '1', '-i', s.imagePath]
  })

  // Metadata: strip originals and inject randomized fake info
  const metaArgs: string[] = []
  if (obfOpts?.cleanMeta) {
    const fakeEncoders = ['Lavf58.76.100', 'Lavf59.27.100', 'Lavf60.3.100', 'Lavf61.1.100']
    const fakeEncoder = fakeEncoders[Math.floor(Math.random() * fakeEncoders.length)]
    const pastMs = Date.now() - Math.random() * 365 * 24 * 3600 * 1000
    const fakeDate = new Date(pastMs).toISOString().replace('T', ' ').slice(0, 19)
    metaArgs.push('-map_metadata', '-1')
    metaArgs.push('-metadata', `encoder=${fakeEncoder}`)
    metaArgs.push('-metadata', `creation_time=${fakeDate}`)
  }

  const args = [
    '-hide_banner',
    '-v', 'warning',
    '-stats',
    '-i', mainPath,
    '-stream_loop', '-1',
    '-i', insertPath,
    ...extraInputs,
    '-filter_complex', fcParts.join(';'),
    '-map', pipeBase,
    '-map', audioMap,
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '26',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-movflags', '+faststart',
    ...metaArgs,
    '-y',
    outputPath
  ]

  onProgress?.(`拼接视频: ffmpeg ${args.join(' ')}`)

  return spawnFfmpeg(ffmpeg, args, onProgress, 3_600_000, signal)
}
