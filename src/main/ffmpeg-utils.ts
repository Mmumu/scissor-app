import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, rmSync, statSync, existsSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import { PNG } from 'pngjs'
import { spawnWithStdout, spawnWithStdoutBuffer } from './spawn-util'
import type { StickerItem, VideoInfo } from '../shared/types'
import type { ObfuscationOptions } from '../shared/obfuscation'
import {
  buildAudioFingerprintFilters,
  buildMetadataArgs,
  buildVideoFingerprintFilters,
  computeEffectiveTrimStart
} from './obfuscation-filter'

const require = createRequire(import.meta.url)

function systemFfmpegFfprobeCandidates(): { ffmpeg: string[]; ffprobe: string[] } {
  if (process.platform === 'win32') {
    const pf = process.env['ProgramFiles'] ?? 'C:\\Program Files'
    const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
    const localApp = process.env['LOCALAPPDATA']
    const binDirs = [
      join(pf, 'ffmpeg', 'bin'),
      join(pf86, 'ffmpeg', 'bin'),
      join(pf, 'FFmpeg', 'bin')
    ]
    if (localApp) binDirs.push(join(localApp, 'Programs', 'ffmpeg', 'bin'))
    const ffmpeg = ['ffmpeg', ...binDirs.map((d) => join(d, 'ffmpeg.exe'))]
    const ffprobe = ['ffprobe', ...binDirs.map((d) => join(d, 'ffprobe.exe'))]
    return { ffmpeg, ffprobe }
  }
  if (process.platform === 'darwin') {
    return {
      ffmpeg: ['ffmpeg', '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'],
      ffprobe: ['ffprobe', '/opt/homebrew/bin/ffprobe', '/usr/local/bin/ffprobe']
    }
  }
  return {
    ffmpeg: ['ffmpeg', '/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg'],
    ffprobe: ['ffprobe', '/usr/bin/ffprobe', '/usr/local/bin/ffprobe']
  }
}

const { ffmpeg: FFMPEG_CANDIDATES, ffprobe: FFPROBE_CANDIDATES } = systemFfmpegFfprobeCandidates()

/** 内置静态包不可用时，给用户的安装提示（按平台）。 */
export function ffmpegMissingUserHint(): string {
  if (process.platform === 'win32') {
    return (
      '未找到 ffmpeg/ffprobe。可将官方 Windows 构建解压后把 bin 加入系统 PATH，' +
      '或使用 winget install Gyan.FFmpeg / winget install ffmpeg（视环境而定）。'
    )
  }
  if (process.platform === 'darwin') {
    return (
      '未找到 ffmpeg/ffprobe。请安装：brew install ffmpeg\n' +
      '然后把 brew 路径加入 PATH（Apple Silicon 常在 /opt/homebrew/bin）。'
    )
  }
  return '未找到 ffmpeg/ffprobe。请安装 ffmpeg 与 ffprobe 并确保在 PATH 中可用。'
}

function tryExec(path: string, args: string[]): boolean {
  const r = spawnSync(path, args, { encoding: 'utf8' })
  return r.status === 0 || r.status === null
}

/**
 * Packaged app — check in this order:
 *  1. extraResources/win/  (manually placed ffmpeg.exe + ffprobe.exe for Windows builds)
 *  2. app.asar.unpacked/node_modules/ffmpeg-static + ffprobe-static
 */
function resolveBundledBinariesPackaged(): { ffmpeg: string; ffprobe: string } | null {
  if (!app.isPackaged) return null

  const isWin = process.platform === 'win32'
  const ext = isWin ? '.exe' : ''

  // 1. extraResources path — for Windows builds cross-compiled on Mac
  //    Place ffmpeg.exe + ffprobe.exe in resources/win/ before building.
  const extraDir = join(process.resourcesPath, isWin ? 'win' : process.platform)
  const extraFfmpeg = join(extraDir, `ffmpeg${ext}`)
  const extraFfprobe = join(extraDir, `ffprobe${ext}`)
  if (existsSync(extraFfmpeg) && existsSync(extraFfprobe)) {
    if (tryExec(extraFfmpeg, ['-version']) && tryExec(extraFfprobe, ['-version'])) {
      return { ffmpeg: extraFfmpeg, ffprobe: extraFfprobe }
    }
  }

  // 2. asarUnpack node_modules
  const nm = join(process.resourcesPath, 'app.asar.unpacked', 'node_modules')
  const ffmpegPath = join(nm, 'ffmpeg-static', `ffmpeg${ext}`)
  const ffprobePath = join(
    nm,
    'ffprobe-static',
    'bin',
    process.platform,
    process.arch,
    `ffprobe${ext}`
  )
  if (existsSync(ffmpegPath) && existsSync(ffprobePath)) {
    if (tryExec(ffmpegPath, ['-version']) && tryExec(ffprobePath, ['-version'])) {
      return { ffmpeg: ffmpegPath, ffprobe: ffprobePath }
    }
  }

  return null
}

