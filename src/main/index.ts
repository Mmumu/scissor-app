import { existsSync, readFileSync, statSync, readdirSync, createReadStream } from 'node:fs'
import { join, extname } from 'node:path'
import { Readable } from 'node:stream'
import { BrowserWindow, app, dialog, ipcMain, protocol } from 'electron'
import { runDedupe } from './dedupe'
import { exportTimeline } from './export-timeline'
import { stitchVideo, type InsertPosition } from './stitch'
import {
  ffmpegMissingUserHint,
  ffprobeDuration,
  ffprobeVideoDims,
  getVideoInfo,
  resolveBinariesSync,
  transformVideo
} from './ffmpeg-utils'
import { renderPreview } from './preview'
import * as library from './library/api'
import { renderMix } from './mix/render'
import { previewMix } from './mix/preview'
import { deleteProject, listProjects, readProject, saveProject } from './mix/projects'
import { analyzeReference, readAbsAsBase64 } from './mix/reference'
import { generateThumb } from './library/thumb'
import { tmpdir } from 'node:os'
import { mkdirSync, unlinkSync } from 'node:fs'
import type { AnalyzeReferenceRequest } from './mix/reference'

import type { CompareVideosOptions, VideoInfo } from '../shared/types'
import type { ObfuscationOptions } from '../shared/obfuscation'
import type { ImportOptions } from '../shared/library'
import type { MixPreviewRequest, MixRenderRequest, MixTimeline } from '../shared/mix'

// 必须在 app.ready 之前声明：让 renderer 里 <video src="scissor-source://..."> 能跑、能流式 fetch、能绕过 CSP
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'scissor-source',
    privileges: {
      secure: true,
      standard: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: true,
      corsEnabled: true
    }
  }
])

/**
 * 给 <video> / <audio> 一个能正确响应 Range 的本地文件 Response。
 * - 有 Range 头：返回 206 + Content-Range + 仅该段字节流；
 * - 无 Range / HEAD：返回 200 + Content-Length；
 * - 不一次性把整文件读进内存：用 fs.createReadStream(path, {start,end})。
 */
