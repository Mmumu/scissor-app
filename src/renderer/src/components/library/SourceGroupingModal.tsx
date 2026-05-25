import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ClipMeta, ImportRecord, LibraryIndex, CleanupStrength } from '../../../../shared/library'
import { evaluateGrouping } from '../../utils/clipGroups'
import {
  alignClipSourceTimes,
  findClipAtSourceTime,
  sourceTimelineDuration
} from '../../utils/sourceClipTime'
import { SourceTimeline, formatTimecode } from './SourceTimeline'
import { ClipCard } from './ClipCard'
import { ImportProgress, type ProgressItem } from './ImportProgress'

type Props = {
  index: LibraryIndex
  importRec: ImportRecord
  importColor: string
  onClose: () => void
  onCreated: () => void // 父级在成功后用来 reload index
  initialMode?: 'group' | 'cut'
}

type MarkedSegment = {
  id: string
  startSec: number
  endSec: number
}

export function SourceGroupingModal({
  index,
  importRec,
  importColor,
  onClose,
  onCreated,
  initialMode
}: Props) {
  const [mode, setMode] = useState<'group' | 'cut'>(initialMode ?? 'group')
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
  
  // 自动/手动对齐相关状态
  const [activeRange, setActiveRange] = useState<{ start: number; end: number } | null>(null)
  const activeRangeRef = useRef<{ start: number; end: number } | null>(null)
  activeRangeRef.current = activeRange
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const lastThumbClickRef = useRef<number | null>(null)

  // 手动切片特有状态
  const [markedSegments, setMarkedSegments] = useState<MarkedSegment[]>([])
  const [inPoint, setInPoint] = useState<number | null>(null)
  const [outPoint, setOutPoint] = useState<number | null>(null)
  const [loopPreview, setLoopPreview] = useState(false)
  const [cleanupStrength, setCleanupStrength] = useState<CleanupStrength>('standard')
  const [progressItems, setProgressItems] = useState<ProgressItem[]>([])

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
    const syncTime = (): void => {
      const cur = el.currentTime || 0
      setPlayhead(cur)

      // 手动区间循环预览模式
      if (mode === 'cut' && loopPreview && inPoint !== null && outPoint !== null) {
        const start = Math.min(inPoint, outPoint)
        const end = Math.max(inPoint, outPoint)
        if (cur >= end || cur < start) {
          el.currentTime = start
          setPlayhead(start)
        }
        return
      }

      // 默认的 alignment 区间预览
      const range = activeRangeRef.current
      if (range && cur >= range.end) {
        el.pause()
        el.currentTime = range.start
        setPlayhead(range.start)
        setActiveRange(null)
      }
    }
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
  }, [videoUrl, mode, loopPreview, inPoint, outPoint])

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
    (sec: number, keepRange = false) => {
      if (!keepRange) {
        setActiveRange(null)
        setLoopPreview(false)
      }
      const cap = mode === 'group' ? (timelineDur || vidDur || sec) : (vidDur || sec)
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
    [timelineDur, vidDur, mode]
  )

  function nearestBoundary(sec: number, side: 'lo' | 'hi'): number {
    if (clips.length === 0) return sec
    if (side === 'lo') {
      const inside = clips.find((c) => c.sourceStartSec <= sec && sec < c.sourceEndSec)
      if (inside) return inside.sourceStartSec
      const after = clips.find((c) => c.sourceStartSec >= sec)
      return after ? after.sourceStartSec : (clips[clips.length - 1]?.sourceStartSec ?? sec)
    } else {
      const inside = clips.find((c) => c.sourceStartSec <= sec && sec < c.sourceEndSec)
      if (inside) return inside.sourceEndSec
      let best = clips[0]?.sourceEndSec ?? sec
      for (const c of clips) if (c.sourceEndSec <= sec) best = c.sourceEndSec
      return best
    }
  }

  // 标入点/出点（吸附已有切片边界）
  const inPointRef = useRef<number | null>(null)
  function markIn(): void {
    if (mode === 'cut') {
      setInPoint(playhead)
      showToast(`入点 = ${formatTimecode(playhead)}`)
    } else {
      inPointRef.current = nearestBoundary(playhead, 'lo')
      showToast(`入点 = ${formatTimecode(inPointRef.current)}`)
    }
  }
  function markOut(): void {
    if (mode === 'cut') {
      setOutPoint(playhead)
      showToast(`出点 = ${formatTimecode(playhead)}`)
    } else {
      if (inPointRef.current == null) {
        showToast('请先按 [ 标入点', 'err')
        return
      }
      const out = nearestBoundary(playhead, 'hi')
      const lo = Math.min(inPointRef.current, out)
      const hi = Math.max(inPointRef.current, out)
      const hits = clips.filter((c) => c.sourceEndSec > lo && c.sourceStartSec < hi)
      setSelected(new Set(hits.map((c) => c.id)))
      showToast(`选区 ${formatTimecode(lo)} → ${formatTimecode(hi)}（${hits.length} 段）`)
      inPointRef.current = null
    }
  }

  function showToast(text: string, kind: 'ok' | 'err' = 'ok'): void {
    setToast({ kind, text })
    window.setTimeout(() => setToast(null), 1800)
  }

  // 微调控制
  function stepFrame(frames: number): void {
    const el = videoRef.current
    if (!el) return
    const fps = 25
    const dt = frames * (1 / fps)
    const next = Math.max(0, Math.min(vidDur, el.currentTime + dt))
    el.currentTime = next
    setPlayhead(next)
  }

  // 添加片段到待切片队列
  const handleAddSegment = useCallback(() => {
    if (inPoint === null || outPoint === null) {
      showToast('请先完整标注入点与出点', 'err')
      return
    }
    const start = Math.min(inPoint, outPoint)
    const end = Math.max(inPoint, outPoint)
    if (end - start < 0.2) {
      showToast('标记的片段太短，需大于 0.2 秒', 'err')
      return
    }
    const id = `seg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
    setMarkedSegments((prev) => [...prev, { id, startSec: start, endSec: end }].sort((a, b) => a.startSec - b.startSec))
    setInPoint(null)
    setOutPoint(null)
    setLoopPreview(false)
    showToast('片段已成功加入待切片队列')
  }, [inPoint, outPoint])

  // 键盘快捷键
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      
      // Space 播放/暂停
      if (e.code === 'Space') {
        e.preventDefault()
        const v = videoRef.current
        if (v) {
          if (v.paused) v.play().catch(() => undefined)
          else v.pause()
        }
        return
      }

      // [ / I 标入点
      if (e.code === 'BracketLeft' || e.code === 'KeyI') {
        e.preventDefault()
        markIn()
        return
      }

      // ] / O 标出点
      if (e.code === 'BracketRight' || e.code === 'KeyO') {
        e.preventDefault()
        markOut()
        return
      }

      // ← 方向键：回退一帧
      if (e.code === 'ArrowLeft') {
        e.preventDefault()
        stepFrame(e.shiftKey ? -25 : -1)
        return
      }

      // → 方向键：前进一帧
      if (e.code === 'ArrowRight') {
        e.preventDefault()
        stepFrame(e.shiftKey ? 25 : 1)
        return
      }

      // Enter 键在手动切片模式下添加片段
      if (e.code === 'Enter' && mode === 'cut') {
        e.preventDefault()
        handleAddSegment()
        return
      }

      // Esc 取消选区/关闭
      if (e.code === 'Escape') {
        e.preventDefault()
        if (mode === 'group' && selected.size > 0) {
          setSelected(new Set())
        } else if (mode === 'cut' && (inPoint !== null || outPoint !== null)) {
          setInPoint(null)
          setOutPoint(null)
          setLoopPreview(false)
        } else {
          onClose()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [playhead, selected, inPoint, outPoint, mode, handleAddSegment, onClose])

  // 对照组模式保存
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
        showToast('成组失败：' + (r as { error?: string }).error, 'err')
        return
      }
      onCreated()
      setSelected(new Set())
      setGroupName('')
      setGroupDescription('')
      showToast(`已成组「${r.group.name}」（${r.group.clipIds.length} 段）`)
    } catch (e) {
      showToast('成组失败：' + (e instanceof Error ? e.message : String(e)), 'err')
    } finally {
      setSubmitting(false)
    }
  }

  // 手动切片模式保存直切并自动成组
  async function handleCutAndSave(): Promise<void> {
    if (markedSegments.length === 0) {
      showToast('队列为空，请先标记并添加片段', 'err')
      return
    }
    setSubmitting(true)
    let targetImportId = ''
    
    // 监听进度回调
    const off = window.scissor.library.onImportProgress((ev) => {
      const hasId = 'importId' in ev
      if (ev.phase === 'done' && hasId) {
        targetImportId = ev.importId
      }
      setProgressItems((prev) => {
        const idx = prev.findIndex((p) => p.sourcePath === ev.sourcePath)
        const item: ProgressItem = {
          sourcePath: ev.sourcePath,
          importId: hasId ? ev.importId : '',
          phase: ev.phase,
          pct: 'pct' in ev ? ev.pct : undefined,
          current: ev.phase === 'thumbing' ? ev.current : undefined,
          total: ev.phase === 'thumbing' ? ev.total : undefined,
          error: ev.phase === 'error' ? ev.error : undefined,
          done: ev.phase === 'done' || ev.phase === 'error'
        }
        if (idx >= 0) {
          const next = prev.slice()
          next[idx] = item
          return next
        }
        return [item]
      })
    })

    try {
      // 触发手动精确导入
      const r = await window.scissor.library.importVideos({
        paths: [importRec.sourcePath],
        audioMode: 'extract',
        cleanup: cleanupStrength,
        sceneThreshold: 1.0,
        minSegSec: 0.1,
        maxSegSec: 999999,
        duplicatePolicy: 'reimport-add',
        manualSegments: markedSegments.map((s) => ({
          startSec: s.startSec,
          endSec: s.endSec
        }))
      })

      // 等待 1s 左右确保进度事件 done 处理完毕
      await new Promise((resolve) => setTimeout(resolve, 1200))

      if (targetImportId) {
        // 读取最新入库列表，并对生成的片段执行自动分组
        const latestIdx = await window.scissor.library.list()
        const newImp = latestIdx.imports.find((im) => im.id === targetImportId)
        if (newImp && newImp.clipIds.length > 0) {
          await window.scissor.library.createGroup({
            importId: targetImportId,
            clipIds: newImp.clipIds,
            name: groupName.trim() || `${basename(importRec.sourcePath)} 手动精确切片组`,
            description: groupDescription.trim() || undefined
          })
        }
      }
      
      showToast('切片切割并成组成功！')
      setMarkedSegments([])
      onCreated() // 触发父级重新加载素材池
      setTimeout(() => {
        onClose()
      }, 1000)
    } catch (err) {
      showToast('手动切片失败：' + (err instanceof Error ? err.message : String(err)), 'err')
    } finally {
      off()
      setSubmitting(false)
      setTimeout(() => setProgressItems([]), 3000)
    }
  }

  const totalSec = useMemo(() => {
    if (mode === 'group') {
      let t = 0
      for (const c of clips) if (selected.has(c.id)) t += c.sourceEndSec - c.sourceStartSec
      return t
    } else {
      return markedSegments.reduce((a, b) => a + (b.endSec - b.startSec), 0)
    }
  }, [clips, selected, markedSegments, mode])

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
        
        {/* 头部导航与 Tab */}
        <div className="source-grouping-head-wrapper">
          <div className="source-grouping-head">
            <button type="button" className="ghost-btn" onClick={onClose}>
              ← 返回
            </button>
            <h2>{mode === 'group' ? '对照原视频成组' : '帧级手动精准切片'}：{basename(importRec.sourcePath)}</h2>
            <div className="source-grouping-meta">
              {mode === 'group' ? `${clips.length} 段已切 · ` : ''}{fmtDur(mode === 'group' ? timelineDur : vidDur)}
            </div>
            <button type="button" className="ghost-btn" onClick={onClose}>
              ✕
            </button>
          </div>

          <div className="source-grouping-tabs">
            <button
              type="button"
              className={`source-grouping-tab ${mode === 'group' ? 'active' : ''}`}
              onClick={() => {
                setMode('group')
                setLoopPreview(false)
              }}
            >
              🔗 自动镜头对照成组 (已有片段)
            </button>
            <button
              type="button"
              className={`source-grouping-tab ${mode === 'cut' ? 'active' : ''}`}
              onClick={() => {
                setMode('cut')
                setSelected(new Set())
              }}
            >
              ✂ 帧级手动精准切片 (手动裁剪)
            </button>
          </div>
        </div>

        {sourceMissing ? (
          <div className="source-grouping-warn">
            ⚠ 原视频文件已被移动或删除（路径：<code>{sourcePath || importRec.sourcePath}</code>）。
            {mode === 'group' ? '可继续使用下方缩略图进行选择与成组。' : '手动切片功能不可用，请重新导入视频文件。'}
          </div>
        ) : null}

        {/* 核心内容区分流 */}
        {mode === 'group' ? (
          <>
            {/* 1. 原视频播放器 */}
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
                <kbd>[</kbd> 或 <kbd>I</kbd> 标入点 · <kbd>]</kbd> 或 <kbd>O</kbd> 标出点 · <kbd>Esc</kbd> 取消选区
              </div>
            </div>

            {/* 2. 可视化时间轴 */}
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

            {/* 3. 底部缩略图滚动条 */}
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
          </>
        ) : (
          /* ✂ 帧级手动切片模式双栏布局 */
          <div className="source-grouping-cut-body">
            
            {/* 左侧：播放器与精准帧控制 */}
            <div className="source-grouping-cut-left">
              <div className="source-grouping-player-wrap compact">
                {videoUrl ? (
                  <video
                    ref={videoRef}
                    src={videoUrl}
                    className="source-grouping-player"
                    playsInline
                  />
                ) : sourceMissing ? (
                  <div className="source-grouping-player-fallback">📹 原视频不可播放</div>
                ) : (
                  <div className="source-grouping-player-fallback">加载中…</div>
                )}
                
                {/* 简易高精度刻度进度条 */}
                <div className="precision-scrub-bar" onClick={(e) => {
                  if (!vidDur) return
                  const rect = e.currentTarget.getBoundingClientRect()
                  const pct = (e.clientX - rect.left) / rect.width
                  handleSeek(pct * vidDur)
                }}>
                  <div className="precision-scrub-fill" style={{ width: `${(playhead / (vidDur || 1)) * 100}%` }} />
                  {inPoint !== null && (
                    <div className="precision-marker in" style={{ left: `${(inPoint / (vidDur || 1)) * 100}%` }} title="入点" />
                  )}
                  {outPoint !== null && (
                    <div className="precision-marker out" style={{ left: `${(outPoint / (vidDur || 1)) * 100}%` }} title="出点" />
                  )}
                </div>

                <div className="source-grouping-now-playing compact">
                  播放进度: <strong>{formatTimecode(playhead)}</strong> / {formatTimecode(vidDur)}
                </div>
              </div>

              {/* 逐帧精准控制台 */}
              <div className="precision-control-panel">
                <div className="precision-control-row justify-center gap-10">
                  <button type="button" className="ghost-btn small" onClick={() => handleSeek(playhead - 5)}>⏮ -5s</button>
                  <button type="button" className="ghost-btn small" onClick={() => stepFrame(-1)}>◀ -1帧</button>
                  <button type="button" className="primary-btn small" onClick={() => {
                    const el = videoRef.current
                    if (el) {
                      if (el.paused) el.play().catch(() => {})
                      else el.pause()
                    }
                  }}>
                    {playing ? '⏸ 暂停' : '▶ 播放'}
                  </button>
                  <button type="button" className="ghost-btn small" onClick={() => stepFrame(1)}>▶ +1帧</button>
                  <button type="button" className="ghost-btn small" onClick={() => handleSeek(playhead + 5)}>⏭ +5s</button>
                </div>

                <div className="precision-control-row justify-center gap-10 margin-top-10">
                  <button
                    type="button"
                    className={`mark-btn in ${inPoint !== null ? 'active' : ''}`}
                    onClick={markIn}
                  >
                    [ 标为入点 (I)
                  </button>
                  <button
                    type="button"
                    className={`mark-btn out ${outPoint !== null ? 'active' : ''}`}
                    onClick={markOut}
                  >
                    ] 标为出点 (O)
                  </button>
                  <button
                    type="button"
                    className="add-seg-btn"
                    disabled={inPoint === null || outPoint === null}
                    onClick={handleAddSegment}
                  >
                    ＋ 添加该片段 (Enter)
                  </button>
                </div>

                {/* 临时选区预览与反馈 */}
                {(inPoint !== null || outPoint !== null) && (
                  <div className="temp-range-display">
                    <span className="bullet orange" />
                    <span>当前草稿选区：</span>
                    <strong>
                      {inPoint !== null ? formatTimecode(inPoint) : '未设置'}
                    </strong>
                    <span> ➔ </span>
                    <strong>
                      {outPoint !== null ? formatTimecode(outPoint) : '未设置'}
                    </strong>
                    {inPoint !== null && outPoint !== null && (
                      <>
                        <span className="dur-badge">{Math.abs(outPoint - inPoint).toFixed(2)}s</span>
                        <button
                          type="button"
                          className={`ghost-btn xs ${loopPreview ? 'active' : ''}`}
                          onClick={() => {
                            setLoopPreview(!loopPreview)
                            const el = videoRef.current
                            if (el) {
                              el.currentTime = Math.min(inPoint, outPoint)
                              el.play().catch(() => {})
                            }
                          }}
                        >
                          {loopPreview ? '⏹ 停止预览' : '🔁 循环预览区间'}
                        </button>
                      </>
                    )}
                  </div>
                )}
                
                <div className="precision-shortcuts-hint">
                  提示：键盘 <kbd>Space</kbd> 播放/暂停 · <kbd>I</kbd> 入点 · <kbd>O</kbd> 出点 · <kbd>←</kbd>/<kbd>→</kbd> 逐帧步进 · <kbd>Enter</kbd> 添入队列
                </div>
              </div>
            </div>

            {/* 右侧：待切割列表栏 */}
            <div className="source-grouping-cut-right">
              <div className="cut-queue-header">
                <h3>待切割队列 ({markedSegments.length})</h3>
                {markedSegments.length > 0 && (
                  <button type="button" className="ghost-btn xs danger-text" onClick={() => setMarkedSegments([])}>清空队列</button>
                )}
              </div>
              <div className="cut-queue-list">
                {markedSegments.length === 0 ? (
                  <div className="cut-queue-empty">
                    <span className="empty-icon">✂</span>
                    <p>尚未标定片段</p>
                    <p className="sub">在左侧使用 [ 标入点，] 标出点，然后点击 Enter 键添至列表</p>
                  </div>
                ) : (
                  markedSegments.map((seg, idx) => (
                    <div key={seg.id} className="cut-queue-item">
                      <div className="cut-item-left">
                        <span className="cut-item-idx">#{idx + 1}</span>
                        <div className="cut-item-meta">
                          <div className="cut-item-range">
                            {formatTimecode(seg.startSec)} ➔ {formatTimecode(seg.endSec)}
                          </div>
                          <div className="cut-item-dur">时长：{(seg.endSec - seg.startSec).toFixed(2)}s</div>
                        </div>
                      </div>
                      <div className="cut-item-actions">
                        <button
                          type="button"
                          className="ghost-btn icon-btn"
                          title="跳转至起点预览"
                          onClick={() => handleSeek(seg.startSec)}
                        >
                          ▶
                        </button>
                        <button
                          type="button"
                          className="ghost-btn icon-btn danger-text"
                          title="删除该片段"
                          onClick={() => setMarkedSegments((prev) => prev.filter((x) => x.id !== seg.id))}
                        >
                          ×
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

          </div>
        )}

        {/* 底部共享操作栏 */}
        <div className="source-grouping-foot">
          <div className="source-grouping-stat">
            {mode === 'group' ? (
              selected.size === 0 ? (
                <span className="muted">在上方时间轴拖动选区，或点击缩略图选择 1 段及以上连续片段</span>
              ) : (
                <>
                  已选 <strong>{selected.size}</strong> 段（
                  {selectedIndexLabels.slice(0, 8).join(' ')}
                  {selectedIndexLabels.length > 8 ? ' …' : ''}），合计 {totalSec.toFixed(1)}s
                </>
              )
            ) : (
              markedSegments.length === 0 ? (
                <span className="muted">标记的片段将自动进行隐形水印清洗、重编码并独立入库</span>
              ) : (
                <>
                  队列中已准备 <strong>{markedSegments.length}</strong> 段，合并总时长：<strong>{totalSec.toFixed(1)}s</strong>
                </>
              )
            )}
          </div>

          {/* 指纹清洗设置 (只在手动切片模式下显示) */}
          {mode === 'cut' && markedSegments.length > 0 && (
            <label className="mix-target-select cleaning-select">
              清洗强度
              <select
                value={cleanupStrength}
                onChange={(e) => setCleanupStrength(e.target.value as CleanupStrength)}
              >
                <option value="standard">标准指纹清洗（推荐）</option>
                <option value="light">轻度重编码</option>
                <option value="metadata-only">仅清元数据（最快）</option>
              </select>
            </label>
          )}

          {/* 成组输入与保存 */}
          {(mode === 'group' ? groupingEval.canGroup : markedSegments.length > 0) && (
            <>
              <input
                type="text"
                className="source-grouping-name-input"
                placeholder={mode === 'group' ? "组名（留空自动）" : "切片成组名称（留空自动）"}
                value={groupName}
                onChange={(e) => setGroupName(e.target.value)}
                maxLength={32}
              />
              <input
                type="text"
                className="source-grouping-desc-input"
                placeholder="成组描述信息（可选）"
                value={groupDescription}
                onChange={(e) => setGroupDescription(e.target.value)}
                maxLength={200}
              />
            </>
          )}

          {mode === 'group' ? (
            <button
              type="button"
              className="primary-btn"
              disabled={!groupingEval.canGroup || submitting}
              onClick={handleSubmit}
            >
              {submitting ? '保存中…' : '+ 成组并保存'}
            </button>
          ) : (
            <button
              type="button"
              className="primary-btn danger-btn-themed"
              disabled={markedSegments.length === 0 || submitting}
              onClick={handleCutAndSave}
            >
              {submitting ? '开始切割中…' : '✂ 开始切割并保存'}
            </button>
          )}
        </div>

        {/* 导入进度弹窗组件 */}
        {progressItems.length > 0 && (
          <div className="inner-import-progress-overlay">
            <div className="inner-import-progress-card">
              <ImportProgress items={progressItems} />
            </div>
          </div>
        )}

        {toast && (
          <div className={`source-grouping-toast ${toast.kind}`}>{toast.text}</div>
        )}
      </div>
    </div>
  )

  // 组模式下缩略图条点击
  function handleThumbClick(idx: number, e: React.MouseEvent): void {
    const c = clips[idx]
    if (!c) return
    handleSeek(c.sourceStartSec, true)
    setActiveRange({ start: c.sourceStartSec, end: c.sourceEndSec })
    const el = videoRef.current
    if (el) {
      el.play().catch(() => {})
    }
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
