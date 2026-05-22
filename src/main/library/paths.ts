import { mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

/**
 * 素材池根目录：<userData>/library
 * 子目录：clips/ audios/ imports/ tmp/
 * tmp/ 用于导入过程中的中间产物，全部完成才 rename 进 clips/
 */

let cachedRoot: string | null = null

export function libraryRoot(): string {
  if (cachedRoot) return cachedRoot
  const root = join(app.getPath('userData'), 'library')
  ensureDirs(root)
  cachedRoot = root
  return root
}

export function clipsDir(): string {
  return join(libraryRoot(), 'clips')
}

export function audiosDir(): string {
  return join(libraryRoot(), 'audios')
}

export function tmpDir(): string {
  return join(libraryRoot(), 'tmp')
}

export function indexPath(): string {
  return join(libraryRoot(), 'index.json')
}

export function indexLockPath(): string {
  return join(libraryRoot(), 'index.lock')
}

/** 相对 library/ 的路径 → 绝对路径 */
export function resolveRel(rel: string): string {
  return join(libraryRoot(), rel)
}

function ensureDirs(root: string): void {
  for (const d of [root, join(root, 'clips'), join(root, 'audios'), join(root, 'tmp')]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true })
  }
}
