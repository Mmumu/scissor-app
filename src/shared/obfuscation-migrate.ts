/**
 * 新旧配置模型互转。
 * 旧模型 (TransformOptions / stitch obfOpts) 暂时保留以兼容外部调用；
 * 内部统一使用 ObfuscationOptions。
 */

import type { TransformOptions, StickerItem } from './types'
import { DEFAULT_OBFUSCATION, type ObfuscationOptions } from './obfuscation'

/** 旧 stitch 的 obfOpts 字段集 */
export type LegacyStitchObfOpts = {
  flip?: boolean
  colorNoise?: boolean
  audioObf?: boolean
  speedJitter?: boolean
  trimStart?: boolean
  hueSat?: boolean
  cleanMeta?: boolean
  blurSharpen?: boolean
  audioEQ?: boolean
  bottomCoverRatio?: number
  bottomCoverType?: 'blur' | 'black' | 'crop'
  stickers?: StickerItem[]
}

export function fromTransformOptions(t: TransformOptions): ObfuscationOptions {
  return {
    preset: 'custom',
    geometry: {
      enabled: true,
      hflip: !!t.hflip,
      rotateDeg: t.rotateDeg ?? 0,
      // transformVideo 内部隐式叠加 ±0.3° 抖动，所以这里保持 true 以保留旧行为
      rotateJitter: true,
      randomCrop: !!t.randomCrop,
      cropPx: t.cropPx ?? 4
    },
    color: {
      enabled: true,
      hue: t.hue ?? 0,
      saturation: t.saturation ?? 1.0,
      brightness: t.brightness ?? 0,
      contrast: 1.0,
      colorMix: !!t.colorMix,
      noise: t.noise ?? 0
    },
    detail: {
      enabled: (t.unsharp ?? 0) !== 0,
      unsharp: t.unsharp ?? 0,
      gblurSigma: 0
    },
    lut: {
      path: t.lut3dPath,
      intensity: t.lut3dIntensity ?? 1.0
    },
    speed: {
      enabled: true,
      rate: t.speed ?? 1.0,
      jitter: false
    },
    audio: {
      enabled: true,
      pitchRate: t.pitchRate ?? 1.03,
      eqMode: t.audioEq ? 'cutoff' : 'off',
      volumeJitter: false
    },
    trim: {
      startSec: t.trimStartSec ?? 0,
      endSec: t.trimEndSec ?? 0,
      middleRemoveSec: t.middleRemoveSec ?? 0,
      randomStartJitter: false
    },
    cover: {
      bottomRatio: t.bottomCoverRatio ?? 0,
      bottomType: t.bottomCoverType ?? 'blur'
    },
    stickers: t.stickers ?? [],
    metadata: {
      strip: false,
      fakeEncoder: false
    },
    concat: {
      introPath: t.introVideoPath,
      outroPath: t.outroVideoPath
    },
    encode: {
      crf: t.crf ?? 23
    }
  }
}

export function toTransformOptions(o: ObfuscationOptions): TransformOptions {
  return {
    speed: o.speed.enabled ? o.speed.rate : 1.0,
    hue: o.color.enabled ? o.color.hue : 0,
    brightness: o.color.enabled ? o.color.brightness : 0,
    saturation: o.color.enabled ? o.color.saturation : 1.0,
    noise: o.color.enabled ? o.color.noise : 0,
    hflip: o.geometry.enabled && o.geometry.hflip,
    cropPx: o.geometry.enabled ? o.geometry.cropPx : 0,
    rotateDeg: o.geometry.enabled ? o.geometry.rotateDeg : 0,
    randomCrop: o.geometry.enabled && o.geometry.randomCrop,
    unsharp: o.detail.enabled ? o.detail.unsharp : 0,
    pitchRate: o.audio.enabled ? o.audio.pitchRate : 1.0,
    audioEq: o.audio.enabled && o.audio.eqMode === 'cutoff',
    colorMix: o.color.enabled && o.color.colorMix,
    crf: o.encode.crf,
    bottomCoverRatio: o.cover.bottomRatio,
    bottomCoverType: o.cover.bottomType,
    stickers: o.stickers,
    trimStartSec: o.trim.startSec,
    trimEndSec: o.trim.endSec,
    middleRemoveSec: o.trim.middleRemoveSec,
    introVideoPath: o.concat.introPath,
    outroVideoPath: o.concat.outroPath,
    lut3dPath: o.lut.path,
    lut3dIntensity: o.lut.intensity
  }
}

/**
 * 旧 stitch obfOpts → ObfuscationOptions。
 * 老的 stitch 是"开关 → 内部随机"，迁移时保持等价语义：把内部那一组随机参数显式打开。
 */
export function fromLegacyStitchObfOpts(o: LegacyStitchObfOpts | undefined): ObfuscationOptions {
  const opts: ObfuscationOptions = JSON.parse(JSON.stringify(DEFAULT_OBFUSCATION))
  if (!o) return opts

  // 几何
  opts.geometry.enabled = !!(o.flip || o.colorNoise)
  opts.geometry.hflip = !!o.flip
  opts.geometry.rotateJitter = !!o.colorNoise
  opts.geometry.randomCrop = !!o.colorNoise

  // 色彩：colorNoise 把裁/旋/RGB/亮度/对比度/噪点一起打开；hueSat 单独控制色相
  opts.color.enabled = !!(o.colorNoise || o.hueSat)
  opts.color.colorMix = !!o.colorNoise
  opts.color.noise = o.colorNoise ? 2 : 0
  opts.color.brightness = o.colorNoise ? 0.01 : 0
  opts.color.contrast = o.colorNoise ? 1.01 : 1.0
  opts.color.hue = o.hueSat ? 3 : 0
  opts.color.saturation = o.hueSat ? 1.025 : 1.0

  // 细节
  opts.detail.enabled = !!o.blurSharpen
  opts.detail.unsharp = o.blurSharpen ? 0.4 : 0
  opts.detail.gblurSigma = o.blurSharpen ? 0.35 : 0

  // 速度
  opts.speed.enabled = !!o.speedJitter
  opts.speed.rate = 1.0
  opts.speed.jitter = !!o.speedJitter

  // 音频
  opts.audio.enabled = !!(o.audioObf || o.audioEQ)
  opts.audio.pitchRate = o.audioObf ? 1.02 : 1.0
  opts.audio.eqMode = o.audioEQ ? 'random3band' : 'off'
  opts.audio.volumeJitter = !!o.audioObf

  // 裁剪首段
  opts.trim.randomStartJitter = !!o.trimStart

  // 底栏 & 贴纸
  opts.cover.bottomRatio = o.bottomCoverRatio ?? 0
  opts.cover.bottomType = o.bottomCoverType ?? 'blur'
  opts.stickers = o.stickers ?? []

  // metadata
  opts.metadata.strip = !!o.cleanMeta
  opts.metadata.fakeEncoder = !!o.cleanMeta

  return opts
}
