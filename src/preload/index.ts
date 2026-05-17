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
  pickDirectory: (): Promise<string | undefined> =>
    ipcRenderer.invoke('pickDirectory'),
  checkFfmpeg: (): Promise<{ ok: boolean; ffmpeg?: string; ffprobe?: string; error?: string }> =>
    ipcRenderer.invoke('checkFfmpeg'),
  getLuts: (): Promise<{ name: string; path: string }[]> => ipcRenderer.invoke('getLuts'),
  dedupeScan: (paths: string[]): Promise<{ ok: boolean; groups?: DedupeGroup[]; error?: string }> =>
    ipcRenderer.invoke('dedupeScan', paths),
  ffprobeDuration: (path: string): Promise<{ ok: boolean; durationSec?: number; error?: string }> =>
    ipcRenderer.invoke('ffprobeDuration', path),
  getVideoDims: (path: string): Promise<{ ok: boolean; w?: number; h?: number; error?: string }> =>
    ipcRenderer.invoke('getVideoDims', path),
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
    ipcRenderer.invoke('transformVideo', inputPath, outputPath, opts),
  stitchVideo: (
    mainPath: string,
    insertPath: string,
    outputPath: string,
    insertSizePx: number,
    insertPositions: { side: 'top' | 'bottom' | 'left' | 'right'; offsetPx: number }[],
    obfOpts?: { 
      flip?: boolean; 
      colorNoise?: boolean; 
      audioObf?: boolean; 
      speedJitter?: boolean;
      trimStart?: boolean;
      hueSat?: boolean;
      cleanMeta?: boolean;
      blurSharpen?: boolean;
      audioEQ?: boolean;
      bottomCoverRatio?: number;
      bottomCoverType?: 'blur' | 'black' | 'crop';
      stickers?: import('../shared/types').StickerItem[] 
    }
  ): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('stitchVideo', mainPath, insertPath, outputPath, insertSizePx, insertPositions, obfOpts),
  onFfmpegProgress: (callback: (info: { file: string; time: string; speed: string; raw: string }) => void) => {
    const listener = (_e: any, info: any) => callback(info)
    ipcRenderer.on('ffmpeg-progress', listener)
    return () => {
      ipcRenderer.removeListener('ffmpeg-progress', listener)
    }
  }
})
