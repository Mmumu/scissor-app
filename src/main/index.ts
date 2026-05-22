import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserWindow, app, dialog, ipcMain } from 'electron'
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

import type { CompareVideosOptions, VideoInfo } from '../shared/types'
import type { ObfuscationOptions } from '../shared/obfuscation'
import type { ImportOptions } from '../shared/library'
import type { MixPreviewRequest, MixRenderRequest, MixTimeline } from '../shared/mix'

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
  return await previewMix(bins.ffmpeg, bins.ffprobe, req)
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