function serveLocalFile(absPath: string, req: Request): Response {
  let st: ReturnType<typeof statSync>
  try {
    st = statSync(absPath)
  } catch {
    return new Response('not found', { status: 404 })
  }
  const total = st.size
  const ext = extname(absPath).toLowerCase()
  const mime =
    ext === '.mp4' || ext === '.m4v' ? 'video/mp4'
    : ext === '.webm' ? 'video/webm'
    : ext === '.mov' ? 'video/quicktime'
    : ext === '.mkv' ? 'video/x-matroska'
    : ext === '.avi' ? 'video/x-msvideo'
    : ext === '.mp3' ? 'audio/mpeg'
    : ext === '.m4a' ? 'audio/mp4'
    : ext === '.wav' ? 'audio/wav'
    : ext === '.ogg' ? 'audio/ogg'
    : 'application/octet-stream'

  const baseHeaders: Record<string, string> = {
    'Content-Type': mime,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store'
  }

  if (req.method === 'HEAD') {
    return new Response(null, {
      status: 200,
      headers: { ...baseHeaders, 'Content-Length': String(total) }
    })
  }

  const range = req.headers.get('range') || req.headers.get('Range')
  if (!range) {
    const node = createReadStream(absPath)
    return new Response(Readable.toWeb(node) as unknown as ReadableStream, {
      status: 200,
      headers: { ...baseHeaders, 'Content-Length': String(total) }
    })
  }

  // 解析 "bytes=START-END" / "bytes=START-" / "bytes=-SUFFIX"
  const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
  if (!m) {
    return new Response('bad range', { status: 416, headers: baseHeaders })
  }
  let start = m[1] === '' ? NaN : Number(m[1])
  let end = m[2] === '' ? NaN : Number(m[2])
  if (Number.isNaN(start) && Number.isNaN(end)) {
    return new Response('bad range', { status: 416, headers: baseHeaders })
  }
  if (Number.isNaN(start)) {
    // 后缀长度：bytes=-N → 取最后 N 字节
    const suffix = end
    start = Math.max(0, total - suffix)
    end = total - 1
  } else if (Number.isNaN(end)) {
    end = total - 1
  }
  if (start < 0 || start >= total || end < start) {
    return new Response('range not satisfiable', {
      status: 416,
      headers: { ...baseHeaders, 'Content-Range': `bytes */${total}` }
    })
  }
  end = Math.min(end, total - 1)
  const chunkSize = end - start + 1

  const node = createReadStream(absPath, { start, end })
  return new Response(Readable.toWeb(node) as unknown as ReadableStream, {
    status: 206,
    headers: {
      ...baseHeaders,
      'Content-Length': String(chunkSize),
      'Content-Range': `bytes ${start}-${end}/${total}`
    }
  })
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1080,
    height: 780,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: false
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
    win.webContents.openDevTools({ mode: 'detach' })
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

app.whenReady().then(() => {
  library.init()

  // 自定义协议把 importId 映射到原视频文件，让 <video src="scissor-source://imp_xxx"> 能直接播。
  // 安全：只接受存在于 library.imports 里的 importId，不允许任意路径。
  // 必须：手工处理 Range 请求，否则 <video> 在暂停/恢复/seek 时反复发分段请求会失败。
  protocol.handle('scissor-source', async (req) => {
    try {
      const url = new URL(req.url)
      const importId = decodeURIComponent(url.hostname || url.pathname.replace(/^\//, ''))
      if (!importId) return new Response('missing importId', { status: 400 })
      const idx = library.list()
      const imp = idx.imports.find((r) => r.id === importId)
      if (!imp) return new Response('import not found', { status: 404 })
      if (!existsSync(imp.sourcePath)) {
        return new Response('source file missing', { status: 404 })
      }
      return serveLocalFile(imp.sourcePath, req)
    } catch (e) {
      return new Response(String(e), { status: 500 })
    }
  })

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

ipcMain.handle('pickVideos', async () => {
  const r = await dialog.showOpenDialog({
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Video', extensions: ['mp4', 'mov', 'mkv', 'm4v', 'webm', 'avi'] }]
  })
  if (r.canceled) return undefined
  return r.filePaths
})

ipcMain.handle('pickImage', async () => {
  const r = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'Image', extensions: ['png', 'jpg', 'jpeg', 'gif'] }]
  })
  if (r.canceled) return undefined
  return r.filePaths[0]
})

const PREVIEW_MAX_BYTES = 20 * 1024 * 1024

ipcMain.handle('readStickerPreview', async (_e, filePath: string) => {
  if (typeof filePath !== 'string' || !filePath || !existsSync(filePath)) return null
  try {
    const st = statSync(filePath)
    if (!st.isFile() || st.size > PREVIEW_MAX_BYTES) return null
    const buf = readFileSync(filePath)
    const lower = filePath.toLowerCase()
    let mime = 'image/png'
    if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) mime = 'image/jpeg'
    else if (lower.endsWith('.webp')) mime = 'image/webp'
    else if (lower.endsWith('.gif')) mime = 'image/gif'
    return `data:${mime};base64,${buf.toString('base64')}`
  } catch {
    return null
  }
})
ipcMain.handle('getLuts', () => {
  let lutsDir = join(__dirname, '../../resources/luts')
  if (app.isPackaged) {
    lutsDir = join(process.resourcesPath, 'luts')
  }
  if (!existsSync(lutsDir)) return []
  try {
    return readdirSync(lutsDir)
      .filter((f) => f.toLowerCase().endsWith('.cube'))
      .map((f) => ({ name: f.replace(/\.cube$/i, ''), path: join(lutsDir, f) }))
  } catch {
    return []
  }
})

ipcMain.handle(
  'compareVideos',
  async (
    _e,
    path1: string,
    path2: string,
    opts?: CompareVideosOptions
  ): Promise<[VideoInfo, VideoInfo]> => {
    const bins = resolveBinariesSync()
    if (!bins) throw new Error('未找到 ffprobe')
    const md5 = opts?.md5 === true
    const i1 = await getVideoInfo(bins.ffprobe, path1, { md5 })
    const i2 = await getVideoInfo(bins.ffprobe, path2, { md5 })
    return [i1, i2]
  }
)

