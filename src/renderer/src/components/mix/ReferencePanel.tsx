import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReferenceState } from '../../../../shared/mix'

type Props = {
  reference: ReferenceState | undefined
  onChange: (ref: ReferenceState | undefined) => void
  onAutoAlign: () => void
  canAutoAlign: boolean
  alignHint?: string
}

function fmtTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '00:00.000'
  const m = Math.floor(sec / 60)
  const s = sec - m * 60
  return `${String(m).padStart(2, '0')}:${s.toFixed(3).padStart(6, '0')}`
}

export function ReferencePanel({
  reference,
  onChange,
  onAutoAlign,
  canAutoAlign,
  alignHint
}: Props) {
  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  const [loadingBytes, setLoadingBytes] = useState(false)
  const [loadErr, setLoadErr] = useState('')
  const [analyzing, setAnalyzing] = useState(false)
  const [threshold, setThreshold] = useState<number>(reference?.threshold ?? 0.25)
  const [currentTime, setCurrentTime] = useState(0)
  const videoRef = useRef<HTMLVideoElement>(null)
  const videoUrlRef = useRef<string | null>(null)

  useEffect(() => {
    return () => {
      if (videoUrlRef.current) URL.revokeObjectURL(videoUrlRef.current)
    }
  }, [])

  // 切换 reference path 时加载字节
  useEffect(() => {
    if (!reference?.videoPath) {
      if (videoUrlRef.current) {
        URL.revokeObjectURL(videoUrlRef.current)
        videoUrlRef.current = null
      }
      setVideoUrl(null)
      return
    }
    let cancelled = false
    setLoadingBytes(true)
    setLoadErr('')
    window.scissor.mix.readReferenceBytes(reference.videoPath).then((r) => {
      if (cancelled) return
      setLoadingBytes(false)
      if (!r.ok) {
        setLoadErr('error' in r ? r.error : '加载失败')
        return
      }
      const bin = atob(r.base64)
      const arr = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
      const blob = new Blob([arr], { type: r.mime })
      const url = URL.createObjectURL(blob)
      if (videoUrlRef.current) URL.revokeObjectURL(videoUrlRef.current)
      videoUrlRef.current = url
      setVideoUrl(url)
    })
    return () => {
      cancelled = true
    }
  }, [reference?.videoPath])

  async function handlePick(): Promise<void> {
    const path = await window.scissor.mix.pickReferenceVideo()
    if (!path) return
    const probe = await window.scissor.mix.probeReferenceMeta(path)
    onChange({
      videoPath: path,
      durationSec: probe.ok ? probe.durationSec ?? 0 : 0,
      sizeBytes: probe.ok ? probe.sizeBytes ?? 0 : 0,
      threshold,
      segments: [],
      markers: []
    })
  }

  async function handleAnalyze(): Promise<void> {
    if (!reference) return
    setAnalyzing(true)
    try {
      const r = await window.scissor.mix.analyzeReference({
        path: reference.videoPath,
        threshold
      })
      if (!r.ok) {
        setLoadErr('error' in r ? r.error : '分析失败')
        return
      }
      onChange({
        ...reference,
        durationSec: r.durationSec || reference.durationSec,
        sizeBytes: r.sizeBytes || reference.sizeBytes,
        threshold: r.threshold,
        segments: r.segments
      })
    } finally {
      setAnalyzing(false)
    }
  }

  function handleClear(): void {
    onChange(undefined)
  }

  function jumpTo(sec: number): void {
    const v = videoRef.current
    if (!v) return
    v.currentTime = Math.max(0, Math.min(sec, v.duration || sec))
    v.play().catch(() => {
      /* ignore */
    })
  }

  function step(deltaFrames: number): void {
    const v = videoRef.current
    if (!v) return
    v.pause()
    const fps = 30
    v.currentTime = Math.max(0, Math.min(v.duration || 0, v.currentTime + deltaFrames / fps))
  }

  function addMarker(): void {
    if (!reference) return
    const v = videoRef.current
    if (!v) return
    const t = v.currentTime
    if (!Number.isFinite(t)) return
    const arr = [...reference.markers, +t.toFixed(3)].sort((a, b) => a - b)
    onChange({ ...reference, markers: arr })
  }

  function removeMarker(idx: number): void {
    if (!reference) return
    const arr = reference.markers.slice()
    arr.splice(idx, 1)
    onChange({ ...reference, markers: arr })
  }

  // 键盘快捷键
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (!reference || !videoRef.current) return
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.code === 'Space') {
        e.preventDefault()
        const v = videoRef.current
        if (v.paused) v.play().catch(() => undefined)
        else v.pause()
      } else if (e.code === 'ArrowLeft') {
        if (e.altKey || e.shiftKey) return
        step(-1)
        e.preventDefault()
      } else if (e.code === 'ArrowRight') {
        if (e.altKey || e.shiftKey) return
        step(1)
        e.preventDefault()
      } else if (e.code === 'KeyM' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        addMarker()
        e.preventDefault()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reference?.markers.length, reference?.videoPath])

  const totalDur = reference?.durationSec ?? 0
  const segStats = useMemo(() => {
    const segs = reference?.segments ?? []
    if (segs.length === 0) return null
    const durs = segs.map((s) => s.dur)
    const avg = durs.reduce((a, b) => a + b, 0) / durs.length
    return {
      count: segs.length,
      avg,
      min: Math.min(...durs),
      max: Math.max(...durs)
    }
  }, [reference?.segments])

  if (!reference) {
    return (
      <div className="ref-panel">
        <div className="ref-panel-empty">
          <p>选一段「热门视频」当作节奏对照，工具会自动识别它的镜头切点。</p>
          <button type="button" className="primary-btn small" onClick={handlePick}>
            选择参考视频
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="ref-panel">
      <div className="ref-panel-head">
        <span className="ref-panel-name" title={reference.videoPath}>
          {reference.videoPath.split(/[/\\]/).pop()}
        </span>
        <div className="ref-panel-head-actions">
          <button type="button" className="ghost-btn xs" onClick={handlePick}>
            换一个
          </button>
          <button type="button" className="ghost-btn xs" onClick={handleClear}>
            移除
          </button>
        </div>
      </div>

      <div className="ref-panel-meta">
        <span>{fmtTime(totalDur)}</span>
        <span>·</span>
        <span>{(reference.sizeBytes / 1024 / 1024).toFixed(1)}MB</span>
      </div>

      <div className="ref-panel-video-wrap">
        {loadingBytes && <div className="ref-panel-video-loading">读取参考视频…</div>}
        {loadErr && <div className="ref-panel-video-err">{loadErr}</div>}
        {videoUrl && (
          <video
            ref={videoRef}
            src={videoUrl}
            controls
            loop
            playsInline
            onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
          />
        )}
      </div>

      {videoUrl && (
        <div className="ref-panel-controls">
          <span className="ref-panel-time">{fmtTime(currentTime)}</span>
          <button type="button" className="ghost-btn xs" onClick={() => step(-1)} title="-1帧">
            ⟨ 1f
          </button>
          <button type="button" className="ghost-btn xs" onClick={() => step(1)} title="+1帧">
            1f ⟩
          </button>
          <button type="button" className="ghost-btn xs" onClick={addMarker} title="M 标记">
            + 标记 (M)
          </button>
        </div>
      )}

      <div className="ref-panel-section">
        <div className="ref-panel-section-head">
          <strong>镜头节奏</strong>
          <label className="ref-panel-thresh">
            阈值
            <input
              type="range"
              min={0.1}
              max={0.6}
              step={0.05}
              value={threshold}
              onChange={(e) => setThreshold(+e.target.value)}
            />
            <span>{threshold.toFixed(2)}</span>
          </label>
          <button
            type="button"
            className="primary-btn xs"
            onClick={handleAnalyze}
            disabled={analyzing}
          >
            {analyzing ? '分析中…' : segStats ? '重新分析' : '分析镜头'}
          </button>
        </div>
        {segStats && (
          <div className="ref-panel-segstats">
            共 {segStats.count} 段 · 平均 {segStats.avg.toFixed(2)}s · 最短{' '}
            {segStats.min.toFixed(2)}s · 最长 {segStats.max.toFixed(2)}s
          </div>
        )}
        {segStats && (
          <div className="ref-panel-seglist">
            {reference.segments.map((s, i) => {
              const active = currentTime >= s.start && currentTime < s.end
              return (
                <button
                  key={i}
                  type="button"
                  className={`ref-panel-seg ${active ? 'active' : ''}`}
                  onClick={() => jumpTo(s.start)}
                  title={`跳到 ${fmtTime(s.start)}`}
                >
                  <span className="ref-panel-seg-idx">#{i + 1}</span>
                  <span className="ref-panel-seg-time">{fmtTime(s.start)}</span>
                  <span className="ref-panel-seg-dur">{s.dur.toFixed(2)}s</span>
                </button>
              )
            })}
          </div>
        )}
      </div>

      {reference.markers.length > 0 && (
        <div className="ref-panel-section">
          <div className="ref-panel-section-head">
            <strong>手动标记</strong>
            <span className="ref-panel-meta">{reference.markers.length} 个</span>
          </div>
          <div className="ref-panel-markers">
            {reference.markers.map((t, i) => (
              <span key={`${t}-${i}`} className="ref-panel-marker">
                <button
                  type="button"
                  className="ref-panel-marker-time"
                  onClick={() => jumpTo(t)}
                >
                  {fmtTime(t)}
                </button>
                <button
                  type="button"
                  className="ref-panel-marker-x"
                  onClick={() => removeMarker(i)}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        </div>
      )}

      {segStats && (
        <div className="ref-panel-section ref-panel-align">
          <button
            type="button"
            className="primary-btn small"
            onClick={onAutoAlign}
            disabled={!canAutoAlign}
            title={alignHint || '按参考节奏重排时间线'}
          >
            ★ 按参考节奏自动排列
          </button>
          {alignHint && <div className="ref-panel-align-hint">{alignHint}</div>}
        </div>
      )}
    </div>
  )
}