/** npm-bundled static binaries (dev: node_modules; prod: see resolveBundledBinariesPackaged). */
function resolveBundledBinaries(): { ffmpeg: string; ffprobe: string } | null {
  const packaged = resolveBundledBinariesPackaged()
  if (packaged) return packaged
  try {
    const ffmpegPath = require('ffmpeg-static') as string | null
    const ffprobeMod = require('ffprobe-static') as { path?: string }
    const ffprobePath = ffprobeMod?.path
    if (!ffmpegPath || !ffprobePath) return null
    if (!tryExec(ffmpegPath, ['-version']) || !tryExec(ffprobePath, ['-version'])) return null
    return { ffmpeg: ffmpegPath, ffprobe: ffprobePath }
  } catch {
    return null
  }
}

export function resolveBinariesSync(): { ffmpeg: string; ffprobe: string } | null {
  const bundled = resolveBundledBinaries()
  if (bundled) return bundled
  const ffmpeg = FFMPEG_CANDIDATES.find((p) => tryExec(p, ['-version']))
  const ffprobe = FFPROBE_CANDIDATES.find((p) => tryExec(p, ['-version']))
  if (!ffmpeg || !ffprobe) return null
  return { ffmpeg, ffprobe }
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    const rs = createReadStream(path)
    rs.on('data', (c) => hash.update(c))
    rs.on('error', reject)
    rs.on('end', () => resolve())
  })
  return hash.digest('hex')
}

export async function ffprobeDuration(ffprobe: string, path: string): Promise<number | null> {
  const args = [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    path
  ]
  const out = await spawnWithStdout(ffprobe, args)
  const v = parseFloat(out.trim())
  return Number.isFinite(v) ? v : null
}

export async function ffprobeHasAudio(ffprobe: string, path: string): Promise<boolean> {
  const args = [
    '-v', 'error',
    '-select_streams', 'a',
    '-show_entries', 'stream=index',
    '-of', 'csv=p=0',
    path
  ]
  const out = (await spawnWithStdout(ffprobe, args)).trim()
  return out.length > 0
}

function parseFpsRate(rate: string | undefined): number {
  if (!rate || rate === '0/0') return 0
  const parts = rate.split('/')
  if (parts.length !== 2) return 0
  const num = Number(parts[0])
  const den = Number(parts[1])
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return 0
  return num / den
}

/** 读取视频帧率（优先 avg_frame_rate，回退 r_frame_rate） */
export async function ffprobeVideoFps(ffprobe: string, path: string): Promise<number> {
  try {
    const args = [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=avg_frame_rate,r_frame_rate',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      path
    ]
    const out = (await spawnWithStdout(ffprobe, args)).trim()
    const lines = out.split('\n').map((l) => l.trim()).filter(Boolean)
    const avg = parseFpsRate(lines[0])
    const r = parseFpsRate(lines[1])
    const fps = avg > 0 ? avg : r
    return fps > 0 && Number.isFinite(fps) ? fps : 0
  } catch {
    return 0
  }
}

export async function ffprobeVideoDims(
  ffprobe: string,
  path: string
): Promise<{ w: number; h: number } | null> {
  try {
    const args = ['-v', 'quiet', '-print_format', 'json', '-show_streams', '-select_streams', 'v:0', path]
    const out = await spawnWithStdout(ffprobe, args)
    const data = JSON.parse(out)
    const s = data.streams?.[0]
    const w = Number(s?.width)
    const h = Number(s?.height)
    if (!Number.isFinite(w) || !Number.isFinite(h) || w < 2 || h < 2) return null
    return { w, h }
  } catch {
    return null
  }
}

