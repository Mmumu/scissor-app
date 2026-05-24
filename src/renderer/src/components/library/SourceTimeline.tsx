import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ClipMeta } from '../../../../shared/library'
import { clipSourceSpanSec } from '../../utils/sourceClipTime'

/** 每段在时间轴上的最小宽度（px），避免 30+ 段挤成一团 */
const MIN_CLIP_PX = 52
/** 基准时间缩放：1 秒对应多少像素 */
const BASE_PX_PER_SEC = 18

type Props = {
  clips: ClipMeta[] // 必须按 sourceStartSec 升序传入
  /** 源视频总时长（秒）。可由 clips 末段推断，但播放器拿到的更准 */
  durationSec: number
  /** 当前播放头位置（秒） */
  playheadSec: number
  /** 选中的 clip id 集合（受控）；用于在时间轴上高亮 */
  selectedClipIds: ReadonlySet<string>
  /** 当前播放头所在段（与选中无关） */
  playingClipId?: string | null
  /**
   * 拖选完成后给出"选中 clip ids"。组件内部只负责圈选，落到哪个 clip 由 props.clips 决定。
   * 拖选规则：与该选区有任意时间重叠的 clip 全部纳入。
   */
  onRangeSelect: (clipIds: string[]) => void
  /** 单点 clip 切换（缩略图条不在这里，但点击 timeline 上的 clip 块也能切换） */
  onToggleClip: (clipId: string) => void
  /** 用户点击时间轴空白处定位：seek 到该秒 */
  onSeek: (sec: number) => void
  /** 给每段配一个颜色（来自 import 调色板） */
  importColor: string
}

