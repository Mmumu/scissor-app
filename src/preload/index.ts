import { contextBridge, ipcRenderer } from 'electron'
import type {
  CompareVideosOptions,
  DedupeGroup,
  TimelineClip,
  VideoInfo
} from '../shared/types'
import type { ObfuscationOptions } from '../shared/obfuscation'
import type {
  AudioMeta,
  ClipGroup,
  ImportOptions,
  ImportProgressEvent,
  LibraryIndex,
  LibraryStats
} from '../shared/library'
import type {
  MixPreviewRequest,
  MixPreviewResult,
  MixProjectMeta,
  MixRenderProgressEvent,
  MixRenderRequest,
  MixRenderResult,
  MixTimeline,
  ReferenceSegment
} from '../shared/mix'

export type AnalyzeReferenceRequest = {
  path: string
  threshold?: number
  minSegSec?: number
  maxSegSec?: number
}

export type AnalyzeReferenceResult =
  | {
      ok: true
      durationSec: number
      sizeBytes: number
      segments: ReferenceSegment[]
      threshold: number
    }
  | { ok: false; error: string }

export type {
  CompareVideosOptions,
  DedupeGroup,
  TimelineClip,
  VideoInfo,
  ObfuscationOptions,
  AudioMeta,
  ImportOptions,
  ImportProgressEvent,
  LibraryIndex,
  LibraryStats,
  MixPreviewRequest,
  MixPreviewResult,
  MixProjectMeta,
  MixRenderProgressEvent,
  MixRenderRequest,
  MixRenderResult,
  MixTimeline,
  ReferenceSegment
}

export type InsertSide = 'top' | 'bottom' | 'left' | 'right'
export type InsertPosition = { side: InsertSide; offsetPx: number }

export type StitchArgs = {
  mainPath: string
  insertPath: string
  outputPath: string
  insertSizePx: number
  insertPositions: InsertPosition[]
  obfuscation: ObfuscationOptions
}

export type PreviewArgs = {
  mode: 'transform' | 'stitch'
  mainPath: string
  obfuscation: ObfuscationOptions
  startSec?: number
  durationSec?: number
  insertPath?: string
  insertSizePx?: number
  insertPositions?: InsertPosition[]
}

export type PreviewResult = {
  ok: boolean
  base64?: string
  mime?: string
  durationSec?: number
  error?: string
}

