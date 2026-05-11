import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserWindow, app, dialog, ipcMain } from 'electron'
import { runDedupe } from './dedupe'
import { exportTimeline } from './export-timeline'
import {
  ffmpegMissingUserHint,
  ffprobeDuration,
  getVideoInfo,
  resolveBinariesSync,
  transformVideo
} from './ffmpeg-utils'
import type { CompareVideosOptions, TransformOptions, VideoInfo } from '../shared/types'

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

const PREVIEW_MAX_BYTES = 8 * 1024 * 1024

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
  async (_e, inputPath: string, outputPath: string, opts: TransformOptions) => {
    const bins = resolveBinariesSync()
    if (!bins) return { ok: false, error: ffmpegMissingUserHint() }
    return await transformVideo(bins.ffmpeg, bins.ffprobe, inputPath, outputPath, opts)
  }
)
