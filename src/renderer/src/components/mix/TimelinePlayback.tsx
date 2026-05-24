import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AudioMeta, ClipMeta } from '../../../../shared/library'
import type { ClipOverride, MixAudioMode } from '../../../../shared/mix'

export type PlaybackSegment = {
  clip: ClipMeta
  startSec: number
  durationSec: number
}

type Props = {
  segments: PlaybackSegment[]
  audioMode: MixAudioMode
  audios: AudioMeta[]
  audioLoop: boolean
  /** 来源 importId → 色板，用来给进度条上每个片段着色；可空 */
  importColors?: Map<string, string>
}

function fmtTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '00:00'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export function TimelinePlayback({
  segments,
  audioMode,
  audios,
  audioLoop,
  importColors
}: Props) {
  const [playing, setPlaying] = useState(false)
  const [loading, setLoading] = useState(false)
  const [loadErr, setLoadErr] = useState('')
  const [segIndex, setSegIndex] = useState(0)
  const [elapsed, setElapsed] = useState(0)

  const videoRef = useRef<HTMLVideoElement>(null)
  const audioRef = useRef<HTMLAudioElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const blobCache = useRef(new Map<string, string>())
  const playingRef = useRef(false)
  const segIndexRef = useRef(0)
  const elapsedRef = useRef(0)
  const rafRef = useRef<number | null>(null)
  const audioChainIdxRef = useRef(0)
  // 进度条滚动 / 点击：用 token 让旧的异步 seek 自动作废；用 pointer-down/up 控制提交
  const seekTokenRef = useRef(0)
  const scrubbingRef = useRef(false)
  const scrubResumePlayingRef = useRef(false)
  const seekDebounceRef = useRef<number | null>(null)

  const totalDur = useMemo(
    () => segments.reduce((a, s) => a + s.durationSec, 0),
    [segments]
  )
  const totalAudioDur = useMemo(() => audios.reduce((a, x) => a + x.durationSec, 0), [audios])

  const embedHasAudio = useMemo(() => {
    if (audioMode !== 'embed') return false
    return segments.length > 0 && segments.every((s) => s.clip.hasAudio)
  }, [audioMode, segments])

  const effectiveAudioMode = useMemo((): MixAudioMode => {
    if (audioMode === 'embed' && !embedHasAudio) return 'silent'
    if (audioMode === 'replace' && audios.length === 0) return 'silent'
    return audioMode
  }, [audioMode, embedHasAudio, audios.length])

  const stop = useCallback(() => {
    playingRef.current = false
    setPlaying(false)
    setLoading(false)
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    videoRef.current?.pause()
    audioRef.current?.pause()
  }, [])

  const reset = useCallback(() => {
    stop()
    seekTokenRef.current++
    scrubbingRef.current = false
    if (seekDebounceRef.current != null) {
      window.clearTimeout(seekDebounceRef.current)
      seekDebounceRef.current = null
    }
    segIndexRef.current = 0
    elapsedRef.current = 0
    setSegIndex(0)
    setElapsed(0)
    if (videoRef.current) {
      videoRef.current.removeAttribute('src')
    }
  }, [stop])

  // 时间线内容变化时停止并重置
  const timelineKey = useMemo(
    () =>
      JSON.stringify({
        segs: segments.map((s) => [
          s.clip.id,
          s.startSec,
          s.durationSec
        ]),
        audioMode,
        audioIds: audios.map((a) => a.id),
        audioLoop
      }),
    [segments, audioMode, audios, audioLoop]
  )
  useEffect(() => {
    reset()
  }, [timelineKey, reset])

  useEffect(() => {
    return () => {
      stop()
      if (seekDebounceRef.current != null) {
        window.clearTimeout(seekDebounceRef.current)
        seekDebounceRef.current = null
      }
      for (const url of blobCache.current.values()) URL.revokeObjectURL(url)
      blobCache.current.clear()
    }
  }, [stop])

  const loadBlob = useCallback(async (rel: string): Promise<string> => {
    const cached = blobCache.current.get(rel)
    if (cached) return cached
    const r = await window.scissor.library.readAsBase64(rel)
    if (!r.ok || !r.base64) throw new Error(r.error ?? '读取失败')
    const bin = atob(r.base64)
    const arr = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
    const blob = new Blob([arr], { type: r.mime || 'video/mp4' })
    const url = URL.createObjectURL(blob)
    blobCache.current.set(rel, url)
    return url
  }, [])

  const tickElapsed = useCallback(() => {
    if (!playingRef.current) return
    const v = videoRef.current
    if (v && !v.paused) {
      let base = 0
      for (let i = 0; i < segIndexRef.current; i++) base += segments[i]?.durationSec ?? 0
      const seg = segments[segIndexRef.current]
      if (seg) {
        const inSeg = Math.max(0, v.currentTime - seg.startSec)
        elapsedRef.current = Math.min(totalDur, base + Math.min(inSeg, seg.durationSec))
        setElapsed(elapsedRef.current)
      }
    }
    rafRef.current = requestAnimationFrame(tickElapsed)
  }, [segments, totalDur])

  const startExternalAudio = useCallback(async (): Promise<void> => {
    if (effectiveAudioMode !== 'replace' || audios.length === 0) return
    const el = audioRef.current
    if (!el) return
    audioChainIdxRef.current = 0
    const playIdx = async (idx: number): Promise<void> => {
      if (!playingRef.current) return
      if (idx >= audios.length) {
        if (audioLoop && playingRef.current) {
          audioChainIdxRef.current = 0
          await playIdx(0)
        }
        return
      }
      audioChainIdxRef.current = idx
      const url = await loadBlob(audios[idx].audioRel)
      el.src = url
      el.currentTime = 0
      try {
        await el.play()
      } catch {
        /* ignore */
      }
    }
    el.onended = () => {
      if (!playingRef.current) return
      void playIdx(audioChainIdxRef.current + 1)
    }
    await playIdx(0)
  }, [audios, audioLoop, effectiveAudioMode, loadBlob])

  const playSegment = useCallback(
    async (idx: number): Promise<void> => {
      if (!playingRef.current || idx >= segments.length) {
        playingRef.current = false
        setPlaying(false)
        if (rafRef.current != null) {
          cancelAnimationFrame(rafRef.current)
          rafRef.current = null
        }
        audioRef.current?.pause()
        if (idx >= segments.length && totalDur > 0) {
          elapsedRef.current = totalDur
          setElapsed(totalDur)
        }
        return
      }
      const seg = segments[idx]
      const v = videoRef.current
      if (!v) return

      segIndexRef.current = idx
      setSegIndex(idx)
      setLoading(true)
      try {
        const url = await loadBlob(seg.clip.videoRel)
        if (!playingRef.current) return
        v.muted = effectiveAudioMode !== 'embed'
        v.src = url
        v.currentTime = seg.startSec
        await v.play()
        setLoading(false)

        const endAt = seg.startSec + seg.durationSec
        const onTimeUpdate = (): void => {
          if (!playingRef.current) {
            v.removeEventListener('timeupdate', onTimeUpdate)
            return
          }
          if (v.currentTime >= endAt - 0.04 || v.ended) {
            v.removeEventListener('timeupdate', onTimeUpdate)
            v.pause()
            void playSegment(idx + 1)
          }
        }
        v.addEventListener('timeupdate', onTimeUpdate)
      } catch (e) {
        setLoading(false)
        const msg = e instanceof Error ? e.message : String(e)
        setLoadErr(msg)
        stop()
      }
    },
    [segments, effectiveAudioMode, loadBlob, reset, stop]
  )

  const handlePlay = useCallback(async (): Promise<void> => {
    if (segments.length === 0) return
    const v = videoRef.current

  // 已在播 → 暂停（保留进度）
    if (playingRef.current) {
      playingRef.current = false
      setPlaying(false)
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
      v?.pause()
      audioRef.current?.pause()
      return
    }

    setLoadErr('')
    playingRef.current = true
    setPlaying(true)
    rafRef.current = requestAnimationFrame(tickElapsed)

    // 从当前段继续（暂停后恢复）或从头
    const resumeIdx = segIndexRef.current
    const resumeSeg = segments[resumeIdx]
    const atEnd = elapsedRef.current >= totalDur - 0.05 || resumeIdx >= segments.length
    if (
      !atEnd &&
      v?.src &&
      resumeSeg &&
      v.currentTime < resumeSeg.startSec + resumeSeg.durationSec - 0.05
    ) {
      v.muted = effectiveAudioMode !== 'embed'
      try {
        await v.play()
      } catch {
        /* ignore */
      }
      if (effectiveAudioMode === 'replace') {
        try {
          await audioRef.current?.play()
        } catch {
          /* ignore */
        }
      }
      const endAt = resumeSeg.startSec + resumeSeg.durationSec
      const onTimeUpdate = (): void => {
        if (!playingRef.current) {
          v.removeEventListener('timeupdate', onTimeUpdate)
          return
        }
        if (v.currentTime >= endAt - 0.04 || v.ended) {
          v.removeEventListener('timeupdate', onTimeUpdate)
          v.pause()
          void playSegment(resumeIdx + 1)
        }
      }
      v.addEventListener('timeupdate', onTimeUpdate)
      return
    }

    // 从头播
    segIndexRef.current = 0
    elapsedRef.current = 0
    setSegIndex(0)
    setElapsed(0)
    void startExternalAudio()
    await playSegment(0)
  }, [
    segments,
    totalDur,
    effectiveAudioMode,
    playSegment,
    startExternalAudio,
    tickElapsed
  ])

  /**
   * 真正的 seek：暂停一切 → 找到目标段 → 把 <video> 装载到该段并定位到 currentTime
   * 无论 autoPlay 与否都会重写 v.src/currentTime，保证视频元素状态与时间线一致
   */
  const performSeek = useCallback(
    async (target: number, autoPlay: boolean): Promise<void> => {
      if (segments.length === 0 || totalDur <= 0) return
      const token = ++seekTokenRef.current

      // 先把所有正在播的内容停下
      playingRef.current = false
      setPlaying(false)
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
      audioRef.current?.pause()
      videoRef.current?.pause()

      const clamped = Math.max(0, Math.min(totalDur - 0.01, target))
      let acc = 0
      let idx = 0
      for (let i = 0; i < segments.length; i++) {
        if (acc + segments[i].durationSec > clamped) {
          idx = i
          break
        }
        acc += segments[i].durationSec
        idx = i + 1
      }
      if (idx >= segments.length) idx = segments.length - 1
      const offsetInSeg = Math.max(
        0,
        clamped - segments.slice(0, idx).reduce((a, s) => a + s.durationSec, 0)
      )

      const seg = segments[idx]
      const v = videoRef.current
      if (!v || !seg) return

      try {
        const url = await loadBlob(seg.clip.videoRel)
        if (token !== seekTokenRef.current) return // 被新 seek 覆盖

        if (v.src !== url) {
          v.src = url
          await new Promise<void>((resolve, reject) => {
            const cleanup = (): void => {
              v.removeEventListener('loadedmetadata', onMeta)
              v.removeEventListener('error', onErr)
            }
            const onMeta = (): void => {
              cleanup()
              resolve()
            }
            const onErr = (): void => {
              cleanup()
              reject(new Error('视频加载失败'))
            }
            if (v.readyState >= 1) {
              resolve()
              return
            }
            v.addEventListener('loadedmetadata', onMeta)
            v.addEventListener('error', onErr)
          })
          if (token !== seekTokenRef.current) return
        }

        v.muted = effectiveAudioMode !== 'embed'
        v.currentTime = seg.startSec + offsetInSeg
        if (!autoPlay) v.pause()

        segIndexRef.current = idx
        elapsedRef.current = clamped
        setSegIndex(idx)
        setElapsed(clamped)

        if (autoPlay && token === seekTokenRef.current) {
          playingRef.current = true
          setPlaying(true)
          rafRef.current = requestAnimationFrame(tickElapsed)
          if (effectiveAudioMode === 'replace') {
            void startExternalAudio()
          }
          await v.play()

          const endAt = seg.startSec + seg.durationSec
          const onTimeUpdate = (): void => {
            if (token !== seekTokenRef.current || !playingRef.current) {
              v.removeEventListener('timeupdate', onTimeUpdate)
              return
            }
            if (v.currentTime >= endAt - 0.04 || v.ended) {
              v.removeEventListener('timeupdate', onTimeUpdate)
              v.pause()
              void playSegment(idx + 1)
            }
          }
          v.addEventListener('timeupdate', onTimeUpdate)
        }
      } catch (e) {
        if (token === seekTokenRef.current) {
          setLoadErr(e instanceof Error ? e.message : String(e))
        }
      }
    },
    [
      segments,
      totalDur,
      effectiveAudioMode,
      loadBlob,
      tickElapsed,
      startExternalAudio,
      playSegment
    ]
  )

  /** 用户开始抓进度条（pointer down 或键盘） */
  const handleScrubStart = useCallback((): void => {
    if (scrubbingRef.current) return
    scrubbingRef.current = true
    scrubResumePlayingRef.current = playingRef.current
    if (playingRef.current) {
      playingRef.current = false
      setPlaying(false)
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
      videoRef.current?.pause()
      audioRef.current?.pause()
    }
  }, [])

  /** 用户拖动 / 点击 / 键盘改值时，仅做视觉更新；用防抖兜底键盘连按 */
  const handleScrubChange = useCallback(
    (ratio: number): void => {
      if (totalDur <= 0) return
      if (!scrubbingRef.current) handleScrubStart()
      const target = Math.max(0, Math.min(totalDur, ratio * totalDur))
      elapsedRef.current = target
      setElapsed(target)
      if (seekDebounceRef.current != null) {
        window.clearTimeout(seekDebounceRef.current)
      }
      seekDebounceRef.current = window.setTimeout(() => {
        seekDebounceRef.current = null
        // 兜底：键盘改值时不会有 pointerup → 这里替代
        if (scrubbingRef.current) {
          handleScrubEndRef.current?.()
        }
      }, 220)
    },
    [totalDur, handleScrubStart]
  )

  const handleScrubEndRef = useRef<(() => void) | null>(null)
  const handleScrubEnd = useCallback((): void => {
    if (!scrubbingRef.current) return
    if (seekDebounceRef.current != null) {
      window.clearTimeout(seekDebounceRef.current)
      seekDebounceRef.current = null
    }
    const target = elapsedRef.current
    const wasPlaying = scrubResumePlayingRef.current
    scrubbingRef.current = false
    void performSeek(target, wasPlaying)
  }, [performSeek])
  handleScrubEndRef.current = handleScrubEnd

  /** 把 pointer 的 clientX 换算成 0~1 比例 */
  const ptrToRatio = useCallback((clientX: number): number => {
    const el = trackRef.current
    if (!el) return 0
    const rect = el.getBoundingClientRect()
    if (rect.width <= 0) return 0
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
  }, [])

  const handleTrackPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>): void => {
      if (totalDur <= 0) return
      e.preventDefault()
      try {
        e.currentTarget.setPointerCapture(e.pointerId)
      } catch {
        /* 某些浏览器在合成事件里 setPointerCapture 失败，忽略即可 */
      }
      handleScrubStart()
      handleScrubChange(ptrToRatio(e.clientX))
    },
    [totalDur, handleScrubStart, handleScrubChange, ptrToRatio]
  )

  const handleTrackPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>): void => {
      if (!scrubbingRef.current) return
      handleScrubChange(ptrToRatio(e.clientX))
    },
    [handleScrubChange, ptrToRatio]
  )

  const handleTrackPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>): void => {
      if (!scrubbingRef.current) return
      try {
        e.currentTarget.releasePointerCapture(e.pointerId)
      } catch {
        /* no-op */
      }
      handleScrubEnd()
    },
    [handleScrubEnd]
  )

  if (segments.length === 0) {
    return (
      <div className="mix-playback">
        <div className="mix-playback-empty">时间线为空，无法试听</div>
      </div>
    )
  }

  const progressPct = totalDur > 0 ? (elapsed / totalDur) * 100 : 0

  return (
    <div className="mix-playback">
      <div className="mix-playback-head">
        <strong>试听</strong>
        <span className="mix-playback-hint">
          按时间线顺序播放，不重新编码
          {effectiveAudioMode === 'embed' && ' · 片段原声'}
          {effectiveAudioMode === 'replace' && ` · 替换音频 ${totalAudioDur.toFixed(1)}s`}
          {effectiveAudioMode === 'silent' && ' · 静音'}
          {audioMode === 'embed' && !embedHasAudio && '（部分片段无音轨，已静音）'}
        </span>
      </div>

      <div className="mix-playback-screen">
        <video ref={videoRef} playsInline />
        {loading && <div className="mix-playback-loading">加载片段…</div>}
        <audio ref={audioRef} className="mix-playback-audio-hidden" />
      </div>

      <div className="mix-playback-controls">
        <button
          type="button"
          className="primary-btn small mix-playback-playbtn"
          onClick={() => void handlePlay()}
          disabled={loading && !playing}
        >
          {playing ? '⏸ 暂停' : '▶ 播放'}
        </button>
        <span className="mix-playback-time">
          {fmtTime(elapsed)} / {fmtTime(totalDur)}
        </span>
        <span className="mix-playback-seg">
          第 {Math.min(segIndex + 1, segments.length)}/{segments.length} 段
        </span>
      </div>

      <div
        ref={trackRef}
        className={`mix-playback-track ${scrubbingRef.current ? 'scrubbing' : ''}`}
        onPointerDown={handleTrackPointerDown}
        onPointerMove={handleTrackPointerMove}
        onPointerUp={handleTrackPointerUp}
        onPointerCancel={handleTrackPointerUp}
      >
        <div className="mix-playback-track-segs">
          {segments.map((s, i) => {
            const widthPct = totalDur > 0 ? (s.durationSec / totalDur) * 100 : 0
            const color = importColors?.get(s.clip.importId) ?? '#666'
            const cls = [
              'mix-playback-track-seg',
              i === segIndex ? 'active' : '',
              i < segIndex ? 'past' : ''
            ]
              .filter(Boolean)
              .join(' ')
            return (
              <div
                key={`${s.clip.id}@${i}`}
                className={cls}
                style={{ flex: `0 0 ${widthPct}%`, background: color }}
                title={`#${i + 1} · ${s.durationSec.toFixed(1)}s`}
              >
                {widthPct > 4 && <span className="mix-playback-track-seg-idx">{i + 1}</span>}
              </div>
            )
          })}
        </div>
        <div className="mix-playback-track-played" style={{ width: `${progressPct}%` }} />
        <div className="mix-playback-track-head" style={{ left: `${progressPct}%` }} />
      </div>

      {loadErr && <div className="mix-playback-err">{loadErr}</div>}
    </div>
  )
}