export function getFileMd5(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('md5')
    const rs = createReadStream(filePath)
    rs.on('error', reject)
    rs.on('data', chunk => hash.update(chunk))
    rs.on('end', () => resolve(hash.digest('hex')))
  })
}

export async function getVideoInfo(
  ffprobe: string,
  videoPath: string,
  options?: { md5?: boolean }
): Promise<VideoInfo> {
  const args = ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', videoPath]
  const out = await spawnWithStdout(ffprobe, args)
  const data = JSON.parse(out)
  const format = data.format || {}
  const vStream = data.streams?.find((s: any) => s.codec_type === 'video') || {}
  const aStream = data.streams?.find((s: any) => s.codec_type === 'audio') || {}

  const size = existsSync(videoPath) ? statSync(videoPath).size : 0
  const wantMd5 = options?.md5 === true
  const md5 = wantMd5 && existsSync(videoPath) ? await getFileMd5(videoPath) : undefined

  const fpsStr = vStream.r_frame_rate || '0/0'
  const fpsParts = fpsStr.split('/')
  const fps = fpsParts.length === 2 ? Number(fpsParts[0]) / Number(fpsParts[1]) : 0

  const info: VideoInfo = {
    size,
    duration: Number(format.duration) || 0,
    bitrate: Number(format.bit_rate) || 0,
    formatName: format.format_name || 'unknown',
    videoCodec: vStream.codec_name || 'none',
    resolution: `${vStream.width || 0}x${vStream.height || 0}`,
    fps: isNaN(fps) ? 0 : fps,
    audioCodec: aStream.codec_name || 'none',
    audioSampleRate: Number(aStream.sample_rate) || 0
  }
  if (md5 !== undefined) info.md5 = md5
  return info
}

/** Difference hash (64-bit) from grayscale 9x8 adjacency — PNG RGBA input */
export function dhashFromPng(pngBuffer: Buffer): bigint {
  const png = PNG.sync.read(pngBuffer)
  const { width, height, data } = png
  if (width < 9 || height < 8) return 0n
  const gray: number[] = []
  for (let y = 0; y < 8; y++) {
    const sy = Math.floor((y * height) / 8)
    for (let x = 0; x < 9; x++) {
      const sx = Math.floor((x * width) / 9)
      const i = (sy * width + sx) << 2
      const r = data[i]
      const g = data[i + 1]
      const b = data[i + 2]
      gray.push(0.299 * r + 0.587 * g + 0.114 * b)
    }
  }
  let bits = 0n
  let bitPos = 0
  for (let y = 0; y < 8; y++) {
    const row = y * 9
    for (let x = 0; x < 8; x++) {
      const left = gray[row + x]
      const right = gray[row + x + 1]
      if (left > right) bits |= 1n << BigInt(bitPos)
      bitPos++
    }
  }
  return bits
}

export function hamming64(a: bigint, b: bigint): number {
  let x = a ^ b
  let c = 0
  while (x !== 0n) {
    c++
    x &= x - 1n
  }
  return c
}

export async function extractFramePng(
  ffmpeg: string,
  videoPath: string,
  timeSec: number
): Promise<Buffer | null> {
  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-ss', String(Math.max(0, timeSec)),
    '-i', videoPath,
    '-frames:v', '1',
    '-vf', 'scale=256:256',
    '-f', 'image2pipe',
    '-vcodec', 'png',
    '-'
  ]
  try {
    return await spawnWithStdoutBuffer(ffmpeg, args)
  } catch {
    return null
  }
}

export type FrameSignature = {
  durationSec: number
  hashes: bigint[]
}

export async function fingerprintVideo(
  ffmpeg: string,
  ffprobe: string,
  path: string
): Promise<FrameSignature | null> {
  const durationSec = (await ffprobeDuration(ffprobe, path)) ?? 0
  if (durationSec <= 0) return null
  const samples = [0.08, 0.22, 0.42, 0.58, 0.78, 0.92].map((r) => durationSec * r)
  const hashes: bigint[] = []
  for (const t of samples) {
    const png = await extractFramePng(ffmpeg, path, t)
    if (!png) continue
    hashes.push(dhashFromPng(png))
  }
  if (hashes.length < 3) return null
  return { durationSec, hashes }
}

