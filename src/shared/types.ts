export type DedupeGroup = {
  id: string
  files: { path: string; sha256: string; durationSec?: number }[]
  reason: 'sha256' | 'perceptual'
}

export type TimelineClip = {
  path: string
  startSec: number
  endSec: number
}

export type TransformOptions = {
  /** 变速比例（播放越快数值越大）；UI 约 1.001～1.02，默认 1.005 */
  speed: number
  /** 色调偏移度 -10 ~ 10，默认 2 */
  hue: number
  /** 亮度偏移 -0.05 ~ 0.05，默认 0.02 */
  brightness: number
  /** 饱和度倍数 0.9 ~ 1.1，默认 1.02 */
  saturation: number
  /** 噪点强度 0 ~ 8，默认 3 */
  noise: number
  /** 是否水平翻转，默认 false */
  hflip: boolean
  /** 轻微裁切再还原（像素），默认 4 */
  cropPx: number
  /** 微量旋转角度 -2 ~ 2，默认 0 */
  rotateDeg: number
  /** 是否开启非对称随机裁剪，默认 false */
  randomCrop: boolean
  /** 锐化/模糊程度 -1.0 ~ 1.0，默认 0（正数锐化，负数模糊） */
  unsharp: number
  /**
   * 音频变调倍率，默认 1.03（≈ +半音）
   * asetrate × pitchRate → 改变 Chroma/MFCC 频谱特征
   */
  pitchRate: number
  /** 是否开启音频高低频切除 (EQ)，默认 false */
  audioEq: boolean
  /** 是否开启 RGB 通道独立微调，默认 false */
  colorMix: boolean
  /**
   * 视频质量 (CRF)，范围 18 ~ 30。
   * 18 质量极高但体积大，23 是默认平衡点，28 体积小但画质有损
   */
  crf: number
  /** 底部遮挡比例 (0~0.5) */
  bottomCoverRatio: number
  /** 底部遮挡方式：blur=模糊, black=纯黑边, crop=直接裁剪画面 */
  bottomCoverType: 'blur' | 'black' | 'crop'
  /** 贴纸列表 */
  stickers: StickerItem[]

  /** 去掉片头时长（秒），改变入点 */
  trimStartSec: number
  /** 去掉片尾时长（秒），改变出点 */
  trimEndSec: number
  /**
   * 从「去掉片头尾之后的有效时长」的正中间，删掉连续这么多秒，再把前后拼起来（跳剪）。
   * 0 = 关闭。可打乱与原片逐帧对齐。
   */
  middleRemoveSec: number
  /** 成片最前拼接的短片（建议自带音轨、时长几秒以内），相对路径由渲染进程传入 */
  introVideoPath?: string
  /** 成片最后拼接的短片 */
  outroVideoPath?: string
}

/** 贴纸（图片叠层） */
export type StickerItem = {
  id: string
  /** 图片绝对路径 */
  imagePath: string
  /** 快捷位置锚点 */
  anchor: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'center' | 'custom'
  /** anchor=custom 时的 x 偏移（px，从左边） */
  customX: number
  /** anchor=custom 时的 y 偏移（px，从顶部） */
  customY: number
  /** 距画面上边缘（px），四角锚点用上；默认 20 */
  insetTop: number
  /** 距画面右边缘（px）；默认 20 */
  insetRight: number
  /** 距画面下边缘（px）；默认 20 */
  insetBottom: number
  /** 距画面左边缘（px）；默认 20 */
  insetLeft: number
  /** 贴纸宽度占主画面宽度的比例（如 0.15 = 15%）；0 = 保持图片原始像素宽度 */
  widthFrac: number
  /** 透明度 0.0 ~ 1.0 */
  opacity: number
  /** 起始秒（null = 从头） */
  startSec: number | null
  /** 结束秒（null = 到尾） */
  endSec: number | null
}

/** ffprobe + optional whole-file MD5 (MD5 仅在对比时按需计算，避免大文件卡顿) */
export interface VideoInfo {
  size: number
  md5?: string
  duration: number
  bitrate: number
  formatName: string
  videoCodec: string
  resolution: string
  fps: number
  audioCodec: string
  audioSampleRate: number
}

export type CompareVideosOptions = {
  /** 默认 false；开启后会全文读取两份文件算 MD5，大文件很慢 */
  md5?: boolean
}
