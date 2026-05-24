import { spawn } from 'node:child_process'
import { copyFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { ffprobeHasAudio, ffprobeVideoDims, transformVideo } from '../ffmpeg-utils'
import { resolveRel } from '../library/paths'
import { readIndex } from '../library/index-store'
import type { ClipMeta } from '../../shared/library'
import type {
  MixRenderProgressEvent,
  MixRenderRequest,
  MixRenderResult
} from '../../shared/mix'
import { resolveTargetDims } from '../../shared/mix'

type ProgressFn = (ev: MixRenderProgressEvent) => void

/**
 * 两阶段管线：
 *   1) filter_complex concat：所有 clip scale/pad 到目标分辨率，串成 stage1.mp4
 *   2) 把 stage1.mp4 喂给 transformVideo（应用 obfuscation）
 *
 * 音频策略：
 *   - embed: 视频段自身音轨 concat（若有任何一段无音轨则自动降级为 silent）
 *   - replace: 取 audioIds 拼成单条 → loop/shortest 与 stage1 合成 stage2
 *   - silent: -an
 */
export async function renderMix(
  ffmpeg: string,
  ffprobe: string,
  req: MixRenderRequest,
  onProgress: ProgressFn,
  signal?: AbortSignal
): Promise<MixRenderResult> {
  try {
    onProgress({ phase: 'preparing' })

    const { timeline, outputPath } = req
    const idx = readIndex()
    const clipMap = new Map(idx.clips.map((c) => [c.id, c]))
    const audioMap = new Map(idx.audios.map((a) => [a.id, a]))

    // 按 clipIds 顺序解出 clip 元数据 + 子段裁剪信息
    type Input = {
      clip: ClipMeta
      path: string
      startSec?: number
      durationSec?: number
      effectiveDur: number
    }
    const overrides = timeline.clipOverrides ?? {}
    const inputs: Input[] = []
    timeline.clipIds.forEach((id, i) => {
      const c = clipMap.get(id)
      if (!c) return
      const ov = overrides[i]
      const start = Math.max(0, ov?.startSec ?? 0)
      const durRaw = ov?.durationSec
      const maxAvail = Math.max(0.05, c.durationSec - start)
      const dur = durRaw != null ? Math.min(Math.max(0.05, durRaw), maxAvail) : maxAvail
      inputs.push({
        clip: c,
        path: resolveRel(c.videoRel),
        startSec: start > 0 ? start : undefined,
        durationSec:
          ov?.durationSec != null && Math.abs(dur - c.durationSec) > 0.02 ? dur : undefined,
        effectiveDur: dur
      })
    })

    if (inputs.length === 0) {
      return { ok: false, error: '时间线为空：没有可用片段' }
    }
    for (const it of inputs) {
      if (!existsSync(it.path)) return { ok: false, error: `文件丢失: ${it.path}` }
    }
    const clips = inputs.map((i) => i.clip)
    const clipPaths = inputs.map((i) => i.path)

    // 决定目标分辨率
    const firstDims =
      (await ffprobeVideoDims(ffprobe, clipPaths[0])) ?? { w: clips[0].width, h: clips[0].height }
    const target = resolveTargetDims(timeline.target, firstDims)

    // 音频模式自动降级
    let audioMode = timeline.audioMode
    if (audioMode === 'embed') {
      const allHaveAudio = await Promise.all(clipPaths.map((p) => ffprobeHasAudio(ffprobe, p)))
      if (allHaveAudio.some((b) => !b)) {
        audioMode = 'silent'
      }
    }
    let externalAudioPath: string | null = null
    if (audioMode === 'replace') {
      const audios = timeline.audioIds.map((id) => audioMap.get(id)).filter(Boolean) as {
        audioRel: string
      }[]
      if (audios.length === 0) {
        audioMode = 'silent'
      } else if (audios.length === 1) {
        externalAudioPath = resolveRel(audios[0].audioRel)
      } else {
        // 多个音频先拼成一条
        externalAudioPath = await concatAudios(ffmpeg, audios.map((a) => resolveRel(a.audioRel)), signal)
      }
    }

    // 临时工作目录
    const workDir = join(app.getPath('userData'), 'library', 'tmp', `mix-${Date.now()}`)
    mkdirSync(workDir, { recursive: true })
    const stage1Path = join(workDir, 'stage1.mp4')
    const stage2Path = join(workDir, 'stage2.mp4')

    try {
      // 总时长用于进度估算（应用 override 后的有效时长）
      const totalDur = inputs.reduce((a, i) => a + i.effectiveDur, 0)

      // === Stage 1: concat ===
      onProgress({ phase: 'concat', pct: 0 })
      await runConcat(
        ffmpeg,
        inputs.map((i) => ({
          path: i.path,
          startSec: i.startSec,
          durationSec: i.durationSec
        })),
        stage1Path,
        target,
        audioMode === 'embed',
        totalDur,
        (pct) => onProgress({ phase: 'concat', pct }),
        signal
      )

      // === Stage 1.5: 外挂音频替换（如果有）===
      let stageForObf = stage1Path
      if (audioMode === 'replace' && externalAudioPath) {
        onProgress({ phase: 'audio' })
        await runMuxAudio(
          ffmpeg,
          stage1Path,
          externalAudioPath,
          stage2Path,
          timeline.audioLoop,
          signal
        )
        stageForObf = stage2Path
      } else if (audioMode === 'silent') {
        // 后续 transformVideo 看到无音轨会自动 -an
      }

      // === Stage 2: 应用 obfuscation（或跳过）===
      if (req.skipObfuscation) {
        // 直接把当前阶段产物拷贝到目标路径，跳过过原创处理
        copyFileSync(stageForObf, outputPath)
        onProgress({ phase: 'done', outputPath })
        return { ok: true, outputPath }
      }

      onProgress({ phase: 'obfuscation', pct: 0 })
      const r = await transformVideo(
        ffmpeg,
        ffprobe,
        stageForObf,
        outputPath,
        timeline.obfuscation,
        (msg) => {
          const m = msg.match(/time=(\d+):(\d+):(\d+\.\d+)/)
          if (m && totalDur > 0) {
            const t = +m[1] * 3600 + +m[2] * 60 + +m[3]
            onProgress({
              phase: 'obfuscation',
              pct: Math.min(0.999, t / totalDur),
              rawMsg: msg
            })
          }
        },
        signal
      )
      if (!r.ok) {
        if (r.aborted) return { ok: false, error: '已取消' }
        return { ok: false, error: r.error ?? 'obfuscation 阶段失败' }
      }

      onProgress({ phase: 'done', outputPath })
      return { ok: true, outputPath }
    } finally {
      try {
        rmSync(workDir, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    onProgress({ phase: 'error', error: msg })
    return { ok: false, error: msg }
  }
}

// ─── Stage 1: concat ─────────────────────────────────────

export function buildConcatFilterComplex(
  n: number,
  target: { w: number; h: number },
  withAudio: boolean
): string {
  const parts: string[] = []
  // 每路视频统一 scale + pad
  for (let i = 0; i < n; i++) {
    parts.push(
      `[${i}:v]scale=${target.w}:${target.h}:force_original_aspect_ratio=decrease,` +
        `pad=${target.w}:${target.h}:(ow-iw)/2:(oh-ih)/2:color=black,` +
        `setsar=1,fps=30,format=yuv420p[v${i}]`
    )
    if (withAudio) {
      parts.push(`[${i}:a]aformat=sample_rates=44100:channel_layouts=stereo[a${i}]`)
    }
  }
  // concat 滤镜的输入 pad 顺序：按段交错 v、a（每段 v 紧跟 a），不能所有 v 再所有 a
  let refs = ''
  for (let i = 0; i < n; i++) {
    refs += `[v${i}]`
    if (withAudio) refs += `[a${i}]`
  }
  if (withAudio) {
    parts.push(`${refs}concat=n=${n}:v=1:a=1[outv][outa]`)
  } else {
    parts.push(`${refs}concat=n=${n}:v=1:a=0[outv]`)
  }
  return parts.join(';')
}

type ConcatInput = { path: string; startSec?: number; durationSec?: number }

function runConcat(
  ffmpeg: string,
  inputs: ConcatInput[],
  outPath: string,
  target: { w: number; h: number },
  withAudio: boolean,
  totalDur: number,
  onPct: (pct: number) => void,
  signal?: AbortSignal
): Promise<void> {
  const args: string[] = ['-hide_banner', '-loglevel', 'error', '-stats']
  for (const inp of inputs) {
    // 输入级裁剪：-ss <start> -t <dur> -i <path>
    // 快、走关键帧——库里 clip 都是重编过的、Key frame 密集，足够精确
    if (inp.startSec != null && inp.startSec > 0) {
      args.push('-ss', inp.startSec.toFixed(3))
    }
    if (inp.durationSec != null && inp.durationSec > 0) {
      args.push('-t', inp.durationSec.toFixed(3))
    }
    args.push('-i', inp.path)
  }
  args.push(
    '-filter_complex',
    buildConcatFilterComplex(inputs.length, target, withAudio),
    '-map',
    '[outv]'
  )
  if (withAudio) args.push('-map', '[outa]')
  args.push(
    '-c:v',
    'libx264',
    '-preset',
    'medium',
    '-crf',
    '20',
    '-pix_fmt',
    'yuv420p',
    '-g',
    '60',
    '-keyint_min',
    '60',
    '-sc_threshold',
    '0'
  )
  if (withAudio) {
    args.push('-c:a', 'aac', '-b:a', '192k')
  } else {
    args.push('-an')
  }
  args.push('-movflags', '+faststart', '-y', outPath)
  return runFf(ffmpeg, args, totalDur, onPct, signal)
}

// ─── Stage 1.5: 音频替换 ─────────────────────────────────

function runMuxAudio(
  ffmpeg: string,
  videoPath: string,
  audioPath: string,
  outPath: string,
  loop: boolean,
  signal?: AbortSignal
): Promise<void> {
  const args: string[] = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    videoPath,
    ...(loop ? ['-stream_loop', '-1'] : []),
    '-i',
    audioPath,
    '-map',
    '0:v',
    '-map',
    '1:a',
    '-c:v',
    'copy',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-shortest',
    '-y',
    outPath
  ]
  return runFf(ffmpeg, args, 0, () => undefined, signal)
}

async function concatAudios(
  ffmpeg: string,
  audioPaths: string[],
  signal?: AbortSignal
): Promise<string> {
  const workDir = join(app.getPath('userData'), 'library', 'tmp', `audio-${Date.now()}`)
  mkdirSync(workDir, { recursive: true })
  const out = join(workDir, 'merged.m4a')
  const args: string[] = ['-hide_banner', '-loglevel', 'error']
  for (const p of audioPaths) args.push('-i', p)
  const filter =
    audioPaths.map((_, i) => `[${i}:a]`).join('') +
    `concat=n=${audioPaths.length}:v=0:a=1[outa]`
  args.push('-filter_complex', filter, '-map', '[outa]', '-c:a', 'aac', '-b:a', '192k', '-y', out)
  await runFf(ffmpeg, args, 0, () => undefined, signal)
  return out
}

// ─── 工具 ───────────────────────────────────────────────

function runFf(
  ffmpeg: string,
  args: string[],
  totalDur: number,
  onPct: (pct: number) => void,
  signal?: AbortSignal
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let errTail = ''
    let lastPct = 0
    child.stderr.on('data', (d: Buffer) => {
      const s = d.toString()
      errTail = (errTail + s).slice(-4096)
      if (totalDur > 0) {
        const m = s.match(/time=(\d+):(\d+):(\d+\.\d+)/g)
        if (m && m.length > 0) {
          const last = m[m.length - 1].slice(5)
          const [hh, mm, ss] = last.split(':')
          const tt = Number(hh) * 3600 + Number(mm) * 60 + Number(ss)
          const pct = Math.min(0.999, tt / totalDur)
          if (pct - lastPct > 0.01) {
            lastPct = pct
            onPct(pct)
          }
        }
      }
    })
    const onAbort = (): void => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* ignore */
      }
    }
    signal?.addEventListener('abort', onAbort)
    child.on('error', (e) => {
      signal?.removeEventListener('abort', onAbort)
      reject(e)
    })
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort)
      if (code === 0) {
        if (totalDur > 0) onPct(1)
        resolve()
      } else {
        reject(new Error(errTail.slice(-2000) || `ffmpeg exit ${code}`))
      }
    })
  })
}
