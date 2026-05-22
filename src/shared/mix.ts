import type { ObfuscationOptions } from './obfuscation'

/**
 * 混剪台时间线模型。
 *
 * 设计取舍：
 *  - 暂时不做"每段独立 trim"——用户要剪的话回素材池删
 *  - 暂时不做"每段独立速度/转场"——MVP 全局参数足够
 *  - 音频：要么不替换（用素材自带音轨拼接），要么用一个 audioId 单段替换（loop+shortest）
 */

export type MixAudioMode =
  | 'embed' // 用素材段自身的音轨拼接（要求所有段都有音轨，否则降级）
  | 'replace' // 用 audioIds 拼成一条替换
  | 'silent' // 静音

export type TargetResolution = 'source' | '720p' | '1080p' | 'vertical-1080' | 'vertical-720'

export type MixTimeline = {
  /** 视频段顺序 */
  clipIds: string[]
  audioMode: MixAudioMode
  /** replace 模式下使用的音频顺序 */
  audioIds: string[]
  /** 外部音频时是否循环填满视频 */
  audioLoop: boolean
  /** 目标分辨率 */
  target: TargetResolution
  /** 过原创参数（应用到拼接后的整片） */
  obfuscation: ObfuscationOptions
}

export type MixRenderRequest = {
  timeline: MixTimeline
  outputPath: string
}

export type MixPreviewRequest = {
  timeline: MixTimeline
  /** 最长预览秒数，默认 3 */
  maxSec?: number
  /** 是否带 obfuscation，默认 true（这就是预览的意义） */
  withObfuscation?: boolean
}

export type MixRenderResult = {
  ok: boolean
  outputPath?: string
  error?: string
}

export type MixPreviewResult = {
  ok: boolean
  base64?: string
  mime?: string
  durationSec?: number
  error?: string
}

export type MixRenderProgressEvent =
  | { phase: 'preparing'; pct?: number }
  | { phase: 'concat'; pct: number }
  | { phase: 'audio'; pct?: number }
  | { phase: 'obfuscation'; pct: number; rawMsg?: string }
  | { phase: 'done'; outputPath: string }
  | { phase: 'error'; error: string }

export type MixProjectMeta = {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  timeline: MixTimeline
}

export function resolveTargetDims(
  target: TargetResolution,
  fallback: { w: number; h: number }
): { w: number; h: number } {
  switch (target) {
    case 'source':
      return { w: fallback.w & ~1, h: fallback.h & ~1 }
    case '720p':
      return { w: 1280, h: 720 }
    case '1080p':
      return { w: 1920, h: 1080 }
    case 'vertical-720':
      return { w: 720, h: 1280 }
    case 'vertical-1080':
      return { w: 1080, h: 1920 }
  }
}

export const TARGET_LABEL: Record<TargetResolution, string> = {
  source: '跟随源',
  '720p': '720p (横)',
  '1080p': '1080p (横)',
  'vertical-720': '720p (竖)',
  'vertical-1080': '1080p (竖)'
}
