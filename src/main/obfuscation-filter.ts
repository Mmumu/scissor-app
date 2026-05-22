/**
 * 共享的 ffmpeg filter 构造器。
 *
 * 对外暴露三件事：
 *   1) buildVideoFingerprintFilters — 顺序敏感的视频滤镜链（不含 trim / sticker / LUT / 底栏）
 *   2) buildAudioFingerprintFilters — 音频滤镜链（trim 之后接）
 *   3) buildMetadataArgs            — ffmpeg 命令行的 metadata 相关 -arg
 *
 * 与 transformVideo 调用关系：
 *   完整管线 = [trim] -> [vFingerprint] -> [LUT] -> [底栏] -> [stickers] -> [final scale]
 *   完整音频 = [atrim] -> [aFingerprint]
 *   transformVideo / stitchVideo 各自负责拼装这条管线；本文件只产出"扰动"部分。
 */

import type { ObfuscationOptions } from '../shared/obfuscation'

export type Dims = { w: number; h: number }

/**
 * 视频指纹扰动滤镜串。
 * 不含 trim、不含 stickers、不含 LUT、不含底栏；这些是结构滤镜，由调用方拼。
 * srcDims 用于最后强制缩放回源尺寸（消除中间滤镜浮点误差）。
 */
export function buildVideoFingerprintFilters(
  opts: ObfuscationOptions,
  srcDims?: Dims
): string[] {
  const f: string[] = []

  // ── 几何 ───────────────────────────────────────────
  if (opts.geometry.enabled) {
    const baseDeg = opts.geometry.rotateDeg || 0
    const jitter = opts.geometry.rotateJitter ? Math.random() * 0.6 - 0.3 : 0
    const deg = baseDeg + jitter
    if (Math.abs(deg) > 0.001) {
      const rad = ((deg * Math.PI) / 180).toFixed(5)
      // 就地旋转：保持原始宽高，角落黑边 <3px 不可见
      f.push(`rotate=${rad}:ow=iw:oh=ih:c=black`)
    }

    if (opts.geometry.randomCrop) {
      const L = 2 + Math.floor(Math.random() * 6)
      const R = 2 + Math.floor(Math.random() * 6)
      const T = 2 + Math.floor(Math.random() * 6)
      const B = 2 + Math.floor(Math.random() * 6)
      f.push(`crop=iw-${L}-${R}:ih-${T}-${B}:${L}:${T}`)
    } else if (opts.geometry.cropPx > 0) {
      const c = Math.max(0, Math.floor(opts.geometry.cropPx))
      f.push(`crop=trunc((iw-${c * 2})/2)*2:trunc((ih-${c * 2})/2)*2:${c}:${c}`)
    }

    if (opts.geometry.hflip) f.push('hflip')
  }

  // ── 变速（PTS） ────────────────────────────────────
  if (opts.speed.enabled) {
    const baseRate = opts.speed.rate || 1.0
    const j = opts.speed.jitter ? 0.98 + Math.random() * 0.04 : 1.0
    const rate = baseRate * j
    if (Math.abs(rate - 1.0) > 1e-4) {
      f.push(`setpts=${(1 / rate).toFixed(6)}*PTS`)
    }
  }

  // ── 色彩 ──────────────────────────────────────────
  if (opts.color.enabled) {
    const hue = opts.color.hue || 0
    const sat = opts.color.saturation || 1.0
    if (Math.abs(hue) > 0.01 || Math.abs(sat - 1.0) > 1e-4) {
      f.push(`hue=h=${hue.toFixed(2)}:s=${sat.toFixed(4)}`)
    }
    const b = opts.color.brightness || 0
    const c = opts.color.contrast || 1.0
    if (Math.abs(b) > 1e-4 || Math.abs(c - 1.0) > 1e-4) {
      f.push(`eq=brightness=${b.toFixed(4)}:contrast=${c.toFixed(4)}`)
    }
    if (opts.color.colorMix) {
      const rr = (0.99 + Math.random() * 0.02).toFixed(3)
      const gg = (0.99 + Math.random() * 0.02).toFixed(3)
      const bb = (0.99 + Math.random() * 0.02).toFixed(3)
      f.push(`colorchannelmixer=rr=${rr}:gg=${gg}:bb=${bb}`)
    }
    if (opts.color.noise > 0) {
      const n = Math.min(20, Math.max(0, Math.floor(opts.color.noise)))
      f.push(`noise=alls=${n}:allf=t+u`)
    }
  }

  // ── 细节（gblur 必须先于 unsharp） ─────────────────
  if (opts.detail.enabled) {
    const sigma = opts.detail.gblurSigma || 0
    if (sigma > 0.01) {
      f.push(`gblur=sigma=${sigma.toFixed(2)}:steps=1`)
    }
    const us = opts.detail.unsharp || 0
    if (Math.abs(us) > 1e-4) {
      f.push(`unsharp=3:3:${us.toFixed(2)}:3:3:0`)
    }
  }

  // ── 收尾 scale + format ───────────────────────────
  if (srcDims && srcDims.w > 0 && srcDims.h > 0) {
    const tw = srcDims.w & ~1
    const th = srcDims.h & ~1
    f.push(`scale=${tw}:${th}:flags=lanczos`)
  } else {
    f.push('scale=trunc(iw/2)*2:trunc(ih/2)*2')
  }
  f.push('format=yuv420p')
  return f
}

