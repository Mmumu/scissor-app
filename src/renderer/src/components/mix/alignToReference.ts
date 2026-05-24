import type { ClipMeta } from '../../../../shared/library'
import type { ClipOverride, ReferenceSegment } from '../../../../shared/mix'

export type AlignOptions = {
  /** 是否允许同一个 clip 被复用到多个参考段；默认 false */
  allowReuse?: boolean
  /** 是否惩罚连续同源（importId 相同）；默认 true */
  spreadSources?: boolean
  /** 短于参考段 N 秒视为"撑不满"，给出惩罚；默认 0.05 */
  shortTolerance?: number
}

export type AlignSlot = {
  /** 该段被分配的 clipId；若为空表示素材池里没合适的 */
  clipId?: string
  /** 子段裁剪信息（仅当真的需要截短时填入） */
  override?: ClipOverride
  /** 此处期望的参考时长 */
  refDur: number
  /** 实际匹配到的 clip 时长（裁剪前） */
  clipDur?: number
  /** 用于 UI 提示：偏差类型 */
  status: 'matched' | 'trimmed' | 'short' | 'empty'
  /** 用于 UI 显示：偏差秒（matched/trimmed 应在 ±0.1 内） */
  diffSec?: number
}

export type AlignResult = {
  slots: AlignSlot[]
  /** 实际产出的 clipIds（去掉 empty 槽） */
  clipIds: string[]
  /** 实际产出的 clipOverrides（按新数组的下标） */
  clipOverrides: Record<number, ClipOverride>
  stats: {
    refCount: number
    filled: number
    trimmed: number
    short: number
    empty: number
    refTotalSec: number
    outputTotalSec: number
  }
}

/**
 * 贪心 + 简易加权打分对齐：
 *  - 每个参考段挑当下打分最低的 clip
 *  - 打分 = |clip.dur - ref.dur| + (clip.dur < ref.dur - tol 时的"撑不满"惩罚) + (与上一段同源时的发散惩罚)
 *  - clip 比参考长 → 记录 override 截短到参考长
 *  - clip 比参考短超出容忍 → 仍保留但标 short（输出会比该段短一截）
 *
 * 简单可控；当 N×M ≤ 数百量级足够。
 */
export function autoAlignToReference(
  refSegments: ReferenceSegment[],
  pool: ClipMeta[],
  opts: AlignOptions = {}
): AlignResult {
  const allowReuse = opts.allowReuse ?? false
  const spreadSources = opts.spreadSources ?? true
  const shortTol = opts.shortTolerance ?? 0.05

  const used = new Set<string>()
  const slots: AlignSlot[] = []
  let lastImportId = ''

  for (const ref of refSegments) {
    const candidates = pool.filter((c) => allowReuse || !used.has(c.id))
    if (candidates.length === 0) {
      slots.push({ refDur: ref.dur, status: 'empty' })
      continue
    }

    let best: ClipMeta | null = null
    let bestScore = Infinity
    for (const c of candidates) {
      const lenDiff = Math.abs(c.durationSec - ref.dur)
      const tooShortPen = c.durationSec < ref.dur - shortTol ? 6 + (ref.dur - c.durationSec) : 0
      const sameSourcePen = spreadSources && c.importId === lastImportId ? 1.5 : 0
      const score = lenDiff + tooShortPen + sameSourcePen
      if (score < bestScore) {
        bestScore = score
        best = c
      }
    }
    if (!best) {
      slots.push({ refDur: ref.dur, status: 'empty' })
      continue
    }
    used.add(best.id)
    lastImportId = best.importId

    if (best.durationSec > ref.dur + 0.05) {
      // 截短
      slots.push({
        clipId: best.id,
        override: { startSec: 0, durationSec: ref.dur },
        refDur: ref.dur,
        clipDur: best.durationSec,
        diffSec: 0,
        status: 'trimmed'
      })
    } else if (best.durationSec < ref.dur - shortTol) {
      slots.push({
        clipId: best.id,
        refDur: ref.dur,
        clipDur: best.durationSec,
        diffSec: best.durationSec - ref.dur,
        status: 'short'
      })
    } else {
      slots.push({
        clipId: best.id,
        refDur: ref.dur,
        clipDur: best.durationSec,
        diffSec: best.durationSec - ref.dur,
        status: 'matched'
      })
    }
  }

  const clipIds: string[] = []
  const clipOverrides: Record<number, ClipOverride> = {}
  for (const s of slots) {
    if (!s.clipId) continue
    const idx = clipIds.length
    clipIds.push(s.clipId)
    if (s.override) clipOverrides[idx] = s.override
  }

  const stats = {
    refCount: refSegments.length,
    filled: slots.filter((s) => s.clipId).length,
    trimmed: slots.filter((s) => s.status === 'trimmed').length,
    short: slots.filter((s) => s.status === 'short').length,
    empty: slots.filter((s) => s.status === 'empty').length,
    refTotalSec: refSegments.reduce((a, r) => a + r.dur, 0),
    outputTotalSec: slots.reduce((a, s) => {
      if (s.status === 'empty') return a
      if (s.status === 'short' && s.clipDur != null) return a + s.clipDur
      return a + s.refDur
    }, 0)
  }
  return { slots, clipIds, clipOverrides, stats }
}
