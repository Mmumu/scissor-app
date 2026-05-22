import { useCallback, useEffect, useRef, useState } from 'react'
import type { ObfuscationOptions } from '../../../shared/obfuscation'

type InsertSide = 'top' | 'bottom' | 'left' | 'right'
type InsertPosition = { side: InsertSide; offsetPx: number }

type Props = {
  mode: 'transform' | 'stitch'
  mainPath: string | null
  obfuscation: ObfuscationOptions
  insertPath?: string | null
  insertSizePx?: number
  insertPositions?: InsertPosition[]
  /** 主视频时长（秒），用于预览起点 slider 范围 */
  durationSec?: number | null
  disabled?: boolean
}

/**
 * 按需 2 秒预览。
 * - 用户点"生成预览"按钮 → 主进程渲染 → 返回 base64 → 前端转 Blob URL 播放
 * - 切换主视频或参数后预览自动失效（视觉上保留旧帧但加 stale 标记）
 */
export function PreviewPanel({
  mode,
  mainPath,
  obfuscation,
  insertPath,
  insertSizePx,
  insertPositions,
  durationSec,
  disabled = false
}: Props) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [blobUrl, setBlobUrl] = useState<string | null>(null)
  const [stale, setStale] = useState(false)
  const [startSec, setStartSec] = useState(0)
  const lastBlobRef = useRef<string | null>(null)

  // 参数或源变更 → 标记 stale
  useEffect(() => {
    if (blobUrl) setStale(true)
  }, [mainPath, mode, insertPath, insertSizePx, insertPositions, obfuscation, blobUrl])

  // 切换主视频时重置起点
  useEffect(() => {
    setStartSec(0)
  }, [mainPath])

  useEffect(() => {
    return () => {
      if (lastBlobRef.current) URL.revokeObjectURL(lastBlobRef.current)
    }
  }, [])

  const generate = useCallback(async () => {
    if (!mainPath || busy) return
    if (mode === 'stitch' && !insertPath) {
      setErr('请先选择插入视频')
      return
    }
    setBusy(true)
    setErr('')
    try {
      const r = await window.scissor.renderPreview({
        mode,
        mainPath,
        obfuscation,
        startSec: startSec || undefined,
        durationSec: 2,
        insertPath: insertPath ?? undefined,
        insertSizePx,
        insertPositions
      })
      if (!r.ok || !r.base64) {
        setErr(r.error || '预览失败')
        return
      }
      const bin = atob(r.base64)
      const arr = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
      const blob = new Blob([arr], { type: r.mime || 'video/mp4' })
      const url = URL.createObjectURL(blob)
      if (lastBlobRef.current) URL.revokeObjectURL(lastBlobRef.current)
      lastBlobRef.current = url
      setBlobUrl(url)
      setStale(false)
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusy(false)
    }
  }, [mainPath, mode, insertPath, insertSizePx, insertPositions, obfuscation, startSec, busy])

  const ready = !!mainPath && (mode !== 'stitch' || !!insertPath)
  const maxStart = Math.max(0, (durationSec ?? 0) - 3)

  return (
    <div className="preview-panel">
      <div className="preview-panel-head">
        <span className="preview-panel-title">2 秒预览</span>
        {stale && blobUrl && <span className="preview-panel-stale">参数已变，请重新生成</span>}
      </div>
      <div className="preview-panel-body">
        {blobUrl ? (
          <video
            key={blobUrl}
            className="preview-panel-video"
            src={blobUrl}
            controls
            autoPlay
            loop
            muted={false}
          />
        ) : (
          <div className="preview-panel-placeholder">
            {ready ? '点击下方按钮生成预览' : mode === 'stitch' ? '请先选择主视频 + 插入视频' : '请先选择主视频'}
          </div>
        )}
      </div>

      {maxStart > 0 && (
        <div className="preview-panel-row">
          <span className="preview-panel-label">起点</span>
          <input
            type="range"
            min={0}
            max={maxStart}
            step={0.5}
            value={Math.min(startSec, maxStart)}
            onChange={(e) => setStartSec(Number(e.target.value))}
            disabled={disabled || busy}
            className="obf-slider"
          />
          <span className="obf-row-val">{startSec.toFixed(1)}s</span>
        </div>
      )}

      <div className="preview-panel-actions">
        <button
          type="button"
          className="preview-panel-btn"
          disabled={disabled || busy || !ready}
          onClick={generate}
        >
          {busy ? '渲染中…' : blobUrl ? (stale ? '重新生成' : '再生成一次') : '生成预览'}
        </button>
        {err && <span className="preview-panel-err">{err}</span>}
      </div>
    </div>
  )
}
