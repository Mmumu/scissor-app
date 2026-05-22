import { useEffect, useMemo, useRef } from 'react'

export type InsertSide = 'top' | 'bottom' | 'left' | 'right'
export type InsertPosition = { side: InsertSide; offsetPx: number }
export type StripMode =
  | 'top'
  | 'bottom'
  | 'left'
  | 'right'
  | 'top-bottom'
  | 'left-right'

const MODE_ORDER: { id: StripMode; label: string }[] = [
  { id: 'top-bottom', label: '上 + 下' },
  { id: 'left-right', label: '左 + 右' },
  { id: 'top', label: '仅上' },
  { id: 'bottom', label: '仅下' },
  { id: 'left', label: '仅左' },
  { id: 'right', label: '仅右' }
]

export function modeFromPositions(positions: InsertPosition[]): StripMode {
  const sides = new Set(positions.map((p) => p.side))
  if (sides.has('top') && sides.has('bottom')) return 'top-bottom'
  if (sides.has('left') && sides.has('right')) return 'left-right'
  if (sides.has('top')) return 'top'
  if (sides.has('bottom')) return 'bottom'
  if (sides.has('left')) return 'left'
  if (sides.has('right')) return 'right'
  return 'top-bottom'
}

export function modeToPositions(mode: StripMode, offsets: Partial<Record<InsertSide, number>>): InsertPosition[] {
  const off = (s: InsertSide) => Math.max(0, offsets[s] ?? 0)
  switch (mode) {
    case 'top':
      return [{ side: 'top', offsetPx: off('top') }]
    case 'bottom':
      return [{ side: 'bottom', offsetPx: off('bottom') }]
    case 'left':
      return [{ side: 'left', offsetPx: off('left') }]
    case 'right':
      return [{ side: 'right', offsetPx: off('right') }]
    case 'top-bottom':
      return [
        { side: 'top', offsetPx: off('top') },
        { side: 'bottom', offsetPx: off('bottom') }
      ]
    case 'left-right':
      return [
        { side: 'left', offsetPx: off('left') },
        { side: 'right', offsetPx: off('right') }
      ]
  }
}

type Props = {
  positions: InsertPosition[]
  sizePx: number
  videoDims?: { w: number; h: number } | null
  onChange: (next: { positions: InsertPosition[]; sizePx: number }) => void
  disabled?: boolean
}

