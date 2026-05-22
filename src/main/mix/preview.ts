import { mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { MixPreviewRequest, MixPreviewResult } from '../../shared/mix'
import { readIndex } from '../library/index-store'
import { resolveRel } from '../library/paths'
import { renderMix } from './render'

/**
 * 预览：取时间线前若干段直到累计 ≈ maxSec，跑一遍完整流水线（含 obfuscation），
 * 返回 base64。
 */
export async function previewMix(
  ffmpeg: string,
  ffprobe: string,
  req: MixPreviewRequest
): Promise<MixPreviewResult> {
  const maxSec = req.maxSec ?? 3
  const idx = readIndex()
  const clipMap = new Map(idx.clips.map((c) => [c.id, c]))

  let acc = 0
  const previewClipIds: string[] = []
  for (const id of req.timeline.clipIds) {
    const c = clipMap.get(id)
    if (!c) continue
    previewClipIds.push(id)
    acc += c.durationSec
    if (acc >= maxSec) break
  }
  if (previewClipIds.length === 0) {
    return { ok: false, error: '时间线为空' }
  }

  // 复制 timeline，replace clipIds，并把 obfuscation 里"会改变时长/拼接"的设置全部清零
  // 注意：obfuscation-filter 不看 enabled 标志，而是看具体数值是否非零
  const previewObf = structuredClone(req.timeline.obfuscation)
  previewObf.trim = {
    startSec: 0,
    endSec: 0,
    middleRemoveSec: 0,
    randomStartJitter: false
  }
  previewObf.concat = {}
  if (req.withObfuscation === false) {
    previewObf.geometry = { ...previewObf.geometry, enabled: false }
    previewObf.color = { ...previewObf.color, enabled: false }
    previewObf.audio = { ...previewObf.audio, enabled: false }
    previewObf.detail = { ...previewObf.detail, enabled: false }
  }

  const workDir = join(app.getPath('userData'), 'library', 'tmp', `mixpreview-${Date.now()}`)
  mkdirSync(workDir, { recursive: true })
  const outPath = join(workDir, 'preview.mp4')

  try {
    const r = await renderMix(
      ffmpeg,
      ffprobe,
      {
        timeline: { ...req.timeline, clipIds: previewClipIds, obfuscation: previewObf },
        outputPath: outPath
      },
      () => undefined
    )
    if (!r.ok) return { ok: false, error: r.error }

    const buf = readFileSync(outPath)
    const st = statSync(outPath)
    if (st.size > 50 * 1024 * 1024) {
      return { ok: false, error: '预览文件过大' }
    }
    // 估算时长 = 选中片段累计
    const totalDur = previewClipIds
      .map((id) => clipMap.get(id))
      .filter(Boolean)
      .reduce((a, c) => a + (c as { durationSec: number }).durationSec, 0)

    void resolveRel
    return {
      ok: true,
      base64: buf.toString('base64'),
      mime: 'video/mp4',
      durationSec: totalDur
    }
  } finally {
    try {
      rmSync(workDir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
}