/**
 * 音频指纹扰动滤镜串。
 * 与 speed/pitch 联动：tempo = speed / pitchRate。
 * hasAudio = false 时返回空串。
 */
export function buildAudioFingerprintFilters(opts: ObfuscationOptions): string[] {
  if (!opts.audio.enabled) return []
  const f: string[] = []
  const BASE_SR = 44100

  const baseRate = opts.speed.enabled ? opts.speed.rate || 1.0 : 1.0
  const speedJ = opts.speed.enabled && opts.speed.jitter ? 0.98 + Math.random() * 0.04 : 1.0
  const speedFinal = baseRate * speedJ
  const pitchRate = opts.audio.pitchRate || 1.0
  const tempoRatio = speedFinal / pitchRate

  if (Math.abs(pitchRate - 1.0) > 1e-4) {
    f.push(`asetrate=${BASE_SR}*${pitchRate.toFixed(6)}`)
    f.push(`aresample=${BASE_SR}`)
  }

  if (Math.abs(tempoRatio - 1.0) > 1e-4) {
    if (tempoRatio >= 0.5 && tempoRatio <= 2.0) {
      f.push(`atempo=${tempoRatio.toFixed(6)}`)
    } else if (tempoRatio < 0.5) {
      f.push(`atempo=0.5,atempo=${(tempoRatio / 0.5).toFixed(6)}`)
    } else {
      f.push(`atempo=2.0,atempo=${(tempoRatio / 2.0).toFixed(6)}`)
    }
  }

  if (opts.audio.volumeJitter) {
    const vol = (1.01 + Math.random() * 0.03).toFixed(3)
    f.push(`volume=${vol}`)
  }

  if (opts.audio.eqMode === 'cutoff') {
    f.push('highpass=f=85', 'lowpass=f=15500')
  } else if (opts.audio.eqMode === 'random3band') {
    const bands = [
      { f: 100 + Math.floor(Math.random() * 200), g: Math.random() * 3 - 1.5 },
      { f: 500 + Math.floor(Math.random() * 1500), g: Math.random() * 3 - 1.5 },
      { f: 3000 + Math.floor(Math.random() * 5000), g: Math.random() * 3 - 1.5 }
    ]
    for (const b of bands) {
      f.push(`equalizer=f=${b.f}:width_type=o:width=1:g=${b.g.toFixed(2)}`)
    }
  }

  return f
}

/** ffmpeg -metadata 相关 cmd arg。返回数组直接 spread 到 args。 */
export function buildMetadataArgs(opts: ObfuscationOptions): string[] {
  const out: string[] = []
  if (opts.metadata.strip) {
    out.push('-map_metadata', '-1')
  }
  if (opts.metadata.fakeEncoder) {
    const fakeEncoders = ['Lavf58.76.100', 'Lavf59.27.100', 'Lavf60.3.100', 'Lavf61.1.100']
    const enc = fakeEncoders[Math.floor(Math.random() * fakeEncoders.length)]
    const past = Date.now() - Math.random() * 365 * 24 * 3600 * 1000
    const fakeDate = new Date(past).toISOString().replace('T', ' ').slice(0, 19)
    out.push('-metadata', `encoder=${enc}`)
    out.push('-metadata', `creation_time=${fakeDate}`)
  }
  return out
}

/**
 * 计算"实际生效的首段裁剪秒数"（含 trim.randomStartJitter）。
 * 调用方应使用此值作为 atrim/trim 的 start 起点。
 */
export function computeEffectiveTrimStart(opts: ObfuscationOptions): number {
  const base = Math.max(0, opts.trim.startSec || 0)
  if (!opts.trim.randomStartJitter) return base
  return +(base + 0.1 + Math.random() * 0.4).toFixed(3)
}
