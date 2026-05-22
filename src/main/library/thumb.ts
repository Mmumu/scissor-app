import { spawn } from 'node:child_process'

/**
 * 抽视频首帧到 jpg（与 hover 播放对齐——播放也是从 0 开始）。
 * 注意：不能用 `-ss 0` 提前 seek，那样 ffmpeg 可能跳到最近 keyframe，
 * 导致首帧不一致。这里用 `-vframes 1` 直接取解码出来的第一帧。
 */
export async function generateThumb(
  ffmpeg: string,
  videoPath: string,
  _durationSec: number,
  outJpgPath: string,
  width = 240
): Promise<boolean> {
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    videoPath,
    '-frames:v',
    '1',
    '-vf',
    `scale=${width}:-2:flags=lanczos`,
    '-q:v',
    '4',
    '-y',
    outJpgPath
  ]
  return new Promise((resolve) => {
    const child = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'ignore'] })
    child.on('error', () => resolve(false))
    child.on('close', (code) => resolve(code === 0))
  })
}

/** 生成音频波形预览图（横向条带）。 */
export async function generateWaveform(
  ffmpeg: string,
  audioPath: string,
  outPngPath: string,
  size = '480x80'
): Promise<boolean> {
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    audioPath,
    '-filter_complex',
    `showwavespic=s=${size}:colors=#a78bfa`,
    '-frames:v',
    '1',
    '-y',
    outPngPath
  ]
  return new Promise((resolve) => {
    const child = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'ignore'] })
    child.on('error', () => resolve(false))
    child.on('close', (code) => resolve(code === 0))
  })
}
