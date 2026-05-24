import type { ClipGroup, ClipMeta, ImportRecord, LibraryIndex } from '../../../shared/library'

export type GroupableSelection = {
  /** 是否可成组（选中数 ≥ 2、同 import、连续） */
  canGroup: boolean
  /** 不能成组时给的人话 */
  reason?: string
  importId?: string
  /** 按 import.clipIds 顺序排好的 clipIds */
  orderedIds?: string[]
}

/** 判断当前 selectedClipIds 是否可以"成组"。 */
export function evaluateGrouping(
  index: LibraryIndex,
  selectedClipIds: ReadonlySet<string>
): GroupableSelection {
  if (selectedClipIds.size < 1) {
    return { canGroup: false, reason: '请先选择至少 1 段' }
  }
  const ids = Array.from(selectedClipIds)
  const clipsById = new Map(index.clips.map((c) => [c.id, c] as const))
  const selectedClips: ClipMeta[] = []
  for (const id of ids) {
    const c = clipsById.get(id)
    if (!c) return { canGroup: false, reason: '所选片段不存在' }
    selectedClips.push(c)
  }
  // 跨来源：把不同的 import 数量算清楚再写到提示里，便于用户一眼看懂
  const distinctImports = new Set(selectedClips.map((c) => c.importId))
  if (distinctImports.size > 1) {
    return {
      canGroup: false,
      reason: `所选片段来自 ${distinctImports.size} 个不同来源，组只能在同一来源内创建`
    }
  }
  const importId = selectedClips[0].importId
  const imp = index.imports.find((r) => r.id === importId)
  if (!imp) return { canGroup: false, reason: '来源不存在' }
  const idxs = ids.map((id) => imp.clipIds.indexOf(id)).sort((a, b) => a - b)
  if (idxs.some((x) => x < 0)) return { canGroup: false, reason: '所选片段不全属于该来源' }
  for (let k = 1; k < idxs.length; k++) {
    if (idxs[k] !== idxs[k - 1] + 1) {
      const missing = idxs[k] - idxs[k - 1] - 1
      return {
        canGroup: false,
        reason:
          missing > 0
            ? `选中片段在来源里不连续（中间漏了 ${missing} 段），需要"挨着的"几段才能成组`
            : '选中片段在来源里不连续，需要"挨着的"几段才能成组'
      }
    }
  }
  const orderedIds = idxs.map((i) => imp.clipIds[i])
  return { canGroup: true, importId, orderedIds }
}

/** 给定 clipId 找它所在的组（若有） */
export function findGroupOfClip(
  groups: ReadonlyArray<ClipGroup> | undefined,
  clipId: string
): ClipGroup | undefined {
  if (!groups) return undefined
  return groups.find((g) => g.clipIds.includes(clipId))
}

export type RenderUnit =
  | { kind: 'clip'; clip: ClipMeta }
  | { kind: 'group'; group: ClipGroup; clips: ClipMeta[] }

/**
 * 给定可见的 clip 列表（已经按你想要的顺序排好），把它们拼成"渲染单元"序列：
 * 单段 clip 直接渲染；属于同一组的 clip 合并成一个 group 单元，按 group.clipIds 顺序排。
 * 注意：当某个组的部分成员不在 visibleClips 时，组单元只包含落在 visibleClips 内的成员。
 */
export function buildRenderUnits(
  visibleClips: ReadonlyArray<ClipMeta>,
  groups: ReadonlyArray<ClipGroup> | undefined
): RenderUnit[] {
  if (!groups || groups.length === 0) {
    return visibleClips.map((c) => ({ kind: 'clip' as const, clip: c }))
  }
  const visibleSet = new Set(visibleClips.map((c) => c.id))
  const clipsById = new Map(visibleClips.map((c) => [c.id, c] as const))
  const groupByClip = new Map<string, ClipGroup>()
  for (const g of groups) {
    for (const cid of g.clipIds) groupByClip.set(cid, g)
  }
  const seenGroups = new Set<string>()
  const out: RenderUnit[] = []
  for (const c of visibleClips) {
    const g = groupByClip.get(c.id)
    if (!g) {
      out.push({ kind: 'clip', clip: c })
      continue
    }
    if (seenGroups.has(g.id)) continue
    seenGroups.add(g.id)
    const members = g.clipIds.filter((cid) => visibleSet.has(cid)).map((cid) => clipsById.get(cid)!).filter(Boolean)
    if (members.length === 0) continue
    out.push({ kind: 'group', group: g, clips: members })
  }
  return out
}

/** 总秒数（清晰地用于组头的"合计 X.Xs"显示） */
export function totalDuration(clips: ReadonlyArray<ClipMeta>): number {
  return clips.reduce((a, b) => a + b.durationSec, 0)
}

/** 找一个 clip 所在 import 的颜色（如果父级有 importColors map） */
export function importOf(
  index: LibraryIndex,
  importId: string
): ImportRecord | undefined {
  return index.imports.find((r) => r.id === importId)
}