export function StitchInsertPicker({ positions, sizePx, videoDims, onChange, disabled }: Props) {
  const mode = useMemo(() => modeFromPositions(positions), [positions])
  const offsets = useMemo(() => {
    const o: Partial<Record<InsertSide, number>> = {}
    for (const p of positions) o[p.side] = p.offsetPx
    return o
  }, [positions])

  const setMode = (next: StripMode) => {
    onChange({ positions: modeToPositions(next, offsets), sizePx })
  }
  const setOffset = (side: InsertSide, value: number) => {
    const nextOffsets = { ...offsets, [side]: Math.max(0, value) }
    onChange({ positions: modeToPositions(mode, nextOffsets), sizePx })
  }
  const setSize = (v: number) => {
    onChange({ positions, sizePx: Math.max(1, Math.min(20, v)) })
  }

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const aspect = videoDims ? videoDims.w / videoDims.h : 9 / 16

  // ── 重绘 canvas ────────────────────────────────
  useEffect(() => {
    const c = canvasRef.current
    if (!c) return
    const ctx = c.getContext('2d')
    if (!ctx) return

    const CW = c.width
    const CH = c.height

    // 背景
    const grad = ctx.createLinearGradient(0, 0, CW, CH)
    grad.addColorStop(0, '#1a1a2e')
    grad.addColorStop(1, '#16213e')
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, CW, CH)

    // 网格
    ctx.strokeStyle = 'rgba(255,255,255,0.04)'
    ctx.lineWidth = 1
    for (let x = 0; x < CW; x += 40) {
      ctx.beginPath()
      ctx.moveTo(x, 0)
      ctx.lineTo(x, CH)
      ctx.stroke()
    }
    for (let y = 0; y < CH; y += 40) {
      ctx.beginPath()
      ctx.moveTo(0, y)
      ctx.lineTo(CW, y)
      ctx.stroke()
    }

    // 视频帧框
    ctx.strokeStyle = 'rgba(255,255,255,0.15)'
    ctx.strokeRect(0.5, 0.5, CW - 1, CH - 1)
    ctx.fillStyle = 'rgba(255,255,255,0.5)'
    ctx.font = '10px sans-serif'
    ctx.fillText(`主视频 (${videoDims ? `${videoDims.w}×${videoDims.h}` : '比例预估'})`, 6, 14)

    // 条带：按 sizePx 在视频坐标系画 → 映射到 canvas
    // 视频高度 H → canvas H 缩放比 = CH / videoH
    if (videoDims) {
      const scaleY = CH / videoDims.h
      const scaleX = CW / videoDims.w
      ctx.fillStyle = 'rgba(255, 180, 80, 0.85)'

      for (const pos of positions) {
        if (pos.side === 'top') {
          const stripH = Math.max(1, sizePx * scaleY)
          const offY = pos.offsetPx * scaleY
          ctx.fillRect(0, offY, CW, stripH)
        } else if (pos.side === 'bottom') {
          const stripH = Math.max(1, sizePx * scaleY)
          const offY = pos.offsetPx * scaleY
          ctx.fillRect(0, CH - stripH - offY, CW, stripH)
        } else if (pos.side === 'left') {
          const stripW = Math.max(1, sizePx * scaleX)
          const offX = pos.offsetPx * scaleX
          ctx.fillRect(offX, 0, stripW, CH)
        } else if (pos.side === 'right') {
          const stripW = Math.max(1, sizePx * scaleX)
          const offX = pos.offsetPx * scaleX
          ctx.fillRect(CW - stripW - offX, 0, stripW, CH)
        }
      }
    } else {
      // 没尺寸时按近似比例画
      const approxScale = Math.max(2, sizePx * 2)
      ctx.fillStyle = 'rgba(255, 180, 80, 0.85)'
      for (const pos of positions) {
        if (pos.side === 'top') ctx.fillRect(0, pos.offsetPx, CW, approxScale)
        if (pos.side === 'bottom') ctx.fillRect(0, CH - approxScale - pos.offsetPx, CW, approxScale)
        if (pos.side === 'left') ctx.fillRect(pos.offsetPx, 0, approxScale, CH)
        if (pos.side === 'right') ctx.fillRect(CW - approxScale - pos.offsetPx, 0, approxScale, CH)
      }
    }

    // 提示
    if (videoDims && sizePx <= 2) {
      ctx.fillStyle = 'rgba(255, 180, 80, 0.9)'
      ctx.font = '11px sans-serif'
      ctx.fillText(`(实际仅 ${sizePx}px，画面已放大显示)`, 6, CH - 8)
    }
  }, [positions, sizePx, videoDims])

  // canvas 尺寸根据 aspect
  const CW = 360
  const CH = Math.max(120, Math.min(540, Math.round(CW / aspect)))

  return (
    <div className="stitch-picker">
      <div className="stitch-picker-canvas-wrap">
        <canvas ref={canvasRef} width={CW} height={CH} className="stitch-picker-canvas" />
      </div>
      <div className="stitch-picker-controls">
        <div className="stitch-picker-row">
          <span className="stitch-picker-label">条带位置</span>
          <div className="stitch-picker-pills">
            {MODE_ORDER.map((m) => (
              <button
                key={m.id}
                type="button"
                className={`stitch-picker-pill ${mode === m.id ? 'active' : ''}`}
                disabled={disabled}
                onClick={() => setMode(m.id)}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>

        <div className="stitch-picker-row">
          <span className="stitch-picker-label">条带宽度</span>
          <input
            type="range"
            min={1}
            max={20}
            step={1}
            value={sizePx}
            onChange={(e) => setSize(Number(e.target.value))}
            disabled={disabled}
            className="obf-slider"
          />
          <span className="obf-row-val">{sizePx}px</span>
        </div>

        {positions.map((p) => (
          <div key={p.side} className="stitch-picker-row">
            <span className="stitch-picker-label">距 {sideLabel(p.side)} 边距</span>
            <input
              type="number"
              min={0}
              step={1}
              value={p.offsetPx}
              onChange={(e) => setOffset(p.side, Number(e.target.value))}
              disabled={disabled}
              className="stitch-picker-offset"
            />
            <span className="obf-row-val">px</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function sideLabel(s: InsertSide): string {
  return s === 'top' ? '上' : s === 'bottom' ? '下' : s === 'left' ? '左' : '右'
}
