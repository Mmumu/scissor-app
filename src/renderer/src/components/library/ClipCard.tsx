import { useEffect, useState } from 'react'
import type { ClipMeta } from '../../../../shared/library'

type Props = {
  clip: ClipMeta
  /** 用于在卡片左上角显示来源颜色块（按 importId 映射） */
  importColor: string
  selected?: boolean
  onSelect?: (selected: boolean) => void
  onDelete?: () => void
}

export function ClipCard({ clip, importColor, selected, onSelect, onDelete }: Props) {
  const [thumb, setThumb] = useState<string | null>(null)
  const [hovering, setHovering] = useState(false)
  const [videoUrl, setVideoUrl] = useState<string | null>(null)

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

  // hover 时按需加载视频（避免一次性下载几十个）
  useEffect(() => {
    if (!hovering || videoUrl) return
    let cancelled = false
    window.scissor.library.readAsBase64(clip.videoRel).then((r) => {
      if (cancelled) return
      if (r.ok && r.base64) {
        const bin = atob(r.base64)
        const arr = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
        const blob = new Blob([arr], { type: r.mime || 'video/mp4' })
        setVideoUrl(URL.createObjectURL(blob))
      }
    })
    return () => {
      cancelled = true
    }
  }, [hovering, videoUrl, clip.videoRel])

  useEffect(() => {
    return () => {
      if (videoUrl) URL.revokeObjectURL(videoUrl)
    }
  }, [videoUrl])

  return (
    <div
      className={`clip-card ${selected ? 'selected' : ''}`}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      onClick={() => onSelect?.(!selected)}
    >
      <div className="clip-card-thumb">
        {hovering && videoUrl ? (
          <video src={videoUrl} autoPlay muted loop playsInline />
        ) : thumb ? (
          <img src={thumb} alt="" draggable={false} />
        ) : (
          <div className="clip-card-thumb-loading">加载中…</div>
        )}
        <div className="clip-card-badge clip-card-dur">{clip.durationSec.toFixed(1)}s</div>
        <div className="clip-card-badge clip-card-source" style={{ background: importColor }}>
          #{clip.index + 1}
        </div>
        {selected && <div className="clip-card-checkmark">✓</div>}
      </div>
      <div className="clip-card-meta">
        <span className="clip-card-dims">
          {clip.width}×{clip.height}
        </span>
        {clip.hasAudio && <span className="clip-card-audio">🔊</span>}
        {onDelete && (
          <button
            type="button"
            className="del-btn small"
            onClick={(e) => {
              e.stopPropagation()
              onDelete()
            }}
            title="删除"
          >
            ×
          </button>
        )}
      </div>
    </div>
  )
}