export function SourceTimeline({
  clips,
  durationSec,
  playheadSec,
  selectedClipIds,
  playingClipId = null,
  onRangeSelect,
  onToggleClip,
  onSeek,
  importColor
}: Props) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const trackRef = useRef<HTMLDivElement | null>(null)
  const [viewportW, setViewportW] = useState(0)
  const [hoverSec, setHoverSec] = useState<number | null>(null)
  const [drag, setDrag] = useState<{
    anchorSec: number
    cursorSec: number
    startClientX: number
    confirmed: boolean
  } | null>(null)

  const safeDur = Math.max(0.01, durationSec)

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setViewportW(el.clientWidth))
    ro.observe(el)
    setViewportW(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  const minClipDur = useMemo(() => {
    if (clips.length === 0) return 1
    return Math.min(...clips.map((c) => clipSourceSpanSec(c)))
  }, [clips])

  const pxPerSec = useMemo(() => {
    // 全局放大 pxPerSec，让最短段至少 MIN_CLIP_PX 宽；各段宽高仍严格按时长比例，保证播放头对齐
    const needForMin = MIN_CLIP_PX / minClipDur
    return Math.max(BASE_PX_PER_SEC, needForMin)
  }, [minClipDur])

  const trackWidthPx = useMemo(
    () => Math.max(viewportW || 0, safeDur * pxPerSec),
    [viewportW, safeDur, pxPerSec]
  )

  /** 秒 → 轨道像素（线性，与视频 currentTime 一一对应） */
  const sec2px = useCallback((sec: number) => sec * pxPerSec, [pxPerSec])

  const clientXToSec = useCallback(
    (clientX: number): number => {
      const scroll = scrollRef.current
      const track = trackRef.current
      if (!scroll || !track || trackWidthPx <= 0) return 0
      const scrollRect = scroll.getBoundingClientRect()
      const xInTrack = clientX - scrollRect.left + scroll.scrollLeft
      return Math.max(0, Math.min(safeDur, xInTrack / pxPerSec))
    },
    [pxPerSec, safeDur]
  )

  /** 把任意 sec 吸附到最近的 clip 边界（含 0 和 dur） */
  const boundaries = useMemo(() => {
    const set = new Set<number>([0, safeDur])
    for (const c of clips) {
      set.add(Math.max(0, c.sourceStartSec))
      set.add(Math.min(safeDur, c.sourceEndSec))
    }
    return Array.from(set).sort((a, b) => a - b)
  }, [clips, safeDur])

  function snap(sec: number): number {
    if (boundaries.length === 0) return sec
    let best = boundaries[0]
    let bestD = Math.abs(sec - best)
    for (const b of boundaries) {
      const d = Math.abs(sec - b)
      if (d < bestD) {
        best = b
        bestD = d
      }
    }
    const snapTol = Math.max(0.08, (MIN_CLIP_PX / pxPerSec) * 0.35)
    return bestD <= snapTol ? best : sec
  }

  // 播放头变化时，尽量滚进可视区
  useEffect(() => {
    const scroll = scrollRef.current
    if (!scroll || trackWidthPx <= 0) return
    const headPx = sec2px(playheadSec)
    const left = scroll.scrollLeft
    const right = left + scroll.clientWidth
    const margin = 48
    if (headPx < left + margin) {
      scroll.scrollLeft = Math.max(0, headPx - margin)
    } else if (headPx > right - margin) {
      scroll.scrollLeft = headPx - scroll.clientWidth + margin
    }
  }, [playheadSec, sec2px, trackWidthPx])

  // 竖向滚轮 → 横向滚动
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      if (e.deltaX === 0 && Math.abs(e.deltaY) > 0) {
        el.scrollLeft += e.deltaY
        e.preventDefault()
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if ((e.target as HTMLElement).closest('button, .source-timeline-clip-btn')) return
      e.preventDefault()
      ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
      const sec = clientXToSec(e.clientX)
      setDrag({ anchorSec: sec, cursorSec: sec, startClientX: e.clientX, confirmed: false })
    },
    [clientXToSec]
  )

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const sec = clientXToSec(e.clientX)
      setHoverSec(sec)
      setDrag((prev) => {
        if (!prev) return prev
        const movedPx = Math.abs(e.clientX - prev.startClientX)
        const confirmed = prev.confirmed || movedPx > 4
        return { ...prev, cursorSec: sec, confirmed }
      })
    },
    [clientXToSec]
  )

  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      ;(e.target as HTMLElement).releasePointerCapture?.(e.pointerId)
      setDrag((prev) => {
        if (!prev) return null
        if (!prev.confirmed) {
          onSeek(prev.cursorSec)
          return null
        }
        const a = snap(Math.min(prev.anchorSec, prev.cursorSec))
        const b = snap(Math.max(prev.anchorSec, prev.cursorSec))
        const lo = Math.max(0, Math.min(a, b))
        const hi = Math.min(safeDur, Math.max(a, b))
        const hits = clips.filter((c) => c.sourceEndSec > lo && c.sourceStartSec < hi)
        onRangeSelect(hits.map((c) => c.id))
        return null
      })
    },
    [clips, onRangeSelect, onSeek, safeDur]
  )

  const dragRange =
    drag && drag.confirmed
      ? {
          lo: snap(Math.min(drag.anchorSec, drag.cursorSec)),
          hi: snap(Math.max(drag.anchorSec, drag.cursorSec))
        }
      : null

  const canScroll = trackWidthPx > (viewportW || 0) + 1

  return (
    <div className="source-timeline-wrap">
      {canScroll && (
        <div className="source-timeline-scroll-hint">← 左右滑动查看 {clips.length} 段 →</div>
      )}
      <div className="source-timeline-scroll" ref={scrollRef}>
        <div
          className="source-timeline"
          ref={trackRef}
          style={{ width: `${trackWidthPx}px` }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerLeave={() => setHoverSec(null)}
          title="拖动选区 / 点击定位"
        >
          {clips.map((c, i) => {
            const leftPx = sec2px(c.sourceStartSec)
            const widthPx = sec2px(clipSourceSpanSec(c))
            const sel = selectedClipIds.has(c.id)
            const playing = playingClipId === c.id
            const showNo = widthPx >= 22
            return (
              <div
                key={c.id}
                className={`source-timeline-clip ${playing ? 'playing' : ''} ${sel ? 'selected' : ''}`}
                style={{
                  left: `${leftPx}px`,
                  width: `${widthPx}px`,
                  background: importColor,
                  opacity: sel ? 0.95 : 0.55
                }}
                title={`#${i + 1}  ${c.sourceStartSec.toFixed(2)}s → ${c.sourceEndSec.toFixed(2)}s`}
              >
                {showNo && <span className="source-timeline-clip-no">#{i + 1}</span>}
                {widthPx >= 18 && (
                  <button
                    type="button"
                    className="source-timeline-clip-btn"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation()
                      onToggleClip(c.id)
                    }}
                    title={sel ? '取消选中' : '加入选中'}
                  >
                    {sel ? '−' : '+'}
                  </button>
                )}
              </div>
            )
          })}

          {dragRange && (
            <div
              className="source-timeline-range"
              style={{
                left: `${sec2px(dragRange.lo)}px`,
                width: `${sec2px(dragRange.hi - dragRange.lo)}px`
              }}
            />
          )}

          <div
            className="source-timeline-playhead"
            style={{ left: `${sec2px(playheadSec)}px` }}
          />

          {hoverSec != null && !drag && (
            <div
              className="source-timeline-hover-tip"
              style={{ left: `${sec2px(hoverSec)}px` }}
            >
              {fmtTime(hoverSec)}
            </div>
          )}
        </div>
      </div>
      <div className="source-timeline-axis">
        <span>0:00</span>
        <span>{fmtTime(safeDur / 2)}</span>
        <span>{fmtTime(safeDur)}</span>
      </div>
    </div>
  )
}

function fmtTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0
  const m = Math.floor(sec / 60)
  const s = sec - m * 60
  return `${m}:${s.toFixed(1).padStart(4, '0')}`
}

export { fmtTime as formatTimecode }
