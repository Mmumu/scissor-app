import { existsSync, readFileSync, writeFileSync, statSync, unlinkSync } from 'node:fs'
import type {
  AudioMeta,
  ClipMeta,
  ImportRecord,
  LibraryIndex,
  LibraryStats
} from '../../shared/library'
import { audiosDir, clipsDir, indexLockPath, indexPath, libraryRoot, resolveRel } from './paths'

const EMPTY_INDEX: LibraryIndex = { version: 1, imports: [], clips: [], audios: [] }

let cache: LibraryIndex | null = null

/** 读取（首次从磁盘读，之后用内存缓存） */
export function readIndex(): LibraryIndex {
  if (cache) return cache
  const p = indexPath()
  if (!existsSync(p)) {
    cache = structuredClone(EMPTY_INDEX)
    return cache
  }
  try {
    const raw = readFileSync(p, 'utf8')
    const parsed = JSON.parse(raw) as LibraryIndex
    if (parsed.version !== 1) {
      throw new Error(`unsupported library index version: ${parsed.version}`)
    }
    cache = parsed
    return cache
  } catch (e) {
    console.error('[library] failed to read index, starting fresh:', e)
    cache = structuredClone(EMPTY_INDEX)
    return cache
  }
}

/** 整体序列化写回；同进程内简单文件锁（防同进程并发写） */
export function writeIndex(index: LibraryIndex): void {
  const lock = indexLockPath()
  const lockExists = existsSync(lock)
  if (lockExists) {
    // 软告警；多窗口/多导入并发会落到这里，但因为电子单进程通常没并发问题
    console.warn('[library] index.lock exists, overwriting anyway')
  }
  try {
    writeFileSync(lock, String(process.pid))
    writeFileSync(indexPath(), JSON.stringify(index, null, 2), 'utf8')
    cache = index
  } finally {
    try {
      if (existsSync(lock)) unlinkSync(lock)
    } catch {
      /* ignore */
    }
  }
}

/** 在 mutator 里改 cache 后调写回 */
export function mutate<T>(fn: (i: LibraryIndex) => T): T {
  const i = readIndex()
  const result = fn(i)
  writeIndex(i)
  return result
}

export function addImport(record: ImportRecord): void {
  mutate((i) => {
    i.imports.push(record)
  })
}

export function addClip(meta: ClipMeta): void {
  mutate((i) => {
    i.clips.push(meta)
  })
}

export function addAudio(meta: AudioMeta): void {
  mutate((i) => {
    i.audios.push(meta)
  })
}

export function findImportByHash(hash: string): ImportRecord | undefined {
  return readIndex().imports.find((r) => r.sourceHash === hash)
}

export function removeImport(importId: string): void {
  mutate((i) => {
    const r = i.imports.find((x) => x.id === importId)
    if (!r) return
    i.imports = i.imports.filter((x) => x.id !== importId)
    i.clips = i.clips.filter((c) => c.importId !== importId)
    i.audios = i.audios.filter((a) => a.importId !== importId)
  })
}

export function removeClips(ids: string[]): ClipMeta[] {
  const removed: ClipMeta[] = []
  mutate((i) => {
    const set = new Set(ids)
    i.clips = i.clips.filter((c) => {
      if (set.has(c.id)) {
        removed.push(c)
        return false
      }
      return true
    })
    // 从对应 importRecord.clipIds 移除
    for (const imp of i.imports) {
      imp.clipIds = imp.clipIds.filter((cid) => !set.has(cid))
    }
  })
  return removed
}

export function removeAudios(ids: string[]): AudioMeta[] {
  const removed: AudioMeta[] = []
  mutate((i) => {
    const set = new Set(ids)
    i.audios = i.audios.filter((a) => {
      if (set.has(a.id)) {
        removed.push(a)
        return false
      }
      return true
    })
    for (const imp of i.imports) {
      if (imp.audioId && set.has(imp.audioId)) imp.audioId = undefined
    }
  })
  return removed
}

export function computeStats(): LibraryStats {
  const i = readIndex()
  let bytes = 0
  // 估算：只统计 clip 视频文件 + audio 文件
  for (const c of i.clips) {
    try {
      bytes += statSync(resolveRel(c.videoRel)).size
    } catch {
      /* ignore missing */
    }
  }
  for (const a of i.audios) {
    try {
      bytes += statSync(resolveRel(a.audioRel)).size
    } catch {
      /* ignore */
    }
  }
  return {
    clipCount: i.clips.length,
    audioCount: i.audios.length,
    importCount: i.imports.length,
    bytesUsed: bytes
  }
}

/** 仅用于初始化时确认目录存在 */
export function bootstrap(): void {
  // 触发 paths.ts 里的 ensureDirs
  libraryRoot()
  clipsDir()
  audiosDir()
}
