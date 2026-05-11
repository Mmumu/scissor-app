import { contextBridge, ipcRenderer } from 'electron'
import type {
  CompareVideosOptions,
  DedupeGroup,
  TimelineClip,
  TransformOptions,
  VideoInfo
} from '../shared/types'

export type { CompareVideosOptions, DedupeGroup, TimelineClip, TransformOptions, VideoInfo }

contextBridge.exposeInMainWorld('scissor', {
  pickVideos: (): Promise<string[] | undefined> => ipcRenderer.invoke('pickVideos'),
  pickImage: (): Promise<string | undefined> => ipcRenderer.invoke('pickImage'),
  readStickerPreview: (filePath: string): Promise<string | null> =>
    ipcRenderer.invoke('readStickerPreview', filePath),
  compareVideos: (path1: string, path2: string, opts?: CompareVideosOptions): Promise<[VideoInfo, VideoInfo]> =>
    ipcRenderer.invoke('compareVideos', path1, path2, opts),
  pickSavePath: (defaultName?: string): Promise<string | undefined> =>
    ipcRenderer.invoke('pickSavePath', defaultName),
  checkFfmpeg: (): Promise<{ ok: boolean; ffmpeg?: string; ffprobe?: string; error?: string }> =>
    ipcRenderer.invoke('checkFfmpeg'),
  dedupeScan: (paths: string[]): Promise<{ ok: boolean; groups?: DedupeGroup[]; error?: string }> =>
    ipcRenderer.invoke('dedupeScan', paths),
  ffprobeDuration: (path: string): Promise<{ ok: boolean; durationSec?: number; error?: string }> =>
    ipcRenderer.invoke('ffprobeDuration', path),
  exportTimeline: (
    clips: TimelineClip[],
    outPath: string
  ): Promise<{ ok: boolean; log?: string; error?: string }> =>
    ipcRenderer.invoke('exportTimeline', clips, outPath),
  transformVideo: (
    inputPath: string,
    outputPath: string,
    opts: TransformOptions
  ): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('transformVideo', inputPath, outputPath, opts)
})
