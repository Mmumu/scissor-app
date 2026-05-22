import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, statSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { ffprobeDuration } from '../ffmpeg-utils'
import type { AudioMeta } from '../../shared/library'
import { addAudio } from './index-store'
import { libraryRoot } from './paths'
import { generateWaveform } from './thumb'

/** 用户从硬盘选一个音频文件加入音频池。 */
export async function importStandaloneAudio(
  ffmpeg: string,
  ffprobe: string,
  sourcePath: string
): Promise<AudioMeta> {
  if (!existsSync(sourcePath)) throw new Error('音频文件不存在')
  const st = statSync(sourcePath)
  if (st.size === 0) throw new Error('音频文件为空')
  const dur = (await ffprobeDuration(ffprobe, sourcePath)) ?? 0
  if (dur < 0.05) throw new Error('音频时长无效')

  const id = `aud_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  const ext = extname(sourcePath).toLowerCase() || '.m4a'
  // 简化：只允许 m4a/aac/mp3/wav/ogg，否则转 m4a
  const supported = new Set(['.m4a', '.aac', '.mp3', '.wav', '.ogg', '.flac'])
  const targetExt = supported.has(ext) ? ext : '.m4a'
  const audioRel = join('audios', `${id}${targetExt}`)
  const waveformRel = join('audios', `${id}.png`)
  const absAudio = join(libraryRoot(), audioRel)

  if (supported.has(ext)) {
    copyFileSync(sourcePath, absAudio)
  } else {
    await convertToM4a(ffmpeg, sourcePath, absAudio)
  }

  await generateWaveform(ffmpeg, absAudio, join(libraryRoot(), waveformRel))

  const meta: AudioMeta = {
    id,
    label: basename(sourcePath, extname(sourcePath)),
    durationSec: dur,
    audioRel,
    waveformRel,
    createdAt: Date.now()
  }
  addAudio(meta)
  return meta
}

function convertToM4a(ffmpeg: string, src: string, dst: string): Promise<void> {
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    src,
    '-vn',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-map_metadata',
    '-1',
    '-y',
    dst
  ]
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    child.stderr.on('data', (d: Buffer) => {
      err += d.toString()
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(err.slice(-2000) || `ffmpeg exit ${code}`))
    })
  })
}
