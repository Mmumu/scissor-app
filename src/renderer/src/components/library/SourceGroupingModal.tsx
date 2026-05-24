import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ClipMeta, ImportRecord, LibraryIndex } from '../../../../shared/library'
import { evaluateGrouping } from '../../utils/clipGroups'
import {
  alignClipSourceTimes,
  findClipAtSourceTime,
  sourceTimelineDuration
} from '../../utils/sourceClipTime'
import { SourceTimeline, formatTimecode } from './SourceTimeline'
import { ClipCard } from './ClipCard'

type Props = {
  index: LibraryIndex
  importRec: ImportRecord
  importColor: string
  onClose: () => void
  onCreated: () => void // 父级在成功后用来 reload index
}

export function SourceGroupingModal({
  index,
  importRec,
  importColor,
  onClose,
  onCreated
}: Props) {
  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  const [sourceMissing, setSourceMissing] = useState(false)
  const [sourcePath, setSourcePath] = useState<string>('')
  const [playhead, setPlayhead] = useState(0)
  const [vidDur, setVidDur] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [groupName, setGroupName] = useState('')
  const [groupDescription, setGroupDescription] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [toast, setToast] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const lastThumbClickRef = useRef<number | null>(null)

  // 按源时间排序；若入库边界脱节则按 duration 链式对齐，保证时间轴与播放器 currentTime 一致
  const clips = useMemo<ClipMeta[]>(() => {
    const map = new Map(index.clips.map((c) => [c.id, c]))
    const raw = importRec.clipIds.map((id) => map.get(id)).filter(Boolean) as ClipMeta[]
    return alignClipSourceTimes(raw)
  }, [importRec.clipIds, index.clips])

  const timelineDur = useMemo(
    () => sourceTimelineDuration(clips, vidDur),
    [clips, vidDur]
  )

  const playingAt = useMemo(
    () => findClipAtSourceTime(clips, playhead),
    [clips, playhead]
  )

  // 加载原视频 URL
  useEffect(() => {
    let cancelled = false
    const api = window.scissor?.library?.getSourceVideoUrl
    if (typeof api !== 'function') {
      setSourceMissing(true)
      return
    }
    api(importRec.id).then((r) => {
      if (cancelled) return
      if (!r.ok) {
        setSourceMissing(true)
        return
      }
      setSourcePath(r.sourcePath)
      if (!r.exists) {
        setSourceMissing(true)
        return
      }
      setVideoUrl(r.url)
    })
    return () => {
      cancelled = true
    }
  }, [importRec.id])

  // 元数据就绪后同步时长兜底
  useEffect(() => {
    const last = clips[clips.length - 1]
    if (last && (!vidDur || vidDur < 0.01)) setVidDur(last.sourceEndSec)
  }, [clips, vidDur])

  // 同步 video → playhead（timeupdate + seeked，避免仅依赖低频 timeupdate）
  useEffect(() => {
    const el = videoRef.current
    if (!el) return
    const syncTime = (): void => setPlayhead(el.currentTime || 0)
    const onPlay = (): void => setPlaying(true)
    const onPause = (): void => setPlaying(false)
    const onMeta = (): void => {
      if (el.duration && isFinite(el.duration)) setVidDur(el.duration)
      syncTime()
    }
    el.addEventListener('timeupdate', syncTime)
    el.addEventListener('seeked', syncTime)
    el.addEventListener('play', onPlay)
    el.addEventListener('pause', onPause)
    el.addEventListener('loadedmetadata', onMeta)
    return () => {
      el.removeEventListener('timeupdate', syncTime)
      el.removeEventListener('seeked', syncTime)
      el.removeEventListener('play', onPlay)
      el.removeEventListener('pause', onPause)
      el.removeEventListener('loadedmetadata', onMeta)
    }
  }, [videoUrl])

  // 选区评估（沿用现有规则：必须 ≥2、同 import、连续）
  const groupingEval = useMemo(() => evaluateGrouping(index, selected), [index, selected])

  /** 选区是否覆盖 clip 的 sourceTime → 把它纳入 selected */
  const handleRangeSelect = useCallback(
    (ids: string[]) => {
      if (ids.length === 0) return
      setSelected(new Set(ids))
    },
    []
  )

  const handleToggleClip = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const handleSeek = useCallback(
    (sec: number) => {
      const cap = timelineDur || vidDur || sec
      const t = Math.max(0, Math.min(sec, cap))
      const el = videoRef.current
      if (el) {
        try {
          el.currentTime = t
          setPlayhead(el.currentTime)
        } catch {
          setPlayhead(t)
        }
      } else {
        setPlayhead(t)
      }
    },
    [timelineDur, vidDur]
  )

  function nearestBoundary(sec: number, side: 'lo' | 'hi'): number {
    if (clips.length === 0) return sec
    if (side === 'lo') {
      // 找比 sec 大的最小 startSec；若 sec 已经在某 clip 中，取该 clip 的 startSec
      const inside = clips.find((c) => c.sourceStartSec <= sec && sec < c.sourceEndSec)
      if (inside) return inside.sourceStartSec
      const after = clips.find((c) => c.sourceStartSec >= sec)
      return after ? after.sourceStartSec : (clips[clips.length - 1]?.sourceStartSec ?? sec)
    } else {
      const inside = clips.find((c) => c.sourceStartSec <= sec && sec < c.sourceEndSec)
      if (inside) return inside.sourceEndSec
      // 找比 sec 小的最大 endSec
      let best = clips[0]?.sourceEndSec ?? sec
      for (const c of clips) if (c.sourceEndSec <= sec) best = c.sourceEndSec
      return best
    }
  }
  // 标记当前播放头为入点 / 出点（吸附 clip 边界）
  const inPointRef = useRef<number | null>(null)
  function markIn(): void {
    inPointRef.current = nearestBoundary(playhead, 'lo')
    setToast({ kind: 'ok', text: `入点 = ${formatTimecode(inPointRef.current)}` })
    window.setTimeout(() => setToast(null), 1500)
  }
  function markOut(): void {
    if (inPointRef.current == null) {
      setToast({ kind: 'err', text: '请先按 [ 标入点' })
      window.setTimeout(() => setToast(null), 1800)
      return
    }
    const out = nearestBoundary(playhead, 'hi')
    const lo = Math.min(inPointRef.current, out)
    const hi = Math.max(inPointRef.current, out)
    const hits = clips.filter((c) => c.sourceEndSec > lo && c.sourceStartSec < hi)
    setSelected(new Set(hits.map((c) => c.id)))
    setToast({
      kind: 'ok',
      text: `选区 ${formatTimecode(lo)} → ${formatTimecode(hi)}（${hits.length} 段）`
    })
    inPointRef.current = null
    window.setTimeout(() => setToast(null), 1800)
  }

  // 键盘：space 播放/暂停；[ ] 入点/出点；Esc 关闭
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.code === 'Space') {
        e.preventDefault()
        const v = videoRef.current
        if (v) {
          if (v.paused) v.play().catch(() => undefined)
          else v.pause()
        }
        return
      }
      if (e.code === 'BracketLeft') {
        e.preventDefault()
        markIn()
        return
      }
      if (e.code === 'BracketRight') {
        e.preventDefault()
        markOut()
        return
      }
      if (e.code === 'Escape') {
        e.preventDefault()
        if (selected.size > 0) setSelected(new Set())
        else onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playhead, selected.size, onClose, clips])

  async function handleSubmit(): Promise<void> {
    if (!groupingEval.canGroup || !groupingEval.importId || !groupingEval.orderedIds) return
    const api = window.scissor?.library?.createGroup
    if (typeof api !== 'function') {
      alert('成组接口未加载，请重启 pnpm run dev')
      return
    }
    setSubmitting(true)
    try {
      const r = await api({
        importId: groupingEval.importId,
        clipIds: groupingEval.orderedIds,
        name: groupName.trim() || undefined,
        description: groupDescription.trim() || undefined
      })
      if (!r.ok) {
        setToast({ kind: 'err', text: '成组失败：' + (r as { error?: string }).error })
        return
      }
      onCreated()
      // 不关闭，允许接着选下一组
      setSelected(new Set())
      setGroupName('')
      setGroupDescription('')
      setToast({ kind: 'ok', text: `已成组「${r.group.name}」（${r.group.clipIds.length} 段）` })
      window.setTimeout(() => setToast(null), 2200)
    } catch (e) {
      setToast({ kind: 'err', text: '成组失败：' + (e instanceof Error ? e.message : String(e)) })
    } finally {
      setSubmitting(false)
    }
  }

  const totalSec = useMemo(() => {
    let t = 0
    for (const c of clips) if (selected.has(c.id)) t += c.sourceEndSec - c.sourceStartSec
    return t
  }, [clips, selected])

  const selectedIndexLabels = useMemo(() => {
    const labels: string[] = []
    clips.forEach((c, i) => {
      if (selected.has(c.id)) labels.push('#' + (i + 1))
    })
    return labels
  }, [clips, selected])

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="source-grouping-modal" onClick={(e) => e.stopPropagation()}>
        <div className="source-grouping-head">
          <button type="button" className="ghost-btn" onClick={onClose}>
            ← 返回
          </button>
          <h2>对照原视频成组：{basename(importRec.sourcePath)}</h2>
          <div className="source-grouping-meta">
            {clips.length} 段 · {fmtDur(timelineDur)}
            {playingAt && (
              <span className="source-grouping-playing">
                · 正在播放 #{playingAt.index + 1}
              </span>
            )}
          </div>
          <button type="button" className="ghost-btn" onClick={onClose}>
            ✕
          </button>
        </div>

        {sourceMissing ? (
          <div className="source-grouping-warn">
            ⚠ 原视频文件已被移动或删除（路径：<code>{sourcePath || importRec.sourcePath}</code>）。
            可继续用下方缩略图手动选择 / 成组。
          </div>
        ) : null}

        {/* 视频播放器 */}
        <div className="source-grouping-player-wrap">
          {videoUrl ? (
            <video
              ref={videoRef}
              src={videoUrl}
              className="source-grouping-player"
              controls
              playsInline
            />
          ) : sourceMissing ? (
            <div className="source-grouping-player-fallback">📹 原视频不可播放</div>
          ) : (
            <div className="source-grouping-player-fallback">加载中…</div>
          )}
          {playingAt && (
            <div className="source-grouping-now-playing">
              正在播放 <strong>#{playingAt.index + 1}</strong>
              <span className="muted">
                {' '}
                {formatTimecode(playingAt.clip.sourceStartSec)} →{' '}
                {formatTimecode(playingAt.clip.sourceEndSec)}
                {' · '}
                播放头 {formatTimecode(playhead)}
              </span>
            </div>
          )}
          <div className="source-grouping-shortcuts">
            <kbd>Space</kbd> 播放/暂停 ·{' '}
            <kbd>[</kbd> 标入点 · <kbd>]</kbd> 标出点 · <kbd>Esc</kbd> 取消选区/关闭
          </div>
        </div>

        {/* 时间轴 */}
        <SourceTimeline
          clips={clips}
          durationSec={timelineDur}
          playheadSec={playhead}
          selectedClipIds={selected}
          playingClipId={playingAt?.clip.id ?? null}
          importColor={importColor}
          onRangeSelect={handleRangeSelect}
          onToggleClip={handleToggleClip}
          onSeek={handleSeek}
        />

        {/* 缩略图条（点击切换；shift 范围选） */}
        <div className="source-grouping-thumbs">
          {clips.map((c, i) => (
            <ThumbItem
              key={c.id}
              clip={c}
              indexLabel={i + 1}
              importColor={importColor}
              selected={selected.has(c.id)}
              playing={playingAt?.clip.id === c.id}
              onToggle={(e) => handleThumbClick(i, e)}
            />
          ))}
        </div>

        {/* 底部操作栏 */}
        <div className="source-grouping-foot">
          <div className="source-grouping-stat">
            {selected.size === 0 ? (
              <span className="muted">在上方时间轴拖动选区，或点击缩略图选择 1 段及以上连续片段</span>
            ) : (
              <>
                已选 <strong>{selected.size}</strong> 段（
                {selectedIndexLabels.slice(0, 8).join(' ')}
                {selectedIndexLabels.length > 8 ? ' …' : ''}），合计 {totalSec.toFixed(1)}s
              </>
            )}
          </div>
          {!groupingEval.canGroup && selected.size >= 1 && (
            <span className="randomcut-group-hint">⚠ {groupingEval.reason}</span>
          )}
          {groupingEval.canGroup && (
            <span className="randomcut-group-hint ok">
              ✓ 可成 1 组{selected.size === 1 ? '（单段）' : ''}
            </span>
          )}
          <input
            type="text"
            className="source-grouping-name-input"
            placeholder="组名（留空自动 组 A/B/...）"
            value={groupName}
            onChange={(e) => setGroupName(e.target.value)}
            disabled={!groupingEval.canGroup}
            maxLength={32}
          />
          <input
            type="text"
            className="source-grouping-desc-input"
            placeholder="组描述（可选）"
            value={groupDescription}
            onChange={(e) => setGroupDescription(e.target.value)}
            disabled={!groupingEval.canGroup}
            maxLength={200}
          />
          <button
            type="button"
            className="primary-btn"
            disabled={!groupingEval.canGroup || submitting}
            onClick={handleSubmit}
          >
            {submitting ? '保存中…' : '+ 成组并保存'}
          </button>
        </div>

        {toast && (
          <div className={`source-grouping-toast ${toast.kind}`}>{toast.text}</div>
        )}
      </div>
    </div>
  )

  // 缩略图条点击：plain = toggle；shift+click = 范围
  function handleThumbClick(idx: number, e: React.MouseEvent): void {
    const c = clips[idx]
    if (!c) return
    handleSeek(c.sourceStartSec)
    if (e.shiftKey && lastThumbClickRef.current != null) {
      const a = Math.min(lastThumbClickRef.current, idx)
      const b = Math.max(lastThumbClickRef.current, idx)
      setSelected((prev) => {
        const next = new Set(prev)
        for (let i = a; i <= b; i++) next.add(clips[i].id)
        return next
      })
      return
    }
    lastThumbClickRef.current = idx
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(c.id)) next.delete(c.id)
      else next.add(c.id)
      return next
    })
  }
}

function ThumbItem({
  clip,
  indexLabel,
  importColor,
  selected,
  playing,
  onToggle
}: {
  clip: ClipMeta
  indexLabel: number
  importColor: string
  selected: boolean
  playing: boolean
  onToggle: (e: React.MouseEvent) => void
}) {
  return (
    <div
      className={`source-grouping-thumb-wrap ${playing ? 'is-playing' : ''}`}
      onClick={onToggle}
    >
      <ClipCard
        clip={clip}
        importColor={importColor}
        selected={selected}
      />
      <div className="source-grouping-thumb-label">
        #{indexLabel} · {(clip.sourceEndSec - clip.sourceStartSec).toFixed(1)}s
      </div>
    </div>
  )
}

function basename(p: string): string {
  return p.split(/[/\\]/).pop() ?? p
}
function fmtDur(sec: number): string {
  if (!isFinite(sec) || sec <= 0) return '—'
  const m = Math.floor(sec / 60)
  const s = sec - m * 60
  return `${m}:${s.toFixed(1).padStart(4, '0')}`
}
