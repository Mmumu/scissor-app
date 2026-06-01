import { useEffect, useState } from 'react'
import type { ClipMeta } from '../../../../shared/library'

type Props = {
  clip: ClipMeta
  /** 用于在卡片左上角显示来源颜色块（按 importId 映射） */
  importColor: string
  selected?: boolean
  /** 把原始鼠标事件透出，方便父组件做 shift / cmd 范围选择 */
  onSelect?: (e: React.MouseEvent) => void
  onDelete?: () => void
  onRename?: (clip: ClipMeta, name: string) => void
}

export function ClipCard({ clip, importColor, selected, onSelect, onDelete, onRename }: Props) {
  const [thumb, setThumb] = useState<string | null>(null)
  const [hovering, setHovering] = useState(false)
  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  const [isEditing, setIsEditing] = useState(false)
  const [editName, setEditName] = useState(clip.name || '')

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
      onClick={(e) => onSelect?.(e)}
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
        {isEditing ? (
          <input
            className="clip-card-name-input"
            autoFocus
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            onBlur={() => {
              setIsEditing(false)
              if (editName !== (clip.name || '')) {
                onRename?.(clip, editName)
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.currentTarget.blur()
              } else if (e.key === 'Escape') {
                setEditName(clip.name || '')
                setIsEditing(false)
              }
            }}
            onClick={(e) => e.stopPropagation()}
            placeholder="片段名称"
          />
        ) : (
          <span
            className="clip-card-name"
            onDoubleClick={(e) => {
              if (onRename) {
                e.stopPropagation()
                setIsEditing(true)
                setEditName(clip.name || '')
              }
            }}
            title={clip.name ? '双击重命名' : '双击添加名称'}
          >
            {clip.name || <span className="clip-card-dims">{clip.width}×{clip.height}</span>}
          </span>
        )}
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
