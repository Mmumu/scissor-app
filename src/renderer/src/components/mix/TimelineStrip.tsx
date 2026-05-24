import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ClipGroup, ClipMeta } from '../../../../shared/library'
import type { ClipOverride } from '../../../../shared/mix'

type Props = {
  clips: ClipMeta[]
  importColors: Map<string, string>
  /** 按时间线下标记的子段裁剪信息 */
  overrides?: Record<number, ClipOverride>
  /** 库里持久化的"组"信息：用于在时间线上把同组连续片段视觉/行为联动 */
  clipGroups?: ReadonlyArray<ClipGroup>
  /** 多选状态 */
  selectedIndices: Set<number>
  onSelectionChange: (next: Set<number>) => void
  /** 拖拽重排：传出新顺序 + 拖拽后想保留的选中下标（用于多选成块拖动后保留高亮） */
  onReorder: (newIds: string[], nextSelection?: Set<number>) => void
  /** 删除一批；删除单个时也走这里（传 size=1 的 Set） */
  onBulkRemove: (indices: Set<number>) => void
}

/**
 * 走一遍时间线，把"连续相邻 + 同组"的片段聚类成 LinkedRun。
 * 同组片段被中间插入了别的片段后，会自然分裂成多个 LinkedRun（仅显示链接的一段）。
 */
type LinkedRun = {
  startIdx: number
  endIdx: number // 含端点
  group: ClipGroup
}
function buildLinkedRuns(
  clips: ClipMeta[],
  groups: ReadonlyArray<ClipGroup> | undefined
): LinkedRun[] {
  if (!groups || groups.length === 0) return []
  const groupOf = new Map<string, ClipGroup>()
  for (const g of groups) for (const cid of g.clipIds) groupOf.set(cid, g)
  const runs: LinkedRun[] = []
  let cur: LinkedRun | null = null
  clips.forEach((c, i) => {
    const g = groupOf.get(c.id)
    if (!g) {
      if (cur && cur.endIdx > cur.startIdx) runs.push(cur)
      cur = null
      return
    }
    if (cur && cur.group.id === g.id) {
      cur.endIdx = i
    } else {
      if (cur && cur.endIdx > cur.startIdx) runs.push(cur)
      cur = { startIdx: i, endIdx: i, group: g }
    }
  })
  if (cur && cur.endIdx > cur.startIdx) runs.push(cur)
  return runs
}

const CLIP_WIDTH = 108 // 竖屏 9:16 卡片固定宽度
const CLIP_GAP = 4

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