export function perceptualSimilar(a: FrameSignature, b: FrameSignature): boolean {
  const durDelta = Math.abs(a.durationSec - b.durationSec)
  if (durDelta > 1.2) return false
  const n = Math.min(a.hashes.length, b.hashes.length)
  if (n < 3) return false
  let bad = 0
  for (let i = 0; i < n; i++) {
    if (hamming64(a.hashes[i], b.hashes[i]) > 12) bad++
  }
  return bad <= Math.ceil(n * 0.34)
}

function popcnt32(n: number): number {
  let x = n >>> 0
  let c = 0
  while (x) {
    c++
    x &= x - 1
  }
  return c
}

/** 需系统安装 `fpcalc`（brew install chromaprint）；未安装返回 null */
export function tryChromaprintFingerprint(path: string): number[] | null {
  if (!existsSync(path)) return null
  const r = spawnSync('fpcalc', ['-json', '-length', '120', path], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    timeout: 180_000
  })
  if (r.status !== 0 || !r.stdout) return null
  try {
    const j = JSON.parse(r.stdout) as { fingerprint?: unknown }
    const fp = j.fingerprint
    if (!Array.isArray(fp) || fp.length < 5) return null
    return fp.map((x) => Number(x) >>> 0)
  } catch {
    return null
  }
}

export function chromaprintSimilar(a: number[], b: number[]): boolean {
  const n = Math.min(a.length, b.length)
  if (n < 5) return false
  let bad = 0
  for (let i = 0; i < n; i++) {
    if (popcnt32((a[i] ^ b[i]) >>> 0) > 11) bad++
  }
  return bad <= Math.ceil(n * 0.32)
}

export function tempDir(): string {
  return join(tmpdir(), `scissor-${process.pid}-${Date.now()}`)
}

// ─────────────────────────────────────────────────────────────────────────────
// anchor → ffmpeg overlay x:y 表达式
// ─────────────────────────────────────────────────────────────────────────────
const DEF_INSET = 20

function insetPx(s: StickerItem, k: keyof Pick<StickerItem, 'insetTop' | 'insetRight' | 'insetBottom' | 'insetLeft'>): number {
  const v = s[k]
  const n = typeof v === 'number' && Number.isFinite(v) ? v : DEF_INSET
  return Math.max(0, Math.round(n))
}

/**
 * 计算贴图在 ffmpeg overlay 滤镜中的 x:y 表达式字符串。
 * - 静态贴图：返回 `x:y`（位置参数 positional）
 * - march-lr：返回 `x='...':y='...'`（命名参数，因为 x 是 t 的表达式）
 *
 * @param durationSec 当前主视频/合成视频的时长，用于 march 贴图的终点时间默认值。
 *                    可选，仅在 motion='march-lr' 且 endSec 未设时需要。
 */
export function anchorToXY(s: StickerItem, durationSec?: number): string {
  const L = insetPx(s, 'insetLeft')
  const R = insetPx(s, 'insetRight')
  const T = insetPx(s, 'insetTop')
  const B = insetPx(s, 'insetBottom')

  if (s.motion === 'march-lr') {
    const start = Math.max(0, s.startSec ?? 0)
    const fallbackEnd = durationSec && durationSec > 0 ? durationSec : start + 1
    const end = Math.max(start + 0.05, s.endSec ?? fallbackEnd)
    const range = (end - start).toFixed(3)
    const startTxt = start.toFixed(3)
    // 真正贴到画面左右、底部三条边走：
    //   x 从 0 → main_w - overlay_w
    //   y = main_h - overlay_h（紧贴底）
    // 所有 inset 在运动模式下都被忽略（仅静止贴图用）
    // 用单引号包住整个表达式，commas 不会被滤镜参数解析器误读
    const x = `'(main_w-overlay_w)*clip((t-${startTxt})/${range}\\,0\\,1)'`
    const y = `'main_h-overlay_h'`
    return `x=${x}:y=${y}`
  }

  switch (s.anchor) {
    case 'top-left':
      return `${L}:${T}`
    case 'top-right':
      return `main_w-overlay_w-${R}:${T}`
    case 'bottom-left':
      return `${L}:main_h-overlay_h-${B}`
    case 'bottom-right':
      return `main_w-overlay_w-${R}:main_h-overlay_h-${B}`
    case 'center':
      return `(main_w-overlay_w)/2:(main_h-overlay_h)/2`
    case 'custom':
      return `${s.customX}:${s.customY}`
  }
}

