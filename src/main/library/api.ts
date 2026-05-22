/** 库的对外门面（聚合操作，被 main/index.ts 的 IPC 调用） */

import { existsSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { ImportOptions, ImportProgressEvent, LibraryIndex, LibraryStats } from '../../shared/library'
import { bootstrap, computeStats, readIndex, removeAudios, removeClips, removeImport } from './index-store'
import { importVideos } from './import'
import { importStandaloneAudio } from './audio-import'
import { libraryRoot, resolveRel } from './paths'

export function init(): void {
  bootstrap()
}

export function list(): LibraryIndex {
  return readIndex()
}

export function stats(): LibraryStats {
  return computeStats()
}

export async function doImportVideos(
  ffmpeg: string,
  ffprobe: string,
  opts: ImportOptions,
  onProgress: (ev: ImportProgressEvent) => void
): Promise<void> {
  await importVideos(ffmpeg, ffprobe, opts, onProgress)
}

export async function doImportAudio(
  ffmpeg: string,
  ffprobe: string,
  path: string
) {
  return importStandaloneAudio(ffmpeg, ffprobe, path)
}

export function deleteClipsBy(ids: string[]): void {
  const removed = removeClips(ids)
  for (const c of removed) {
    safeUnlinkRel(c.videoRel)
    safeUnlinkRel(c.thumbRel)
  }
}

export function deleteAudiosBy(ids: string[]): void {
  const removed = removeAudios(ids)
  for (const a of removed) {
    safeUnlinkRel(a.audioRel)
    safeUnlinkRel(a.waveformRel)
  }
}

export function deleteImportBy(importId: string): void {
  const idx = readIndex()
  const rec = idx.imports.find((r) => r.id === importId)
  if (!rec) return
  // 先收集物理文件路径
  const clipsToDel = idx.clips.filter((c) => c.importId === importId)
  const audiosToDel = idx.audios.filter((a) => a.importId === importId)
  removeImport(importId)
  for (const c of clipsToDel) {
    safeUnlinkRel(c.videoRel)
    safeUnlinkRel(c.thumbRel)
  }
  for (const a of audiosToDel) {
    safeUnlinkRel(a.audioRel)
    safeUnlinkRel(a.waveformRel)
  }
}

export function getAbsPathByRel(rel: string): string {
  return resolveRel(rel)
}

export function readClipFileAsBase64(rel: string): { ok: boolean; base64?: string; mime?: string; error?: string } {
  const abs = resolveRel(rel)
  if (!existsSync(abs)) return { ok: false, error: 'not found' }
  try {
    const st = statSync(abs)
    if (st.size > 100 * 1024 * 1024) return { ok: false, error: 'too large' }
    const buf = require('node:fs').readFileSync(abs) as Buffer
    const mime = rel.endsWith('.jpg') || rel.endsWith('.jpeg') ? 'image/jpeg'
      : rel.endsWith('.png') ? 'image/png'
      : rel.endsWith('.mp4') ? 'video/mp4'
      : rel.endsWith('.m4a') ? 'audio/mp4'
      : rel.endsWith('.mp3') ? 'audio/mpeg'
      : 'application/octet-stream'
    return { ok: true, base64: buf.toString('base64'), mime }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}

export function libRoot(): string {
  return libraryRoot()
}

function safeUnlinkRel(rel: string): void {
  try {
    const p = join(libraryRoot(), rel)
    if (existsSync(p)) rmSync(p)
  } catch {
    /* ignore */
  }
}
