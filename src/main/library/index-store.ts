import { existsSync, readFileSync, writeFileSync, statSync, unlinkSync } from 'node:fs'
import type {
  AudioMeta,
  ClipGroup,
  ClipMeta,
  ImportRecord,
  LibraryIndex,
  LibraryStats
} from '../../shared/library'
import { audiosDir, clipsDir, indexLockPath, indexPath, libraryRoot, resolveRel } from './paths'

const EMPTY_INDEX: LibraryIndex = {
  version: 1,
  imports: [],
  clips: [],
  audios: [],
  clipGroups: []
}

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
    if (!parsed.clipGroups) parsed.clipGroups = []
    cache = parsed
    return cache
  } catch (e) {
    console.error('[library] failed to read index, starting fresh:', e)
    cache = structuredClone(EMPTY_INDEX)
    return cache
  }
}

/** 整体序列化写回；同进程内简单文件锁 */
export function writeIndex(index: LibraryIndex): void {
  const lock = indexLockPath()
  const lockExists = existsSync(lock)
  if (lockExists) {
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
    if (i.clipGroups) {
      i.clipGroups = i.clipGroups.filter((g) => g.importId !== importId)
    }
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
    for (const imp of i.imports) {
      imp.clipIds = imp.clipIds.filter((cid) => !set.has(cid))
    }
    if (i.clipGroups) {
      i.clipGroups = i.clipGroups
        .map((g) => ({ ...g, clipIds: g.clipIds.filter((cid) => !set.has(cid)) }))
        .filter((g) => g.clipIds.length >= 1)
    }
  })
  return removed
}

// ── 组操作 ─────────────────────────────────────────────────────

export function createGroup(input: {
  importId: string
  clipIds: string[]
  name?: string
  description?: string
}): { ok: true; group: ClipGroup } | { ok: false; error: string } {
  if (input.clipIds.length < 1) {
    return { ok: false, error: '请至少选 1 段' }
  }
  let result: ClipGroup | null = null
  let err: string | null = null
  mutate((i) => {
    const imp = i.imports.find((r) => r.id === input.importId)
    if (!imp) {
      err = '来源不存在'
      return
    }
    const idxs = input.clipIds.map((cid) => imp.clipIds.indexOf(cid))
    if (idxs.some((x) => x < 0)) {
      err = '所选片段不全属于该来源'
      return
    }
    const sorted = [...idxs].sort((a, b) => a - b)
    for (let k = 1; k < sorted.length; k++) {
      if (sorted[k] !== sorted[k - 1] + 1) {
        err = '所选片段必须在该来源里连续'
        return
      }
    }
    const ordered = sorted.map((i2) => imp.clipIds[i2])
    if (!i.clipGroups) i.clipGroups = []
    i.clipGroups = i.clipGroups
      .map((g) => ({
        ...g,
        clipIds: g.clipIds.filter((cid) => !ordered.includes(cid))
      }))
      .filter((g) => g.clipIds.length >= 1)
    const used = new Set(i.clipGroups.filter((g) => g.importId === imp.id).map((g) => g.name))
    let autoName = input.name?.trim() || ''
    if (!autoName) {
      for (let k = 0; k < 26; k++) {
        const n = `组 ${String.fromCharCode(65 + k)}`
        if (!used.has(n)) {
          autoName = n
          break
        }
      }
      if (!autoName) autoName = `组 ${i.clipGroups.length + 1}`
    }
    const desc = input.description?.trim()
    const g: ClipGroup = {
      id: 'grp_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      importId: imp.id,
      name: autoName,
      ...(desc ? { description: desc.slice(0, 200) } : {}),
      clipIds: ordered,
      createdAt: Date.now()
    }
    i.clipGroups.push(g)
    result = g
  })
  if (err) return { ok: false, error: err }
  if (!result) return { ok: false, error: '创建失败' }
  return { ok: true, group: result }
}

export function deleteGroup(groupId: string): boolean {
  let ok = false
  mutate((i) => {
    if (!i.clipGroups) return
    const before = i.clipGroups.length
    i.clipGroups = i.clipGroups.filter((g) => g.id !== groupId)
    ok = before !== i.clipGroups.length
  })
  return ok
}

export function renameGroup(groupId: string, name: string): boolean {
  return updateGroup(groupId, { name })
}

export function updateGroup(
  groupId: string,
  patch: { name?: string; description?: string }
): boolean {
  let ok = false
  mutate((i) => {
    if (!i.clipGroups) return
    const g = i.clipGroups.find((x) => x.id === groupId)
    if (!g) return
    if (patch.name !== undefined) {
      const trimmed = patch.name.trim()
      if (!trimmed) return
      g.name = trimmed.slice(0, 32)
      ok = true
    }
    if (patch.description !== undefined) {
      const d = patch.description.trim()
      if (d) g.description = d.slice(0, 200)
      else delete g.description
      ok = true
    }
  })
  return ok
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
  for (const c of i.clips) {
    try {
      bytes += statSync(resolveRel(c.videoRel)).size
    } catch {
      /* ignore */
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

export function bootstrap(): void {
  libraryRoot()
  clipsDir()
  audiosDir()
}
