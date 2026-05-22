import { useEffect, useRef, useState } from 'react'
import type { AudioMeta } from '../../../../shared/library'

type Props = {
  audio: AudioMeta
  selected?: boolean
  onSelect?: (selected: boolean) => void
  onDelete?: () => void
}

export function AudioCard({ audio, selected, onSelect, onDelete }: Props) {
  const [waveform, setWaveform] = useState<string | null>(null)
  const [audioUrl, setAudioUrl] = useState<string | null>(null)
  const [playing, setPlaying] = useState(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  useEffect(() => {
    let cancelled = false
    window.scissor.library.readAsBase64(audio.waveformRel).then((r) => {
      if (cancelled) return
      if (r.ok && r.base64) setWaveform(`data:${r.mime};base64,${r.base64}`)
    })
    return () => {
      cancelled = true
    }
  }, [audio.waveformRel])

  async function togglePlay(): Promise<void> {
    if (!audioUrl) {
      const r = await window.scissor.library.readAsBase64(audio.audioRel)
      if (!r.ok || !r.base64) return
      const bin = atob(r.base64)
      const arr = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
      const blob = new Blob([arr], { type: r.mime || 'audio/mp4' })
      setAudioUrl(URL.createObjectURL(blob))
      return
    }
    const el = audioRef.current
    if (!el) return
    if (el.paused) {
      el.play().catch(() => undefined)
      setPlaying(true)
    } else {
      el.pause()
      setPlaying(false)
    }
  }

  useEffect(() => {
    return () => {
      if (audioUrl) URL.revokeObjectURL(audioUrl)
    }
  }, [audioUrl])

  // url 准备好后自动播
  useEffect(() => {
    if (audioUrl && audioRef.current) {
      audioRef.current.play().catch(() => undefined)
      setPlaying(true)
    }
  }, [audioUrl])

  return (
    <div className={`audio-card ${selected ? 'selected' : ''}`} onClick={() => onSelect?.(!selected)}>
      <div className="audio-card-wave">
        {waveform ? <img src={waveform} alt="" draggable={false} /> : <div className="audio-card-loading">···</div>}
        <button
          type="button"
          className="audio-card-play"
          onClick={(e) => {
            e.stopPropagation()
            togglePlay()
          }}
        >
          {playing ? '❚❚' : '▶'}
        </button>
        {audioUrl && <audio ref={audioRef} src={audioUrl} onEnded={() => setPlaying(false)} />}
      </div>
      <div className="audio-card-meta">
        <div className="audio-card-label" title={audio.label}>
          {audio.label}
        </div>
        <div className="audio-card-row">
          <span>{audio.durationSec.toFixed(1)}s</span>
          {onDelete && (
            <button
              type="button"
              className="del-btn small"
              onClick={(e) => {
                e.stopPropagation()
                onDelete()
              }}
            >
              ×
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
