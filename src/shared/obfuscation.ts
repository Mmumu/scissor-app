/**
 * Scissor 过原创 / 混剪 的统一配置模型（单一真理源）。
 *
 * 设计原则：
 * - "是否启用 + 强度"两层结构，避免老代码里 "布尔开关 → 内部随机" 的二态。
 * - jitter / randomXxx 用显式布尔字段表达，便于在 UI 上和导出时都精准回放。
 * - transform 路径与 stitch 路径共用同一份模型；stitch 特有的"边缘条带"参数不在此处。
 */

import type { StickerItem } from './types'
export type { StickerItem }

export type ObfuscationPreset = 'custom' | 'douyin' | 'xiaohongshu' | 'bilibili' | 'youtube'

export type BottomCoverType = 'blur' | 'black' | 'crop'
export type AudioEqMode = 'off' | 'cutoff' | 'random3band'

export type ObfuscationOptions = {
  preset: ObfuscationPreset

  /** 几何：翻转 / 旋转 / 裁切 */
  geometry: {
    enabled: boolean
    hflip: boolean
    /** 固定旋转角度 ±2°；0 即不固定 */
    rotateDeg: number
    /** 额外叠加 ±0.3° 隐式随机抖动（每次导出重新摇） */
    rotateJitter: boolean
    /** true = 四边随机裁 2~7px；false = 用 cropPx 对称裁切 */
    randomCrop: boolean
    cropPx: number
  }

  /** 色彩：色相 / 饱和 / 亮度 / 对比度 / RGB 通道 / 噪点 */
  color: {
    enabled: boolean
    /** ±10° */
    hue: number
    /** 0.9 ~ 1.1 */
    saturation: number
    /** -0.05 ~ 0.05 */
    brightness: number
    /** 0.95 ~ 1.05 */
    contrast: number
    /** RGB 通道独立微调 */
    colorMix: boolean
    /** 0 ~ 8 */
    noise: number
  }

  /** 细节：锐化 / 模糊 */
  detail: {
    enabled: boolean
    /** -1 ~ 1，正值锐化，负值柔化 */
    unsharp: number
    /** 0 = 关闭；>0 时先 gblur 再叠 unsharp，破坏纹理指纹 */
    gblurSigma: number
  }

  /** LUT 电影滤镜 */
  lut: {
    path?: string
    /** 0 ~ 1 */
    intensity: number
  }

  /** 全局变速 */
  speed: {
    enabled: boolean
    /** 1.001 ~ 1.020；超出区间也可，但 atempo 单段需 0.5~2.0 */
    rate: number
    /** 启用后导出时再叠加 ±2% 随机抖动到 rate */
    jitter: boolean
  }

  audio: {
    enabled: boolean
    /** 音频变调倍率；与 speed.rate 共同决定 atempo */
    pitchRate: number
    /** off=不做EQ；cutoff=固定 85Hz/15.5kHz 切除；random3band=3 段随机 ±1.5dB */
    eqMode: AudioEqMode
    /** 音量随机微调（1.01~1.04） */
    volumeJitter: boolean
  }

  /** 时间裁剪 */
  trim: {
    startSec: number
    endSec: number
    /** 中间删除（跳剪）秒数；0=关闭 */
    middleRemoveSec: number
    /** 在 startSec 基础上再叠加 0.1~0.5s 随机抖动 */
    randomStartJitter: boolean
  }

  /** 底部遮挡（去字幕） */
  cover: {
    /** 0 ~ 0.5 */
    bottomRatio: number
    bottomType: BottomCoverType
  }

  stickers: StickerItem[]

  metadata: {
    /** -map_metadata -1 */
    strip: boolean
    /** 注入随机伪造编码器/创建时间 */
    fakeEncoder: boolean
  }

  /** 片头片尾短片（拼接） */
  concat: {
    introPath?: string
    outroPath?: string
  }

  encode: {
    /** 18 ~ 30 */
    crf: number
  }
}

/** 全默认值（等价于"完全自定义、温和参数"） */
export const DEFAULT_OBFUSCATION: ObfuscationOptions = {
  preset: 'custom',
  geometry: {
    enabled: true,
    hflip: false,
    rotateDeg: 0,
    rotateJitter: true,
    randomCrop: true,
    cropPx: 4
  },
  color: {
    enabled: true,
    hue: 2,
    saturation: 1.02,
    brightness: 0.02,
    contrast: 1.0,
    colorMix: true,
    noise: 3
  },
  detail: {
    enabled: true,
    unsharp: 0.2,
    gblurSigma: 0
  },
  lut: {
    intensity: 1.0
  },
  speed: {
    enabled: true,
    rate: 1.005,
    jitter: false
  },
  audio: {
    enabled: true,
    pitchRate: 1.03,
    eqMode: 'cutoff',
    volumeJitter: false
  },
  trim: {
    startSec: 0,
    endSec: 0,
    middleRemoveSec: 0,
    randomStartJitter: false
  },
  cover: {
    bottomRatio: 0,
    bottomType: 'blur'
  },
  stickers: [],
  metadata: {
    strip: true,
    fakeEncoder: true
  },
  concat: {},
  encode: {
    crf: 23
  }
}

