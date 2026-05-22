import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ClipMeta } from '../../../../shared/library'

type Props = {
  clips: ClipMeta[]
  importColors: Map<string, string>
  onReorder: (newIds: string[]) => void
  onRemove: (id: string) => void
}

const CLIP_WIDTH = 108 // 竖屏 9:16 卡片固定宽度
const CLIP_GAP = 4

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

export function TimelineStrip({ clips, importColors, onReorder, onRemove }: Props) {
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [overIndex, setOverIndex] = useState<number | null>(null)
  const [scrollLeft, setScrollLeft] = useState(0)
  const [viewportW, setViewportW] = useState(0)
  const trackRef = useRef<HTMLDivElement>(null)

  const totalDur = useMemo(() => clips.reduce((a, c) => a + c.durationSec, 0), [clips])
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

  // dnd
  function handleDragStart(e: React.DragEvent, idx: number): void {
    setDragIndex(idx)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', String(idx))
  }
  function handleDragOver(e: React.DragEvent, idx: number): void {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (overIndex !== idx) setOverIndex(idx)
  }
  function handleDrop(e: React.DragEvent, targetIdx: number): void {
    e.preventDefault()
    if (dragIndex === null || dragIndex === targetIdx) {
      setDragIndex(null)
      setOverIndex(null)
      return
    }
    const ids = clips.map((c) => c.id)
    const [moved] = ids.splice(dragIndex, 1)
    ids.splice(targetIdx, 0, moved)
    onReorder(ids)
    setDragIndex(null)
    setOverIndex(null)
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

  // 鸟瞰各段位置（按时长比例）
  const miniSegs = useMemo(() => {
    let cursor = 0
    return clips.map((c, idx) => {
      const startRatio = totalDur > 0 ? cursor / totalDur : 0
      const endRatio = totalDur > 0 ? (cursor + c.durationSec) / totalDur : 0
      cursor += c.durationSec
      return {
        id: c.id,
        startRatio,
        endRatio,
        color: importColors.get(c.importId) ?? '#666',
        index: idx
      }
    })
  }, [clips, totalDur, importColors])

  const miniViewport =
    totalW > 0
      ? {
          left: (scrollLeft / totalW) * 100,
          width: Math.min(100, (viewportW / totalW) * 100)
        }
      : { left: 0, width: 100 }

  const overflowing = totalW > viewportW

  return (
    <div className="timeline-strip">
      <div className="timeline-strip-head">
        <strong>时间线</strong>
        <span className="timeline-strip-meta">
          {clips.length} 段 · {totalDur.toFixed(1)}s
        </span>
      </div>

      {/* 鸟瞰导航条：超过容器时才显示（不滚动时没必要） */}
      {clips.length > 0 && overflowing && (
        <div className="timeline-minimap" onMouseDown={handleMiniMouseDown} title="拖动定位">
          {miniSegs.map((s) => (
            <div
              key={s.id}
              className="timeline-minimap-seg"
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
        onDragEnd={() => {
          setDragIndex(null)
          setOverIndex(null)
        }}
      >
        {clips.length === 0 ? (
          <div className="timeline-strip-empty">还没有片段</div>
        ) : (
          clips.map((c, idx) => (
            <ClipBlock
              key={c.id}
              clip={c}
              color={importColors.get(c.importId) ?? '#666'}
              index={idx}
              dragging={dragIndex === idx}
              over={overIndex === idx && dragIndex !== null && dragIndex !== idx}
              onDragStart={(e) => handleDragStart(e, idx)}
              onDragOver={(e) => handleDragOver(e, idx)}
              onDrop={(e) => handleDrop(e, idx)}
              onRemove={() => onRemove(c.id)}
            />
          ))
        )}
      </div>
    </div>
  )
}

type BlockProps = {
  clip: ClipMeta
  color: string
  index: number
  dragging: boolean
  over: boolean
  onDragStart: (e: React.DragEvent) => void
  onDragOver: (e: React.DragEvent) => void
  onDrop: (e: React.DragEvent) => void
  onRemove: () => void
}

function ClipBlock({
  clip,
  color,
  index,
  dragging,
  over,
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

  return (
    <div
      className={`timeline-clip ${dragging ? 'dragging' : ''} ${over ? 'over' : ''}`}
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      title={`#${index + 1} · ${clip.durationSec.toFixed(2)}s`}
    >
      <div className="timeline-clip-thumb">
        {thumb ? <img src={thumb} alt="" draggable={false} /> : null}
        <div className="timeline-clip-source" style={{ background: color }}>
          #{clip.index + 1}
        </div>
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
        <span>{clip.durationSec.toFixed(1)}s</span>
      </div>
    </div>
  )
}
