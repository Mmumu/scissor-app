/**
 * 「随心剪」素材池数据模型。
 *
 * 持久化策略：
 *  - 物理文件存在 <userData>/library/{clips,audios}/
 *  - 元数据存在 <userData>/library/index.json
 *  - 索引内存全量加载，写时整体序列化（小项目体量足够）
 */

export type AudioImportMode =
  | 'embed' // 视频段保留音轨；不另存音频文件
  | 'extract' // 视频段去音轨；从源整片抽完整音轨进音频池
  | 'none' // 视频段去音轨；不抽音频

export type CleanupStrength = 'off' | 'metadata-only' | 'light' | 'standard'
// off            = 完全不清洗（开发测试用，UI 不暴露）
// metadata-only  = 只剥 metadata，不重编码
// light          = metadata + 重编码，不做几何/像素扰动
// standard       = metadata + 重编码 + 轻噪点/轻 gblur + 微小裁切（默认）

export type ImportOptions = {
  paths: string[] // 源视频路径数组
  audioMode: AudioImportMode
  cleanup: CleanupStrength
  sceneThreshold: number // 0.15 ~ 0.6，默认 0.3
  minSegSec: number // < 此长度的段合并到邻段，默认 1.0
  maxSegSec: number // > 此长度的段强切，默认 6.0
  /** 若 sourceHash 已存在，是 'skip' / 'reimport-replace' / 'reimport-add' */
  duplicatePolicy?: 'skip' | 'reimport-replace' | 'reimport-add'
}

export type ImportProgressEvent =
  | { phase: 'queued'; sourcePath: string; importId: string }
  | { phase: 'cleaning'; sourcePath: string; importId: string; pct?: number }
  | { phase: 'detecting'; sourcePath: string; importId: string; pct?: number }
  | { phase: 'segmenting'; sourcePath: string; importId: string; pct?: number }
  | { phase: 'thumbing'; sourcePath: string; importId: string; current: number; total: number }
  | { phase: 'audio'; sourcePath: string; importId: string }
  | { phase: 'done'; sourcePath: string; importId: string; clipCount: number }
  | { phase: 'error'; sourcePath: string; importId: string; error: string }
  | { phase: 'duplicate'; sourcePath: string; sourceHash: string; existingImportId: string }

export type ImportRecord = {
  id: string
  /** 源文件原路径（仅留存以做溯源；不用于读取） */
  sourcePath: string
  /** 源文件 sha256 前 16 字节 */
  sourceHash: string
  importedAt: number
  audioMode: AudioImportMode
  cleanup: CleanupStrength
  sceneThreshold: number
  /** 这批拆出的 clip id 列表，顺序 = 源视频中的时间顺序 */
  clipIds: string[]
  /** 关联的音频 id（若 audioMode='extract'） */
  audioId?: string
}

export type ClipMeta = {
  id: string
  importId: string
  /** 在源视频里第几段（0-based） */
  index: number
  /** 在源视频里的入点/出点（清洗前的原时间轴） */
  sourceStartSec: number
  sourceEndSec: number
  /** 切出来的实际时长 */
  durationSec: number
  width: number
  height: number
  fps: number
  hasAudio: boolean
  sceneScore?: number
  /** 物理文件相对 library/ 的路径，如 clips/abcd.mp4 */
  videoRel: string
  thumbRel: string
  createdAt: number
  /** 用户给的自由标签 */
  tags?: string[]
  /** 用户是否标记收藏 */
  starred?: boolean
}

export type AudioMeta = {
  id: string
  /** 关联的导入批次；用户后导入的纯音频此字段为空 */
  importId?: string
  /** 显示名（默认 = 源视频基名 / 用户文件名） */
  label: string
  durationSec: number
  /** 物理文件相对 library/，如 audios/xxx.m4a */
  audioRel: string
  /** 波形图相对路径 */
  waveformRel: string
  createdAt: number
}

export type LibraryIndex = {
  version: 1
  imports: ImportRecord[]
  clips: ClipMeta[]
  audios: AudioMeta[]
}

export const DEFAULT_IMPORT_OPTIONS: Omit<ImportOptions, 'paths'> = {
  audioMode: 'extract',
  cleanup: 'standard',
  sceneThreshold: 0.3,
  minSegSec: 1.0,
  maxSegSec: 6.0
}

export type LibraryStats = {
  clipCount: number
  audioCount: number
  importCount: number
  bytesUsed: number
}
