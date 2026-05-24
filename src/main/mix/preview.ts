import { mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { MixPreviewRequest, MixPreviewResult } from '../../shared/mix'
import { readIndex } from '../library/index-store'
import { resolveRel } from '../library/paths'
import { renderMix } from './render'

/**
 * 预览：
 *  - withObfuscation === false（默认）：只跑拼接 + 音频合成，完整时长，不重新过原创编码，**快**。
 *  - withObfuscation === true：跑完整流水线（含过原创参数）。
 *  - maxSec：若 >0 则截前若干段（累计达到即止），否则使用全部段。
 */
export async function previewMix(
  ffmpeg: string,
  ffprobe: string,
  req: MixPreviewRequest
): Promise<MixPreviewResult> {
  const idx = readIndex()
  const clipMap = new Map(idx.clips.map((c) => [c.id, c]))

  // 选片：默认全量；maxSec > 0 时截断
  const previewClipIds: string[] = []
  if (req.maxSec && req.maxSec > 0) {
    let acc = 0
    for (const id of req.timeline.clipIds) {
      const c = clipMap.get(id)
      if (!c) continue
      previewClipIds.push(id)
      acc += c.durationSec
      if (acc >= req.maxSec) break
    }
  } else {
    for (const id of req.timeline.clipIds) {
      if (clipMap.has(id)) previewClipIds.push(id)
    }
  }
  if (previewClipIds.length === 0) {
    return { ok: false, error: '时间线为空' }
  }

  const withObf = req.withObfuscation === true
  // 复制 timeline，并把 obfuscation 里"会改变时长/拼接"的设置全部清零（即便走 obfuscation 也不让它改时长）
  const previewObf = structuredClone(req.timeline.obfuscation)
  previewObf.trim = {
    startSec: 0,
    endSec: 0,
    middleRemoveSec: 0,
    randomStartJitter: false
  }
  previewObf.concat = {}

  const workDir = join(app.getPath('userData'), 'library', 'tmp', `mixpreview-${Date.now()}`)
  mkdirSync(workDir, { recursive: true })
  const outPath = join(workDir, 'preview.mp4')

  try {
    const r = await renderMix(
      ffmpeg,
      ffprobe,
      {
        timeline: { ...req.timeline, clipIds: previewClipIds, obfuscation: previewObf },
        outputPath: outPath,
        skipObfuscation: !withObf
      },
      () => undefined
    )
    if (!r.ok) return { ok: false, error: r.error }

    const buf = readFileSync(outPath)
    const st = statSync(outPath)
    if (st.size > 200 * 1024 * 1024) {
      return { ok: false, error: '预览文件过大（>200MB）；请减少段数或选用更短素材' }
    }

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