/**
 * 生成 overlay 的 :enable=... 段。march-lr 强制限定到 [start, end] 区间（保证非生效期不显示）。
 */
export function enableExpr(s: StickerItem, durationSec?: number): string {
  if (s.motion === 'march-lr') {
    const start = Math.max(0, s.startSec ?? 0)
    const fallbackEnd = durationSec && durationSec > 0 ? durationSec : start + 1
    const end = Math.max(start + 0.05, s.endSec ?? fallbackEnd)
    return `:enable='between(t,${start.toFixed(3)},${end.toFixed(3)})'`
  }
  if (s.startSec != null && s.endSec != null)
    return `:enable='between(t,${s.startSec},${s.endSec})'`
  if (s.startSec != null) return `:enable='gte(t,${s.startSec})'`
  if (s.endSec != null) return `:enable='lte(t,${s.endSec})'`
  return ''
}

// 视频/音频扰动滤镜串构造已迁移至 ./obfuscation-filter.ts

export async function spawnFfmpeg(
  ffmpeg: string,
  args: string[],
  onProgress?: (msg: string) => void,
  timeoutMs = 3_600_000, // 1 hour default
  signal?: AbortSignal
): Promise<{ ok: boolean; error?: string; aborted?: boolean }> {
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const done = (err?: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (err) reject(err)
        else resolve()
      }

      const timer = setTimeout(() => {
        try { proc.kill() } catch { /* ignore */ }
        done(new Error(`ffmpeg timed out after ${timeoutMs / 1000}s`))
      }, timeoutMs)

      // On Windows with ASAR, paths may contain spaces — spawn with explicit
      // windowsVerbatimArguments:false ensures args are quoted correctly.
      const proc = spawn(ffmpeg, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      })

      // AbortSignal → kill ffmpeg process
      const onAbort = () => {
        try { proc.kill('SIGKILL') } catch { /* ignore */ }
        done(Object.assign(new Error('aborted'), { aborted: true }))
      }
      signal?.addEventListener('abort', onAbort, { once: true })

      let stderr = ''
      proc.stderr?.on('data', (d: Buffer) => {
        stderr += d.toString()
        onProgress?.(d.toString().trim())
      })
      proc.stdout?.on('data', () => {})
      proc.on('close', (code) => {
        signal?.removeEventListener('abort', onAbort)
        if (code === 0 || code === null) done()
        else done(new Error(stderr.slice(-1200) || `ffmpeg exit ${code}`))
      })
      proc.on('error', (e) => done(e))
    })
    return { ok: true }
  } catch (e: any) {
    if (e?.aborted) return { ok: false, aborted: true, error: 'cancelled' }
    return { ok: false, error: String(e) }
  }
}


async function concatIntroMainOutro(
  ffmpeg: string,
  ffprobe: string,
  introPath: string | null,
  mainPath: string,
  outroPath: string | null,
  outputPath: string,
  crf: number,
  onProgress?: (msg: string) => void,
  signal?: AbortSignal
): Promise<{ ok: boolean; error?: string }> {
  const dims = await ffprobeVideoDims(ffprobe, mainPath)
  if (!dims) return { ok: false, error: '无法读取主成片分辨率' }
  const tw = dims.w & ~1
  const th = dims.h & ~1

  const paths: string[] = []
  if (introPath) paths.push(introPath)
  paths.push(mainPath)
  if (outroPath) paths.push(outroPath)

  for (const p of paths) {
    if (!existsSync(p)) return { ok: false, error: `文件不存在: ${p}` }
  }

  for (const p of paths) {
    if (!(await ffprobeHasAudio(ffprobe, p))) {
      return {
        ok: false,
        error:
          '片头 / 主片 / 片尾均需包含音轨；无声短片请先在导出时带上静音 AAC，否则会拼接失败'
      }
    }
  }

  const fcParts: string[] = []
  const n = paths.length
  for (let i = 0; i < n; i++) {
    fcParts.push(
      `[${i}:v]scale=${tw}:${th}:force_original_aspect_ratio=decrease,pad=${tw}:${th}:(ow-iw)/2:(oh-ih)/2,setsar=1[v${i}]`
    )
    fcParts.push(`[${i}:a]aformat=sample_rates=44100:channel_layouts=stereo[a${i}]`)
  }
  let pairs = ''
  for (let i = 0; i < n; i++) pairs += `[v${i}][a${i}]`
  fcParts.push(`${pairs}concat=n=${n}:v=1:a=1[vcat][acat]`)

  const inputs: string[] = []
  for (const p of paths) inputs.push('-i', p)

  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    ...inputs,
    '-filter_complex',
    fcParts.join(';'),
    '-map',
    '[vcat]',
    '-map',
    '[acat]',
    '-c:v',
    'libx264',
    '-preset',
    'medium',
    '-crf',
    String(crf),
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-movflags',
    '+faststart',
    '-y',
    outputPath
  ]

  onProgress?.(`拼接片头片尾: ffmpeg ${args.join(' ')}`)

  return spawnFfmpeg(ffmpeg, args, onProgress, 3_600_000, signal)
}