/**
 * Preset 表：基于 DEFAULT_OBFUSCATION 派生。
 * 切换 preset 后会**覆盖**对应字段；用户已经手动改过的字段不保留 ——
 * UI 层应在切换前给出"将覆盖你的自定义参数"提示。
 */
type PresetBuilder = (base: ObfuscationOptions) => ObfuscationOptions

export const PRESET_BUILDERS: Record<ObfuscationPreset, PresetBuilder> = {
  custom: (b) => ({ ...b, preset: 'custom' }),

  // 抖音：音频指纹 + CNN embedding 双查重；几何小动 + 音频要狠
  douyin: (b) => ({
    ...b,
    preset: 'douyin',
    geometry: { ...b.geometry, enabled: true, rotateJitter: true, randomCrop: true, cropPx: 4 },
    color: { ...b.color, enabled: true, hue: 3, saturation: 1.03, brightness: 0.015, contrast: 1.0, colorMix: true, noise: 2 },
    detail: { ...b.detail, enabled: true, unsharp: 0.3, gblurSigma: 0.2 },
    speed: { ...b.speed, enabled: true, rate: 1.005, jitter: true },
    audio: { ...b.audio, enabled: true, pitchRate: 1.03, eqMode: 'random3band', volumeJitter: true },
    trim: { ...b.trim, randomStartJitter: true },
    metadata: { strip: true, fakeEncoder: true }
  }),

  // 小红书：以 dHash / pHash 为主，色彩猛动几乎够用
  xiaohongshu: (b) => ({
    ...b,
    preset: 'xiaohongshu',
    geometry: { ...b.geometry, enabled: true, rotateJitter: true, randomCrop: true, cropPx: 4 },
    color: { ...b.color, enabled: true, hue: 5, saturation: 1.05, brightness: 0.02, contrast: 1.02, colorMix: true, noise: 3 },
    detail: { ...b.detail, enabled: true, unsharp: 0.4, gblurSigma: 0.3 },
    speed: { ...b.speed, enabled: true, rate: 1.008, jitter: false },
    audio: { ...b.audio, enabled: true, pitchRate: 1.02, eqMode: 'cutoff', volumeJitter: false },
    metadata: { strip: true, fakeEncoder: true }
  }),

  // B 站：审核相对宽松，温和参数即可
  bilibili: (b) => ({
    ...b,
    preset: 'bilibili',
    geometry: { ...b.geometry, enabled: true, rotateJitter: true, randomCrop: true, cropPx: 3 },
    color: { ...b.color, enabled: true, hue: 2, saturation: 1.02, brightness: 0.015, contrast: 1.0, colorMix: true, noise: 2 },
    detail: { ...b.detail, enabled: true, unsharp: 0.2, gblurSigma: 0 },
    speed: { ...b.speed, enabled: true, rate: 1.003, jitter: false },
    audio: { ...b.audio, enabled: true, pitchRate: 1.015, eqMode: 'cutoff', volumeJitter: false },
    metadata: { strip: true, fakeEncoder: true }
  }),

  // YouTube：Content ID 极强；像素扰动基本无效，主战场是「时间轴混剪」。
  // 此 preset 只是底线参数。
  youtube: (b) => ({
    ...b,
    preset: 'youtube',
    geometry: { ...b.geometry, enabled: true, hflip: false, rotateJitter: true, randomCrop: true, cropPx: 2 },
    color: { ...b.color, enabled: true, hue: 1, saturation: 1.01, brightness: 0.01, contrast: 1.0, colorMix: true, noise: 1 },
    detail: { ...b.detail, enabled: true, unsharp: 0.2, gblurSigma: 0.2 },
    speed: { ...b.speed, enabled: true, rate: 1.003, jitter: true },
    audio: { ...b.audio, enabled: true, pitchRate: 1.025, eqMode: 'random3band', volumeJitter: true },
    metadata: { strip: true, fakeEncoder: true }
  })
}

export function applyPreset(p: ObfuscationPreset, base = DEFAULT_OBFUSCATION): ObfuscationOptions {
  return PRESET_BUILDERS[p](base)
}

export const PRESET_META: Record<ObfuscationPreset, { label: string; hint: string }> = {
  custom: { label: '自定义', hint: '所有参数手动调整' },
  douyin: { label: '抖音', hint: '音频指纹 + 几何小动；侧重破坏音频/embedding' },
  xiaohongshu: { label: '小红书', hint: '色彩+纹理猛动；适合 dHash/pHash 主导平台' },
  bilibili: { label: 'B 站', hint: '温和参数，画质优先' },
  youtube: { label: 'YouTube', hint: '底线参数；强查重请用时间轴混剪' }
}