export function TimelineStrip({
  clips,
  importColors,
  overrides,
  clipGroups,
  selectedIndices,
  onSelectionChange,
  onReorder,
  onBulkRemove
}: Props) {
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  /** 拖拽落点：idx=N+1（即 clips.length）表示拖到末尾的空白处 */
  const [overTarget, setOverTarget] = useState<{ idx: number; side: 'before' | 'after' } | null>(
    null
  )
  const [draggedSet, setDraggedSet] = useState<Set<number> | null>(null)
  const [scrollLeft, setScrollLeft] = useState(0)
  const [viewportW, setViewportW] = useState(0)
  const trackRef = useRef<HTMLDivElement>(null)
  const lastClickedIdxRef = useRef<number | null>(null)

  const linkedRuns = useMemo(() => buildLinkedRuns(clips, clipGroups), [clips, clipGroups])
  /** idx → 该下标所在的连续同组 run 的所有下标（含自己）。不在任何 run 中则为 null */
  const runMembersByIdx = useMemo(() => {
    const m = new Map<number, number[]>()
    for (const r of linkedRuns) {
      const arr: number[] = []
      for (let i = r.startIdx; i <= r.endIdx; i++) arr.push(i)
      for (const i of arr) m.set(i, arr)
    }
    return m
  }, [linkedRuns])

  const effectiveDurs = useMemo(() => {
    return clips.map((c, i) => {
      const ov = overrides?.[i]
      const start = ov?.startSec ?? 0
      const maxAvail = Math.max(0.05, c.durationSec - start)
      if (ov?.durationSec != null) {
        return Math.min(Math.max(0.05, ov.durationSec), maxAvail)
      }
      return maxAvail
    })
  }, [clips, overrides])
  const totalDur = useMemo(() => effectiveDurs.reduce((a, d) => a + d, 0), [effectiveDurs])
  const totalW = clips.length * CLIP_WIDTH + Math.max(0, clips.length - 1) * CLIP_GAP

  // 观察滚动 + resize 以更新鸟瞰
  useLayoutEffect(() => {
    const el = trackRef.current
    if (!el) return
    const onScroll = (): void => setScrollLeft(el.scrollLeft)
    const onResize = (): void => setViewportW(el.clientWidth)
    onResize()
    el.addEventListener('scroll', onScroll, { passive: true })
    const ro = new ResizeObserver(onResize)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', onScroll)
      ro.disconnect()
    }
  }, [])

  // wheel：手动绑 non-passive，让普通滚轮转横向（避免误滚整页）
  useEffect(() => {
    const el = trackRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      if (e.ctrlKey || e.metaKey) return
      if (e.deltaX === 0 && Math.abs(e.deltaY) > 0) {
        el.scrollLeft += e.deltaY
        e.preventDefault()
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // 切换：点击卡片 = 切换选中 / shift+click = 范围切换（与素材池一致）
  // 若所在的"链接组 run"包含 ≥2 段：默认整组联选。Cmd/Ctrl+click 退化为单段切换。
  function handleClipClick(idx: number, e: React.MouseEvent): void {
    // × 按钮里 stopPropagation 了，但保险起见过滤
    if ((e.target as HTMLElement | null)?.closest('.timeline-clip-x')) return
    if (e.shiftKey && lastClickedIdxRef.current != null) {
      const anchor = lastClickedIdxRef.current
      if (anchor >= 0 && anchor < clips.length) {
        const start = Math.min(anchor, idx)
        const end = Math.max(anchor, idx)
        const targetSelected = selectedIndices.has(idx)
        const next = new Set(selectedIndices)
        for (let i = start; i <= end; i++) {
          if (targetSelected) next.delete(i)
          else next.add(i)
        }
        onSelectionChange(next)
        return
      }
    }
    const overrideSingle = e.metaKey || e.ctrlKey
    const runMembers = !overrideSingle ? runMembersByIdx.get(idx) : undefined
    if (runMembers && runMembers.length >= 2) {
      const allIn = runMembers.every((i) => selectedIndices.has(i))
      const next = new Set(selectedIndices)
      if (allIn) runMembers.forEach((i) => next.delete(i))
      else runMembers.forEach((i) => next.add(i))
      onSelectionChange(next)
      lastClickedIdxRef.current = idx
      return
    }
    const next = new Set(selectedIndices)
    if (next.has(idx)) next.delete(idx)
    else next.add(idx)
    onSelectionChange(next)
    lastClickedIdxRef.current = idx
  }

  // dnd
  function handleDragStart(e: React.DragEvent, idx: number): void {
    setDragIndex(idx)
    // 多选拖拽：拖动的卡片若在选区里且选区 > 1，整组一起搬；
    // 否则若在"链接组 run"中（≥2 段），把整个 run 一起搬（默认按组拖拽）；
    // 都不满足才单段搬。
    const inMulti = selectedIndices.has(idx) && selectedIndices.size > 1
    let set: Set<number>
    if (inMulti) {
      set = new Set(selectedIndices)
    } else {
      const runMembers = runMembersByIdx.get(idx)
      if (runMembers && runMembers.length >= 2) {
        set = new Set(runMembers)
      } else {
        set = new Set([idx])
      }
    }
    setDraggedSet(set)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', String(idx))

    if (set.size > 1) {
      // 自定义拖拽缩略：N 个色块叠成一摞
      const ghost = document.createElement('div')
      ghost.className = 'timeline-drag-ghost'
      ghost.textContent = `× ${set.size}`
      ghost.style.position = 'absolute'
      ghost.style.top = '-1000px'
      ghost.style.left = '-1000px'
      document.body.appendChild(ghost)
      e.dataTransfer.setDragImage(ghost, 24, 24)
      window.setTimeout(() => ghost.remove(), 0)
    }
  }
  function handleDragOver(e: React.DragEvent, idx: number): void {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const el = e.currentTarget as HTMLElement
    const rect = el.getBoundingClientRect()
    const side: 'before' | 'after' = e.clientX < rect.left + rect.width / 2 ? 'before' : 'after'
    if (overTarget?.idx !== idx || overTarget?.side !== side) {
      setOverTarget({ idx, side })
    }
  }
  /** 拖到时间线尾部空白处：插入到末尾 */
  function handleTrackDragOver(e: React.DragEvent): void {
    if (dragIndex == null) return
    // 命中卡片本身时由卡片的 onDragOver 处理；只在卡片之外的空白触发
    const target = e.target as HTMLElement
    if (target.closest('.timeline-clip')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const tail = { idx: clips.length, side: 'before' as const }
    if (overTarget?.idx !== tail.idx) setOverTarget(tail)
  }
  function handleTrackDrop(e: React.DragEvent): void {
    if (dragIndex == null) return
    const target = e.target as HTMLElement
    if (target.closest('.timeline-clip')) return
    e.preventDefault()
    finishDrop(clips.length, 'before')
  }

  function finishDrop(targetIdx: number, side: 'before' | 'after'): void {
    const set = draggedSet
    setDragIndex(null)
    setOverTarget(null)
    setDraggedSet(null)
    if (!set || set.size === 0) return

    const sorted = [...set].sort((a, b) => a - b)
    // targetIdx 可能 = clips.length（拖到末尾）
    const insertAt = Math.min(clips.length, Math.max(0, targetIdx + (side === 'after' ? 1 : 0)))

    // 单段拖到原位置（前/后边界都没变）→ 跳过
    if (sorted.length === 1) {
      const i = sorted[0]
      if (insertAt === i || insertAt === i + 1) return
    }

    const ids = clips.map((c) => c.id)
    const draggedIds = sorted.map((i) => ids[i])
    const remaining: string[] = []
    ids.forEach((id, i) => {
      if (!set.has(i)) remaining.push(id)
    })
    let newInsert = 0
    for (let i = 0; i < insertAt; i++) {
      if (!set.has(i)) newInsert++
    }
    remaining.splice(newInsert, 0, ...draggedIds)
    const nextSelection = new Set<number>()
    for (let k = 0; k < draggedIds.length; k++) nextSelection.add(newInsert + k)
    onReorder(remaining, nextSelection)
    lastClickedIdxRef.current = newInsert
  }
  function handleDrop(e: React.DragEvent, targetIdx: number): void {
    e.preventDefault()
    const tgt = overTarget
    finishDrop(targetIdx, tgt && tgt.idx === targetIdx ? tgt.side : 'before')
  }

  // 鸟瞰拖动定位
  const draggingMiniRef = useRef(false)
  function handleMiniMouseDown(e: React.MouseEvent<HTMLDivElement>): void {
    const mini = e.currentTarget
    const rect = mini.getBoundingClientRect()
    const moveTo = (clientX: number): void => {
      const el = trackRef.current
      if (!el || totalW === 0) return
      const ratio = clamp((clientX - rect.left) / rect.width, 0, 1)
      const targetScroll = ratio * totalW - el.clientWidth / 2
      el.scrollLeft = clamp(targetScroll, 0, Math.max(0, totalW - el.clientWidth))
    }
    moveTo(e.clientX)
    draggingMiniRef.current = true
    const onMove = (ev: MouseEvent): void => {
      if (!draggingMiniRef.current) return
      moveTo(ev.clientX)
    }
    const onUp = (): void => {
      draggingMiniRef.current = false
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // 鸟瞰各段位置（按时长比例），并标出选中段
  const miniSegs = useMemo(() => {
    let cursor = 0
    return clips.map((c, idx) => {
      const dur = effectiveDurs[idx] ?? c.durationSec
      const startRatio = totalDur > 0 ? cursor / totalDur : 0
      const endRatio = totalDur > 0 ? (cursor + dur) / totalDur : 0
      cursor += dur
      return {
        id: c.id + '@' + idx,
        startRatio,
        endRatio,
        color: importColors.get(c.importId) ?? '#666',
        index: idx,
        selected: selectedIndices.has(idx)
      }
    })
  }, [clips, totalDur, importColors, effectiveDurs, selectedIndices])

  const miniViewport =
    totalW > 0
      ? {
          left: (scrollLeft / totalW) * 100,
          width: Math.min(100, (viewportW / totalW) * 100)
        }
      : { left: 0, width: 100 }

  const overflowing = totalW > viewportW

  function selectAll(): void {
    const all = new Set<number>()
    for (let i = 0; i < clips.length; i++) all.add(i)
    onSelectionChange(all)
  }
  function clearSelection(): void {
    onSelectionChange(new Set())
  }
  function bulkRemove(): void {
    if (selectedIndices.size === 0) return
    onBulkRemove(selectedIndices)
  }

  return (
    <div className="timeline-strip">
      <div className="timeline-strip-head">
        <strong>时间线</strong>
        <span className="timeline-strip-meta">
          {clips.length} 段 · {totalDur.toFixed(1)}s
        </span>
        {clips.length > 0 && (
          <span className="timeline-strip-tip">
            点击选中 · <kbd>Shift</kbd>+点击 区间 · 拖拽整组移动 · <kbd>⌫</kbd> 删除 ·{' '}
            <kbd>Esc</kbd> 取消
          </span>
        )}
        <div className="timeline-strip-bulk">
          {selectedIndices.size === 0 && clips.length > 0 && (
            <button type="button" className="ghost-btn xs" onClick={selectAll}>
              全选
            </button>
          )}
          {selectedIndices.size > 0 && (
            <>
              <span className="timeline-strip-bulk-stat">
                已选 <strong>{selectedIndices.size}</strong>
              </span>
              <button type="button" className="ghost-btn xs" onClick={clearSelection}>
                取消
              </button>
              <button type="button" className="danger-btn xs" onClick={bulkRemove}>
                删除
              </button>
            </>
          )}
        </div>
      </div>

      {/* 鸟瞰导航条：超过容器时才显示（不滚动时没必要） */}
      {clips.length > 0 && overflowing && (
        <div className="timeline-minimap" onMouseDown={handleMiniMouseDown} title="拖动定位">
          {miniSegs.map((s) => (
            <div
              key={s.id}
              className={`timeline-minimap-seg ${s.selected ? 'selected' : ''}`}
              style={{
                left: `${s.startRatio * 100}%`,
                width: `${(s.endRatio - s.startRatio) * 100}%`,
                background: s.color
              }}
            />
          ))}
          <div
            className="timeline-minimap-viewport"
            style={{ left: `${miniViewport.left}%`, width: `${miniViewport.width}%` }}
          />
        </div>
      )}

      <div
        className="timeline-strip-track"
        ref={trackRef}
        onDragOver={handleTrackDragOver}
        onDrop={handleTrackDrop}
        onDragEnd={() => {
          setDragIndex(null)
          setOverTarget(null)
          setDraggedSet(null)
        }}
      >
        {clips.length === 0 ? (
          <div className="timeline-strip-empty">还没有片段</div>
        ) : (
          <>
            {(() => {
              const nodes: React.ReactNode[] = []
              let curRun: LinkedRun | null = null
              let curRunChildren: React.ReactNode[] = []
              const flushRun = (): void => {
                if (!curRun) return
                const r = curRun
                const color = importColors.get(clips[r.startIdx].importId) ?? '#666'
                let totalSec = 0
                for (let i = r.startIdx; i <= r.endIdx; i++) {
                  totalSec += effectiveDurs[i] ?? clips[i].durationSec
                }
                const allSelected = (() => {
                  for (let i = r.startIdx; i <= r.endIdx; i++) {
                    if (!selectedIndices.has(i)) return false
                  }
                  return true
                })()
                const someSelected = (() => {
                  for (let i = r.startIdx; i <= r.endIdx; i++) {
                    if (selectedIndices.has(i)) return true
                  }
                  return false
                })()
                nodes.push(
                  <div
                    key={`run-${r.startIdx}-${r.group.id}`}
                    className={`timeline-group-run ${
                      allSelected ? 'all-selected' : someSelected ? 'some-selected' : ''
                    }`}
                    style={{ ['--run-color' as string]: color } as React.CSSProperties}
                  >
                    <div
                      className="timeline-group-run-label"
                      title="链接组：点击任一片段会整组联选；拖动也会整组移动（按住 Cmd/Ctrl 可只选一段）"
                    >
                      <span className="timeline-group-run-bullet" style={{ background: color }} />
                      <span className="timeline-group-run-name">{r.group.name}</span>
                      <span className="timeline-group-run-stat">
                        {r.endIdx - r.startIdx + 1} 段 · {totalSec.toFixed(1)}s
                      </span>
                    </div>
                    <div className="timeline-group-run-row">{curRunChildren}</div>
                  </div>
                )
                curRunChildren = []
                curRun = null
              }
              for (let idx = 0; idx < clips.length; idx++) {
                const c = clips[idx]
                const myRun = linkedRuns.find((r) => idx >= r.startIdx && idx <= r.endIdx) ?? null
                if (myRun !== curRun) {
                  flushRun()
                  curRun = myRun
                }
                const isFirstInRun = myRun ? idx === myRun.startIdx : false
                const isLastInRun = myRun ? idx === myRun.endIdx : false
                const node = (
                  <ClipBlock
                    key={c.id + '@' + idx}
                    clip={c}
                    color={importColors.get(c.importId) ?? '#666'}
                    index={idx}
                    effectiveDur={effectiveDurs[idx] ?? c.durationSec}
                    trimmed={
                      !!overrides?.[idx] &&
                      Math.abs((effectiveDurs[idx] ?? c.durationSec) - c.durationSec) > 0.02
                    }
                    selected={selectedIndices.has(idx)}
                    dragging={dragIndex === idx}
                    draggingMember={!!draggedSet && draggedSet.has(idx) && idx !== dragIndex}
                    overSide={
                      overTarget?.idx === idx && dragIndex !== null && !draggedSet?.has(idx)
                        ? overTarget.side
                        : null
                    }
                    inRun={!!myRun}
                    runFirst={isFirstInRun}
                    runLast={isLastInRun}
                    onClick={(e) => handleClipClick(idx, e)}
                    onDragStart={(e) => handleDragStart(e, idx)}
                    onDragOver={(e) => handleDragOver(e, idx)}
                    onDrop={(e) => handleDrop(e, idx)}
                    onRemove={() => onBulkRemove(new Set([idx]))}
                  />
                )
                if (myRun) curRunChildren.push(node)
                else nodes.push(node)
              }
              flushRun()
              return nodes
            })()}
            {/* 末尾占位：拖到尾部空白时显示插入指示线 */}
            {dragIndex !== null && (
              <div
                className={`timeline-tail-zone ${overTarget?.idx === clips.length ? 'over' : ''}`}
                aria-hidden
              >
                {overTarget?.idx === clips.length ? '插到末尾' : '拖到此处加到末尾'}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

type BlockProps = {
  clip: ClipMeta
  color: string
  index: number
  effectiveDur: number
  trimmed: boolean
  selected: boolean
  dragging: boolean
  draggingMember: boolean
  overSide: 'before' | 'after' | null
  /** 在"链接组 run"中（与相邻同组连续片段联动） */
  inRun: boolean
  runFirst: boolean
  runLast: boolean
  onClick: (e: React.MouseEvent) => void
  onDragStart: (e: React.DragEvent) => void
  onDragOver: (e: React.DragEvent) => void
  onDrop: (e: React.DragEvent) => void
  onRemove: () => void
}

function ClipBlock({
  clip,
  color,
  index,
  effectiveDur,
  trimmed,
  selected,
  dragging,
  draggingMember,
  overSide,
  inRun,
  runFirst,
  runLast,
  onClick,
  onDragStart,
  onDragOver,
  onDrop,
  onRemove
}: BlockProps) {
  const [thumb, setThumb] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    window.scissor.library.readAsBase64(clip.thumbRel).then((r) => {
      if (cancelled) return
      if (r.ok && r.base64) setThumb(`data:${r.mime};base64,${r.base64}`)
    })
    return () => {
      cancelled = true
    }
  }, [clip.thumbRel])

  const runCls = inRun ? `in-run ${runFirst ? 'run-first' : ''} ${runLast ? 'run-last' : ''}` : ''
  return (
    <div
      className={`timeline-clip ${selected ? 'selected' : ''} ${dragging ? 'dragging' : ''} ${
        draggingMember ? 'dragging-member' : ''
      } ${overSide ? `over over-${overSide}` : ''} ${trimmed ? 'trimmed' : ''} ${runCls}`}
      draggable
      onClick={onClick}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      title={
        trimmed
          ? `#${index + 1} · 已裁剪到 ${effectiveDur.toFixed(2)}s（原 ${clip.durationSec.toFixed(2)}s）`
          : `#${index + 1} · ${clip.durationSec.toFixed(2)}s`
      }
    >
      <div className="timeline-clip-thumb">
        {thumb ? <img src={thumb} alt="" draggable={false} /> : null}
        <div className="timeline-clip-source" style={{ background: color }}>
          #{clip.index + 1}
        </div>
        {trimmed && <span className="timeline-clip-trim">✂</span>}
        {selected && <span className="timeline-clip-check">✓</span>}
        <button
          type="button"
          className="timeline-clip-x"
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
        >
          ×
        </button>
      </div>
      <div className="timeline-clip-foot">
        <span>{(index + 1).toString().padStart(2, '0')}</span>
        <span>
          {effectiveDur.toFixed(1)}s
          {trimmed && (
            <span className="timeline-clip-foot-trim"> ⁄{clip.durationSec.toFixed(1)}s</span>
          )}
        </span>
      </div>
    </div>
  )
}
