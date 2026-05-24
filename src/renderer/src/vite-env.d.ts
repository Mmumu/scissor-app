/// <reference types="vite/client" />

import type {
  CompareVideosOptions,
  DedupeGroup,
  TimelineClip,
  VideoInfo
} from '../../shared/types'
import type { ObfuscationOptions } from '../../shared/obfuscation'
import type {
  AudioMeta,
  ClipGroup,
  ImportOptions,
  ImportProgressEvent,
  LibraryIndex,
  LibraryStats
} from '../../shared/library'
import type {
  MixPreviewRequest,
  MixPreviewResult,
  MixProjectMeta,
  MixRenderProgressEvent,
  MixRenderRequest,
  MixRenderResult,
  MixTimeline,
  ReferenceSegment
} from '../../shared/mix'

type AnalyzeReferenceRequest = {
  path: string
  threshold?: number
  minSegSec?: number
  maxSegSec?: number
}
type AnalyzeReferenceResult =
  | {
      ok: true
      durationSec: number
      sizeBytes: number
      segments: ReferenceSegment[]
      threshold: number
    }
  | { ok: false; error: string }

export {}

type InsertSide = 'top' | 'bottom' | 'left' | 'right'
type InsertPosition = { side: InsertSide; offsetPx: number }

type StitchArgs = {
  mainPath: string
  insertPath: string
  outputPath: string
  insertSizePx: number
  insertPositions: InsertPosition[]
  obfuscation: ObfuscationOptions
}

type PreviewArgs = {
  mode: 'transform' | 'stitch'
  mainPath: string
  obfuscation: ObfuscationOptions
  startSec?: number
  durationSec?: number
  insertPath?: string
  insertSizePx?: number
  insertPositions?: InsertPosition[]
}

type PreviewResult = {
  ok: boolean
  base64?: string
  mime?: string
  durationSec?: number
  error?: string
}

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
      pickDirectory: () => Promise<string | undefined>
      checkFfmpeg: () => Promise<{ ok: boolean; ffmpeg?: string; ffprobe?: string; error?: string }>
      getLuts: () => Promise<{ name: string; path: string }[]>
      dedupeScan: (paths: string[]) => Promise<{ ok: boolean; groups?: DedupeGroup[]; error?: string }>
      ffprobeDuration: (path: string) => Promise<{ ok: boolean; durationSec?: number; error?: string }>
      getVideoDims: (path: string) => Promise<{ ok: boolean; w?: number; h?: number; error?: string }>
      extractFirstFrame: (
        path: string
      ) => Promise<{ ok: boolean; dataUrl?: string; error?: string }>
      exportTimeline: (
        clips: TimelineClip[],
        outPath: string
      ) => Promise<{ ok: boolean; log?: string; error?: string }>
      transformVideo: (
        inputPath: string,
        outputPath: string,
        opts: ObfuscationOptions
      ) => Promise<{ ok: boolean; error?: string }>
      stitchVideo: (args: StitchArgs) => Promise<{ ok: boolean; error?: string }>
      renderPreview: (args: PreviewArgs) => Promise<PreviewResult>
      onFfmpegProgress: (
        callback: (info: { file: string; time: string; speed: string; raw: string }) => void
      ) => () => void
      library: {
        list: () => Promise<LibraryIndex>
        stats: () => Promise<LibraryStats>
        pickAudioFile: () => Promise<string | undefined>
        importVideos: (opts: ImportOptions) => Promise<{ ok: boolean; error?: string }>
        importAudio: (
          path: string
        ) => Promise<{ ok: boolean; audio?: AudioMeta; error?: string }>
        deleteClips: (ids: string[]) => Promise<{ ok: boolean }>
        deleteAudios: (ids: string[]) => Promise<{ ok: boolean }>
        deleteImport: (importId: string) => Promise<{ ok: boolean }>
        readAsBase64: (
          rel: string
        ) => Promise<{ ok: boolean; base64?: string; mime?: string; error?: string }>
        rootDir: () => Promise<string>
        getSourceVideoUrl: (
          importId: string
        ) => Promise<
          | { ok: true; url: string; sourcePath: string; exists: boolean }
          | { ok: false; error: string }
        >
        createGroup: (input: {
          importId: string
          clipIds: string[]
          name?: string
          description?: string
        }) => Promise<{ ok: true; group: ClipGroup } | { ok: false; error: string }>
        deleteGroup: (groupId: string) => Promise<{ ok: boolean }>
        renameGroup: (groupId: string, name: string) => Promise<{ ok: boolean }>
        updateGroup: (
          groupId: string,
          patch: { name?: string; description?: string }
        ) => Promise<{ ok: boolean }>
        onImportProgress: (cb: (ev: ImportProgressEvent) => void) => () => void
      }
      mix: {
        render: (req: MixRenderRequest) => Promise<MixRenderResult>
        preview: (req: MixPreviewRequest) => Promise<MixPreviewResult>
        pickOutputPath: (defaultName?: string) => Promise<string | undefined>
        listProjects: () => Promise<MixProjectMeta[]>
        saveProject: (name: string, timeline: MixTimeline, id?: string) => Promise<MixProjectMeta>
        loadProject: (id: string) => Promise<MixProjectMeta | null>
        deleteProject: (id: string) => Promise<void>
        onProgress: (cb: (ev: MixRenderProgressEvent) => void) => () => void
        pickReferenceVideo: () => Promise<string | undefined>
        analyzeReference: (req: AnalyzeReferenceRequest) => Promise<AnalyzeReferenceResult>
        readReferenceBytes: (
          path: string
        ) => Promise<
          | { ok: true; base64: string; mime: string; sizeBytes: number }
          | { ok: false; error: string; sizeBytes?: number }
        >
        probeReferenceMeta: (
          path: string
        ) => Promise<{ ok: boolean; durationSec?: number; sizeBytes?: number; error?: string }>
      }
    }
  }
}