ipcMain.handle('pickSavePath', async (_e, defaultName?: string) => {
  const r = await dialog.showSaveDialog({
    defaultPath: defaultName ?? 'export.mp4',
    filters: [{ name: 'MP4', extensions: ['mp4'] }]
  })
  if (r.canceled || !r.filePath) return undefined
  return r.filePath
})

ipcMain.handle('pickDirectory', async () => {
  const r = await dialog.showOpenDialog({
    properties: ['openDirectory', 'createDirectory']
  })
  if (r.canceled || !r.filePaths) return undefined
  return r.filePaths[0]
})

ipcMain.handle('checkFfmpeg', async () => {
  const bins = resolveBinariesSync()
  if (!bins) {
    return { ok: false, error: ffmpegMissingUserHint() }
  }
  return { ok: true, ffmpeg: bins.ffmpeg, ffprobe: bins.ffprobe }
})

ipcMain.handle('dedupeScan', async (_e, paths: string[]) => {
  try {
    const groups = await runDedupe(paths)
    return { ok: true, groups }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
})

ipcMain.handle('ffprobeDuration', async (_e, path: string) => {
  const bins = resolveBinariesSync()
  if (!bins) return { ok: false, error: 'ffprobe missing' }
  try {
    const d = await ffprobeDuration(bins.ffprobe, path)
    if (d == null) return { ok: false, error: 'Could not read duration' }
    return { ok: true, durationSec: d }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
})

ipcMain.handle('getVideoDims', async (_e, path: string) => {
  const bins = resolveBinariesSync()
  if (!bins) return { ok: false, error: 'ffprobe missing' }
  try {
    const dims = await ffprobeVideoDims(bins.ffprobe, path)
    if (!dims) return { ok: false, error: 'Could not read dims' }
    return { ok: true, w: dims.w, h: dims.h }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
})

/** 抽视频首帧，返回 data URL 给 renderer 当贴图预览的背景图 */
ipcMain.handle('extractFirstFrame', async (_e, videoPath: string) => {
  if (typeof videoPath !== 'string' || !videoPath || !existsSync(videoPath)) {
    return { ok: false, error: 'invalid path' }
  }
  const bins = resolveBinariesSync()
  if (!bins) return { ok: false, error: 'ffmpeg missing' }
  const work = join(tmpdir(), `scissor-thumb-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  try {
    mkdirSync(work, { recursive: true })
    const out = join(work, 'frame.jpg')
    const ok = await generateThumb(bins.ffmpeg, videoPath, 0, out, 480)
    if (!ok || !existsSync(out)) return { ok: false, error: 'failed to extract frame' }
    const buf = readFileSync(out)
    return { ok: true, dataUrl: `data:image/jpeg;base64,${buf.toString('base64')}` }
  } catch (e) {
    return { ok: false, error: String(e) }
  } finally {
    try {
      const out = join(work, 'frame.jpg')
      if (existsSync(out)) unlinkSync(out)
    } catch { /* no-op */ }
  }
})

ipcMain.handle(
  'exportTimeline',
  async (_e, clips: { path: string; startSec: number; endSec: number }[], outPath: string) => {
    let log = ''
    const res = await exportTimeline(clips, outPath, (s) => {
      log = s
    })
    if (!res.ok) return { ok: false, error: res.error, log }
    return { ok: true, log }
  }
)

ipcMain.handle(
  'transformVideo',
  async (e, inputPath: string, outputPath: string, opts: ObfuscationOptions) => {
    const bins = resolveBinariesSync()
    if (!bins) return { ok: false, error: ffmpegMissingUserHint() }
    return await transformVideo(
      bins.ffmpeg,
      bins.ffprobe,
      inputPath,
      outputPath,
      opts,
      (msg) => {
        const timeMatch = msg.match(/time=(\d{2}:\d{2}:\d{2}\.\d+)/)
        const speedMatch = msg.match(/speed=\s*([\d.]+x)/)
        if (timeMatch) {
          e.sender.send('ffmpeg-progress', {
            file: inputPath,
            time: timeMatch[1],
            speed: speedMatch ? speedMatch[1] : '',
            raw: msg
          })
        }
      }
    )
  }
)

interface StitchArgs {
  mainPath: string
  insertPath: string
  outputPath: string
  insertSizePx: number
  insertPositions: InsertPosition[]
  obfuscation: ObfuscationOptions
}

ipcMain.handle('stitchVideo', async (e, args: StitchArgs) => {
  const bins = resolveBinariesSync()
  if (!bins) return { ok: false, error: ffmpegMissingUserHint() }
  return await stitchVideo(
    bins.ffmpeg,
    bins.ffprobe,
    args.mainPath,
    args.insertPath,
    args.outputPath,
    args.insertSizePx,
    args.insertPositions,
    args.obfuscation,
    (msg) => {
      const timeMatch = msg.match(/time=(\d{2}:\d{2}:\d{2}\.\d+)/)
      const speedMatch = msg.match(/speed=\s*([\d.]+x)/)
      if (timeMatch) {
        e.sender.send('ffmpeg-progress', {
          file: args.mainPath,
          time: timeMatch[1],
          speed: speedMatch ? speedMatch[1] : '',
          raw: msg
        })
      }
    }
  )
})

interface PreviewArgs {
  mode: 'transform' | 'stitch'
  mainPath: string
  obfuscation: ObfuscationOptions
  startSec?: number
  durationSec?: number
  insertPath?: string
  insertSizePx?: number
  insertPositions?: InsertPosition[]
}

ipcMain.handle('renderPreview', async (_e, args: PreviewArgs) => {
  const bins = resolveBinariesSync()
  if (!bins) return { ok: false, error: ffmpegMissingUserHint() }
  return await renderPreview(bins.ffmpeg, bins.ffprobe, args)
})

// ── 素材池 / 「随心剪」相关 IPC ──────────────────────────────

ipcMain.handle('library:list', () => library.list())
ipcMain.handle('library:stats', () => library.stats())

ipcMain.handle('library:pickAudioFile', async () => {
  const r = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'Audio', extensions: ['m4a', 'aac', 'mp3', 'wav', 'ogg', 'flac'] }]
  })
  if (r.canceled || r.filePaths.length === 0) return undefined
  return r.filePaths[0]
})

ipcMain.handle('library:importVideos', async (e, opts: ImportOptions) => {
  const bins = resolveBinariesSync()
  if (!bins) return { ok: false, error: ffmpegMissingUserHint() }
  try {
    await library.doImportVideos(bins.ffmpeg, bins.ffprobe, opts, (ev) => {
      e.sender.send('library:import-progress', ev)
    })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
})

ipcMain.handle('library:importAudio', async (_e, path: string) => {
  const bins = resolveBinariesSync()
  if (!bins) return { ok: false, error: ffmpegMissingUserHint() }
  try {
    const meta = await library.doImportAudio(bins.ffmpeg, bins.ffprobe, path)
    return { ok: true, audio: meta }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
})

ipcMain.handle('library:deleteClips', (_e, ids: string[]) => {
  library.deleteClipsBy(ids)
  return { ok: true }
})

ipcMain.handle('library:deleteAudios', (_e, ids: string[]) => {
  library.deleteAudiosBy(ids)
  return { ok: true }
})

ipcMain.handle('library:deleteImport', (_e, importId: string) => {
  library.deleteImportBy(importId)
  return { ok: true }
})

ipcMain.handle('library:readAsBase64', (_e, rel: string) => {
  return library.readClipFileAsBase64(rel)
})

ipcMain.handle('library:rootDir', () => library.libRoot())

ipcMain.handle('library:getSourceVideoUrl', (_e, importId: string) => {
  const idx = library.list()
  const imp = idx.imports.find((r) => r.id === importId)
  if (!imp) return { ok: false, error: '来源不存在' }
  const exists = existsSync(imp.sourcePath)
  return {
    ok: true,
    url: `scissor-source://${encodeURIComponent(importId)}/`,
    sourcePath: imp.sourcePath,
    exists
  }
})

ipcMain.handle(
  'library:createGroup',
  (
    _e,
    input: { importId: string; clipIds: string[]; name?: string; description?: string }
  ) => {
    return library.doCreateGroup(input)
  }
)

ipcMain.handle('library:deleteGroup', (_e, groupId: string) => {
  return { ok: library.doDeleteGroup(groupId) }
})

ipcMain.handle('library:renameGroup', (_e, payload: { groupId: string; name: string }) => {
  return { ok: library.doRenameGroup(payload.groupId, payload.name) }
})

ipcMain.handle(
  'library:updateGroup',
  (_e, payload: { groupId: string; patch: { name?: string; description?: string } }) => {
    return { ok: library.doUpdateGroup(payload.groupId, payload.patch) }
  }
)

// ── 混剪台 ────────────────────────────────────────────────

ipcMain.handle('mix:render', async (e, req: MixRenderRequest) => {
  const bins = resolveBinariesSync()
  if (!bins) return { ok: false, error: ffmpegMissingUserHint() }
  return await renderMix(bins.ffmpeg, bins.ffprobe, req, (ev) => {
    e.sender.send('mix:progress', ev)
  })
})

ipcMain.handle('mix:preview', async (_e, req: MixPreviewRequest) => {
  const bins = resolveBinariesSync()
  if (!bins) return { ok: false, error: ffmpegMissingUserHint() }
  try {
    return await previewMix(bins.ffmpeg, bins.ffprobe, req)
  } catch (err) {
    const msg = err instanceof Error ? err.stack || err.message : String(err)
    console.error('[mix:preview] failed:', msg)
    return { ok: false, error: msg }
  }
})

ipcMain.handle('mix:pickOutputPath', async (_e, defaultName?: string) => {
  const r = await dialog.showSaveDialog({
    defaultPath: defaultName ?? 'mix.mp4',
    filters: [{ name: 'MP4', extensions: ['mp4'] }]
  })
  if (r.canceled || !r.filePath) return undefined
  return r.filePath
})

ipcMain.handle('mix:listProjects', () => listProjects())
ipcMain.handle(
  'mix:saveProject',
  (_e, name: string, timeline: MixTimeline, id?: string) => saveProject(name, timeline, id)
)
ipcMain.handle('mix:loadProject', (_e, id: string) => readProject(id))
ipcMain.handle('mix:deleteProject', (_e, id: string) => deleteProject(id))

// ── 参考视频 ──────────────────────────────────────────────

ipcMain.handle('mix:pickReferenceVideo', async () => {
  const r = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'Video', extensions: ['mp4', 'mov', 'mkv', 'm4v', 'webm'] }]
  })
  if (r.canceled || r.filePaths.length === 0) return undefined
  return r.filePaths[0]
})

ipcMain.handle('mix:analyzeReference', async (_e, req: AnalyzeReferenceRequest) => {
  const bins = resolveBinariesSync()
  if (!bins) return { ok: false, error: ffmpegMissingUserHint() }
  try {
    return await analyzeReference(bins.ffmpeg, bins.ffprobe, req)
  } catch (err) {
    const msg = err instanceof Error ? err.stack || err.message : String(err)
    console.error('[mix:analyzeReference] failed:', msg)
    return { ok: false, error: msg }
  }
})

// 参考视频最多 200MB，再大就拒了（base64 IPC 会卡）
ipcMain.handle('mix:readReferenceBytes', (_e, path: string) => {
  return readAbsAsBase64(path, 200 * 1024 * 1024)
})

ipcMain.handle('mix:probeReferenceMeta', async (_e, path: string) => {
  const bins = resolveBinariesSync()
  if (!bins) return { ok: false, error: ffmpegMissingUserHint() }
  try {
    if (!existsSync(path)) return { ok: false, error: '文件不存在' }
    const st = statSync(path)
    const dur = await ffprobeDuration(bins.ffprobe, path)
    return { ok: true, durationSec: dur ?? 0, sizeBytes: st.size }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, error: msg }
  }
})