contextBridge.exposeInMainWorld('scissor', {
  pickVideos: (): Promise<string[] | undefined> => ipcRenderer.invoke('pickVideos'),
  pickImage: (): Promise<string | undefined> => ipcRenderer.invoke('pickImage'),
  readStickerPreview: (filePath: string): Promise<string | null> =>
    ipcRenderer.invoke('readStickerPreview', filePath),
  compareVideos: (
    path1: string,
    path2: string,
    opts?: CompareVideosOptions
  ): Promise<[VideoInfo, VideoInfo]> => ipcRenderer.invoke('compareVideos', path1, path2, opts),
  pickSavePath: (defaultName?: string): Promise<string | undefined> =>
    ipcRenderer.invoke('pickSavePath', defaultName),
  pickDirectory: (): Promise<string | undefined> => ipcRenderer.invoke('pickDirectory'),
  checkFfmpeg: (): Promise<{ ok: boolean; ffmpeg?: string; ffprobe?: string; error?: string }> =>
    ipcRenderer.invoke('checkFfmpeg'),
  getLuts: (): Promise<{ name: string; path: string }[]> => ipcRenderer.invoke('getLuts'),
  dedupeScan: (paths: string[]): Promise<{ ok: boolean; groups?: DedupeGroup[]; error?: string }> =>
    ipcRenderer.invoke('dedupeScan', paths),
  ffprobeDuration: (path: string): Promise<{ ok: boolean; durationSec?: number; error?: string }> =>
    ipcRenderer.invoke('ffprobeDuration', path),
  getVideoDims: (path: string): Promise<{ ok: boolean; w?: number; h?: number; error?: string }> =>
    ipcRenderer.invoke('getVideoDims', path),
  extractFirstFrame: (
    path: string
  ): Promise<{ ok: boolean; dataUrl?: string; error?: string }> =>
    ipcRenderer.invoke('extractFirstFrame', path),
  exportTimeline: (
    clips: TimelineClip[],
    outPath: string
  ): Promise<{ ok: boolean; log?: string; error?: string }> =>
    ipcRenderer.invoke('exportTimeline', clips, outPath),
  transformVideo: (
    inputPath: string,
    outputPath: string,
    opts: ObfuscationOptions
  ): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('transformVideo', inputPath, outputPath, opts),
  stitchVideo: (args: StitchArgs): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('stitchVideo', args),
  renderPreview: (args: PreviewArgs): Promise<PreviewResult> =>
    ipcRenderer.invoke('renderPreview', args),
  onFfmpegProgress: (
    callback: (info: { file: string; time: string; speed: string; raw: string }) => void
  ) => {
    const listener = (_e: unknown, info: unknown) =>
      callback(info as { file: string; time: string; speed: string; raw: string })
    ipcRenderer.on('ffmpeg-progress', listener)
    return () => {
      ipcRenderer.removeListener('ffmpeg-progress', listener)
    }
  },

  // ── 「随心剪」素材池 ───────────────────────────────────
  library: {
    list: (): Promise<LibraryIndex> => ipcRenderer.invoke('library:list'),
    stats: (): Promise<LibraryStats> => ipcRenderer.invoke('library:stats'),
    pickAudioFile: (): Promise<string | undefined> =>
      ipcRenderer.invoke('library:pickAudioFile'),
    importVideos: (opts: ImportOptions): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('library:importVideos', opts),
    importAudio: (
      path: string
    ): Promise<{ ok: boolean; audio?: AudioMeta; error?: string }> =>
      ipcRenderer.invoke('library:importAudio', path),
    deleteClips: (ids: string[]): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('library:deleteClips', ids),
    deleteAudios: (ids: string[]): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('library:deleteAudios', ids),
    deleteImport: (importId: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('library:deleteImport', importId),
    readAsBase64: (
      rel: string
    ): Promise<{ ok: boolean; base64?: string; mime?: string; error?: string }> =>
      ipcRenderer.invoke('library:readAsBase64', rel),
    rootDir: (): Promise<string> => ipcRenderer.invoke('library:rootDir'),
    getSourceVideoUrl: (
      importId: string
    ): Promise<
      | { ok: true; url: string; sourcePath: string; exists: boolean }
      | { ok: false; error: string }
    > => ipcRenderer.invoke('library:getSourceVideoUrl', importId),
    createGroup: (input: {
      importId: string
      clipIds: string[]
      name?: string
      description?: string
    }): Promise<{ ok: true; group: ClipGroup } | { ok: false; error: string }> =>
      ipcRenderer.invoke('library:createGroup', input),
    deleteGroup: (groupId: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('library:deleteGroup', groupId),
    renameGroup: (groupId: string, name: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('library:renameGroup', { groupId, name }),
    updateGroup: (
      groupId: string,
      patch: { name?: string; description?: string }
    ): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('library:updateGroup', { groupId, patch }),
    onImportProgress: (cb: (ev: ImportProgressEvent) => void) => {
      const listener = (_e: unknown, ev: unknown) => cb(ev as ImportProgressEvent)
      ipcRenderer.on('library:import-progress', listener)
      return () => {
        ipcRenderer.removeListener('library:import-progress', listener)
      }
    }
  },

  // ── 混剪台 ────────────────────────────────────────────
  mix: {
    render: (req: MixRenderRequest): Promise<MixRenderResult> =>
      ipcRenderer.invoke('mix:render', req),
    preview: (req: MixPreviewRequest): Promise<MixPreviewResult> =>
      ipcRenderer.invoke('mix:preview', req),
    pickOutputPath: (defaultName?: string): Promise<string | undefined> =>
      ipcRenderer.invoke('mix:pickOutputPath', defaultName),
    listProjects: (): Promise<MixProjectMeta[]> => ipcRenderer.invoke('mix:listProjects'),
    saveProject: (name: string, timeline: MixTimeline, id?: string): Promise<MixProjectMeta> =>
      ipcRenderer.invoke('mix:saveProject', name, timeline, id),
    loadProject: (id: string): Promise<MixProjectMeta | null> =>
      ipcRenderer.invoke('mix:loadProject', id),
    deleteProject: (id: string): Promise<void> => ipcRenderer.invoke('mix:deleteProject', id),
    onProgress: (cb: (ev: MixRenderProgressEvent) => void) => {
      const listener = (_e: unknown, ev: unknown) => cb(ev as MixRenderProgressEvent)
      ipcRenderer.on('mix:progress', listener)
      return () => {
        ipcRenderer.removeListener('mix:progress', listener)
      }
    },
    pickReferenceVideo: (): Promise<string | undefined> =>
      ipcRenderer.invoke('mix:pickReferenceVideo'),
    analyzeReference: (req: AnalyzeReferenceRequest): Promise<AnalyzeReferenceResult> =>
      ipcRenderer.invoke('mix:analyzeReference', req),
    readReferenceBytes: (
      path: string
    ): Promise<
      | { ok: true; base64: string; mime: string; sizeBytes: number }
      | { ok: false; error: string; sizeBytes?: number }
    > => ipcRenderer.invoke('mix:readReferenceBytes', path),
    probeReferenceMeta: (
      path: string
    ): Promise<{ ok: boolean; durationSec?: number; sizeBytes?: number; error?: string }> =>
      ipcRenderer.invoke('mix:probeReferenceMeta', path)
  }
})