/**
 * 微扰 + 可选片头片尾/中间跳剪 + 贴纸/底部栏；可选片头片尾短片二次拼接。
 * 现在统一吃 ObfuscationOptions。
 */
export async function transformVideo(
  ffmpeg: string,
  ffprobe: string,
  inputPath: string,
  outputPath: string,
  opts: ObfuscationOptions,
  onProgress?: (msg: string) => void,
  signal?: AbortSignal
): Promise<{ ok: boolean; error?: string; aborted?: boolean }> {
  const hasAudio = await ffprobeHasAudio(ffprobe, inputPath)
  const stickers = (opts.stickers ?? []).filter((s) => !!s.imagePath)
  const bottomR = opts.cover.bottomRatio || 0

  const trimStart = computeEffectiveTrimStart(opts)
  const trimEnd = Math.max(0, opts.trim.endSec ?? 0)
  const middleRm = Math.max(0, opts.trim.middleRemoveSec ?? 0)

  const introRaw = opts.concat.introPath?.trim()
  const outroRaw = opts.concat.outroPath?.trim()
  const introPath = introRaw && existsSync(introRaw) ? introRaw : null
  const outroPath = outroRaw && existsSync(outroRaw) ? outroRaw : null
  const needsConcat = introPath != null || outroPath != null
  /** Only used when needsConcat — isolate temp files so cleanup never touches os tmp root */
  let concatWorkDir: string | null = null

  let dur = 0
  const needsTemporal = trimStart > 0 || trimEnd > 0 || middleRm > 0
  // march-lr 贴图也需要知道时长（用作终点的默认值）
  const hasMarchSticker = stickers.some((s) => s.motion === 'march-lr')
  if (needsTemporal || hasMarchSticker) {
    const d = await ffprobeDuration(ffprobe, inputPath)
    if (d == null || d <= 0) return { ok: false, error: '无法读取源视频时长' }
    dur = d
    if (needsTemporal) {
      const Te = dur - trimEnd
      const Ts = trimStart
      if (Te <= Ts + 0.12) return { ok: false, error: '片头/片尾裁剪过多，剩余时长过短' }
      if (middleRm > 0 && middleRm >= Te - Ts - 0.15) {
        return { ok: false, error: '中间删除不能超过去掉片头尾后的有效片长' }
      }
    }
  }
  // 贴图生效时段所参照的"成片时长"：裁剪后会变短
  const effectiveDur = needsTemporal
    ? Math.max(0.05, dur - trimStart - trimEnd - middleRm)
    : dur

  const lutPath = opts.lut.path
  const needsComplex = needsTemporal || stickers.length > 0 || bottomR > 0 || !!lutPath
  // 提前 probe 源视频尺寸，用于最终 scale 保证输出分辨率与源一致
  const srcDims = await ffprobeVideoDims(ffprobe, inputPath)
  const srcW = srcDims ? (srcDims.w & ~1) : 0
  const srcH = srcDims ? (srcDims.h & ~1) : 0
  console.error(`[DimDebug] srcDims=${JSON.stringify(srcDims)} srcW=${srcW} srcH=${srcH}`)
  const vFingerprint = buildVideoFingerprintFilters(opts, srcDims ?? undefined)
  const aFingerprint = hasAudio ? buildAudioFingerprintFilters(opts) : []
  const metaArgs = buildMetadataArgs(opts)
  const encodeArgs = ['-c:v', 'libx264', '-preset', 'medium', '-crf', String(opts.encode.crf ?? 23), '-pix_fmt', 'yuv420p', '-movflags', '+faststart', ...metaArgs, '-y']

  let mainOut: string
  if (needsConcat) {
    concatWorkDir = join(tempDir(), `scissor-work-${Date.now()}`)
    mkdirSync(concatWorkDir, { recursive: true })
    mainOut = join(concatWorkDir, 'main.mp4')
  } else {
    mainOut = outputPath
  }

  let args: string[]

  if (!needsComplex) {
    const audioArgs: string[] = !hasAudio
      ? ['-an']
      : aFingerprint.length > 0
        ? ['-af', aFingerprint.join(','), '-c:a', 'aac', '-b:a', '192k']
        : ['-c:a', 'aac', '-b:a', '192k']
    args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      inputPath,
      '-vf',
      vFingerprint.join(','),
      ...audioArgs,
      ...encodeArgs,
      mainOut
    ]
  } else {
    const fcParts: string[] = []
    let vSrc = '[0:v]'
    let aSrc = '[0:a]'

    if (needsTemporal) {
      const Te = dur - trimEnd
      const Ts = trimStart
      if (middleRm > 0) {
        const L = Te - Ts
        const mid = Ts + L / 2
        const half = middleRm / 2
        let s1e = mid - half
        let s2s = mid + half
        s1e = Math.max(Ts + 0.02, s1e)
        s2s = Math.min(Te - 0.02, s2s)
        if (s2s <= s1e + 0.05) {
          return { ok: false, error: '中间删剪无效，请缩短「中间删除」秒数' }
        }
        fcParts.push(`[0:v]trim=start=${Ts.toFixed(3)}:end=${s1e.toFixed(3)},setpts=PTS-STARTPTS[v1]`)
        fcParts.push(`[0:v]trim=start=${s2s.toFixed(3)}:end=${Te.toFixed(3)},setpts=PTS-STARTPTS[v2]`)
        fcParts.push(`[v1][v2]concat=n=2:v=1:a=0[vt]`)
        if (hasAudio) {
          fcParts.push(`[0:a]atrim=start=${Ts.toFixed(3)}:end=${s1e.toFixed(3)},asetpts=PTS-STARTPTS[a1]`)
          fcParts.push(`[0:a]atrim=start=${s2s.toFixed(3)}:end=${Te.toFixed(3)},asetpts=PTS-STARTPTS[a2]`)
          fcParts.push(`[a1][a2]concat=n=2:v=0:a=1[at]`)
        }
        vSrc = '[vt]'
        aSrc = '[at]'
      } else {
        fcParts.push(`[0:v]trim=start=${Ts.toFixed(3)}:end=${Te.toFixed(3)},setpts=PTS-STARTPTS[vt]`)
        if (hasAudio) {
          fcParts.push(`[0:a]atrim=start=${Ts.toFixed(3)}:end=${Te.toFixed(3)},asetpts=PTS-STARTPTS[at]`)
        }
        vSrc = '[vt]'
        aSrc = '[at]'
      }
    }

    fcParts.push(`${vSrc}${vFingerprint.join(',')}[vfp]`)

    let currentBase = '[vfp]'

    if (lutPath && existsSync(lutPath)) {
      const escapedPath = lutPath.replace(/\\/g, '/').replace(/:/g, '\\:')
      const intensity = opts.lut.intensity ?? 1.0
      if (intensity >= 0.99) {
        fcParts.push(`${currentBase}lut3d=${escapedPath}[vlut]`)
        currentBase = '[vlut]'
      } else if (intensity > 0.01) {
        fcParts.push(`${currentBase}split=2[vlut_orig][vlut_target]`)
        fcParts.push(`[vlut_target]lut3d=${escapedPath}[vlut_lut]`)
        fcParts.push(`[vlut_lut][vlut_orig]blend=all_opacity=${intensity.toFixed(4)}[vlut_out]`)
        currentBase = '[vlut_out]'
      }
    }

    if (bottomR > 0) {
      const r = Math.min(0.5, bottomR).toFixed(3)
      if (opts.cover.bottomType === 'crop') {
        fcParts.push(`${currentBase}crop=iw:ih-ih*${r}:0:0[base_cropped]`)
        currentBase = '[base_cropped]'
      } else if (opts.cover.bottomType === 'black') {
        fcParts.push(`${currentBase}drawbox=x=0:y=ih-ih*${r}:w=iw:h=ih*${r}:color=black@1.0:t=fill[base_black]`)
        currentBase = '[base_black]'
      } else {
        fcParts.push(`${currentBase}split=2[base_orig][base_crop]`)
        fcParts.push(`[base_crop]crop=iw:ih*${r}:0:ih-ih*${r},gblur=sigma=20[blur_out]`)
        fcParts.push(`[base_orig][blur_out]overlay=0:main_h-overlay_h[base_blurred]`)
        currentBase = '[base_blurred]'
      }
    }

    const extraInputs: string[] = stickers.flatMap((s) => {
      if (s.imagePath.toLowerCase().endsWith('.gif')) {
        return ['-ignore_loop', '0', '-i', s.imagePath]
      }
      return ['-loop', '1', '-i', s.imagePath]
    })

    /** 按比例缩放贴纸时用源视频偶数宽度（避免 scale2ref + loop 图片触发编码器无帧） */
    let stickerRefW: number | null = null
    if (stickers.some((s) => (s.widthFrac ?? 0) > 0)) {
      const dim = await ffprobeVideoDims(ffprobe, inputPath)
      stickerRefW = dim ? Math.max(4, dim.w & ~1) : 1920
    }

    // 最终宽度修正：强制输出宽度 = 源视频宽度（偶数），消除中间滤镜浮点误差
    const finalScaleFilter = srcW > 0
      ? `scale=${srcW}:trunc(ih/2)*2:flags=lanczos,setsar=1`
      : `scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1`

    if (stickers.length > 0) {
      let pipeBase = currentBase
      stickers.forEach((s, i) => {
        const alpha = Math.min(1, Math.max(0, s.opacity)).toFixed(4)
        const fracRaw = s.widthFrac ?? 0
        const isLast = i === stickers.length - 1
        const outTag = isLast ? '[vout_pre]' : `[o${i}]`

        let scaleChain: string
        if (fracRaw > 0 && stickerRefW != null) {
          const f = Math.min(0.95, Math.max(0.02, fracRaw))
          const tw = Math.max(4, Math.round((stickerRefW * f) / 2) * 2)
          scaleChain = `scale=${tw}:-2:flags=lanczos,format=rgba,colorchannelmixer=aa=${alpha}`
        } else {
          scaleChain = `scale=iw:-1:flags=lanczos,format=rgba,colorchannelmixer=aa=${alpha}`
        }
        fcParts.push(`[${i + 1}:v]${scaleChain}[st${i}]`)
        fcParts.push(
          `${pipeBase}[st${i}]overlay=${anchorToXY(s, effectiveDur)}${enableExpr(s, effectiveDur)}:shortest=1${outTag}`
        )
        pipeBase = outTag
      })
      fcParts.push(`[vout_pre]${finalScaleFilter}[out]`)
    } else {
      fcParts.push(`${currentBase}${finalScaleFilter}[out]`)
    }

    let audioMapSrc: string | null = null
    if (hasAudio) {
      if (aFingerprint.length > 0) {
        fcParts.push(`${aSrc}${aFingerprint.join(',')}[aout]`)
        audioMapSrc = '[aout]'
      } else {
        // 没扰动滤镜：trim 后用 [at]；否则直接用 0:a
        audioMapSrc = needsTemporal ? '[at]' : '0:a'
      }
    }

    args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      inputPath,
      ...extraInputs,
      '-filter_complex',
      fcParts.join(';'),
      '-map',
      '[out]',
      ...(audioMapSrc ? ['-map', audioMapSrc, '-c:a', 'aac', '-b:a', '192k'] : ['-an']),
      ...encodeArgs,
      mainOut
    ]
  }

  onProgress?.(`运行: ffmpeg ${args.join(' ')}`)
  console.log(`[FFmpeg Command]: ffmpeg ${args.join(' ')}`)

  const r1 = await spawnFfmpeg(ffmpeg, args, onProgress, 3_600_000, signal)
  if (!r1.ok) return r1

  if (!needsConcat) return { ok: true }

  try {
    return await concatIntroMainOutro(
      ffmpeg,
      ffprobe,
      introPath,
      mainOut,
      outroPath,
      outputPath,
      opts.encode.crf ?? 23,
      onProgress,
      signal
    )
  } finally {
    if (concatWorkDir) {
      try {
        rmSync(concatWorkDir, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
  }
}
