/// <reference types="vite/client" />

import type {
  CompareVideosOptions,
  DedupeGroup,
  TimelineClip,
  TransformOptions,
  VideoInfo
} from '../../shared/types'

export {}

declare global {
  interface Window {
    scissor: {
      pickVideos: () => Promise<string[] | undefined>
      pickImage: () => Promise<string | undefined>
      readStickerPreview: (filePath: string) => Promise<string | null>
      compareVideos: (
        path1: string,
        path2: string,
        opts?: CompareVideosOptions
      ) => Promise<[VideoInfo, VideoInfo]>
      pickSavePath: (defaultName?: string) => Promise<string | undefined>
      checkFfmpeg: () => Promise<{ ok: boolean; ffmpeg?: string; ffprobe?: string; error?: string }>
      getLuts: () => Promise<{ name: string; path: string }[]>
      dedupeScan: (paths: string[]) => Promise<{ ok: boolean; groups?: DedupeGroup[]; error?: string }>
      ffprobeDuration: (path: string) => Promise<{ ok: boolean; durationSec?: number; error?: string }>
      getVideoDims: (path: string) => Promise<{ ok: boolean; w?: number; h?: number; error?: string }>
      exportTimeline: (
        clips: TimelineClip[],
        outPath: string
      ) => Promise<{ ok: boolean; log?: string; error?: string }>
      transformVideo: (
        inputPath: string,
        outputPath: string,
        opts: TransformOptions
      ) => Promise<{ ok: boolean; error?: string }>
      pickDirectory: () => Promise<string | undefined>
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
          stickers?: import('../../shared/types').StickerItem[] 
        }
      ) => Promise<{ ok: boolean; error?: string }>
      onFfmpegProgress: (callback: (info: { file: string; time: string; speed: string; raw: string }) => void) => () => void
    }
  }
}
