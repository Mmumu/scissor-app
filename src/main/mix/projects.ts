import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { libraryRoot } from '../library/paths'
import type { MixProjectMeta, MixTimeline } from '../../shared/mix'

const PROJECTS_SUBDIR = 'projects'

function projectsDir(): string {
  const d = join(libraryRoot(), PROJECTS_SUBDIR)
  if (!existsSync(d)) mkdirSync(d, { recursive: true })
  return d
}

export function listProjects(): MixProjectMeta[] {
  const dir = projectsDir()
  const files = readdirSync(dir).filter((n) => n.endsWith('.json'))
  const out: MixProjectMeta[] = []
  for (const f of files) {
    try {
      const raw = readFileSync(join(dir, f), 'utf8')
      out.push(JSON.parse(raw))
    } catch {
      /* skip broken */
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

export function saveProject(name: string, timeline: MixTimeline, id?: string): MixProjectMeta {
  const now = Date.now()
  const finalId = id ?? `proj_${now.toString(36)}_${Math.random().toString(36).slice(2, 6)}`
  const existing = id ? readProject(id) : null
  const meta: MixProjectMeta = {
    id: finalId,
    name,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    timeline
  }
  writeFileSync(join(projectsDir(), `${finalId}.json`), JSON.stringify(meta, null, 2), 'utf8')
  return meta
}

export function readProject(id: string): MixProjectMeta | null {
  const p = join(projectsDir(), `${id}.json`)
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

export function deleteProject(id: string): void {
  const p = join(projectsDir(), `${id}.json`)
  if (existsSync(p)) rmSync(p)
}
