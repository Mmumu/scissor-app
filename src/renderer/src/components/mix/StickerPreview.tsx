import { useEffect, useMemo, useRef, useState } from 'react'
import type { StickerItem } from '../../../../shared/types'

const DEF_INSET = 20

type Props = {
  stickers: StickerItem[]
  /** 输出画布像素尺寸（导出时的真实大小） */
  targetDims: { w: number; h: number }
  /** 已解析好的背景图 dataURL（首帧或缩略图）。调用方负责解析；可空 */
  bgUrl?: string | null
  /** 任一贴图属性变化时回调 */
  onChange: (id: string, patch: Partial<StickerItem>) => void
}

type ImageDims = { w: number; h: number }

function inset(s: StickerItem, k: 'insetTop' | 'insetRight' | 'insetBottom' | 'insetLeft'): number {
  const v = s[k]
  return Math.max(0, Math.round(typeof v === 'number' && Number.isFinite(v) ? v : DEF_INSET))
}

type Placed = {
  left: number
  top: number
  width: number
  height: number
  /** march-lr 模式下：横向终点 left（startLeft → endLeft 走一遍） */
  marchEndLeft?: number
}

function placeSticker(
  s: StickerItem,
  target: { w: number; h: number },
  natural: ImageDims | undefined
): Placed | null {
  if (!natural) return null
  // 与导出端同公式：widthFrac>0 时按 target.w 计算宽，且取偶数；高度按图原始比例
  let width: number
  if ((s.widthFrac ?? 0) > 0) {
    const f = Math.min(0.95, Math.max(0.02, s.widthFrac))
    width = Math.max(4, Math.round((target.w * f) / 2) * 2)
  } else {
    width = natural.w
  }
  const height = Math.max(1, Math.round((width * natural.h) / Math.max(1, natural.w)))

  // —— march-lr：贴画面左右底三条边，从 (0, H-h) 走到 (W-w, H-h) ——
  if (s.motion === 'march-lr') {
    const startLeft = 0
    const endLeft = Math.max(0, target.w - width)
    const top = Math.max(0, target.h - height)
    return { left: startLeft, top, width, height, marchEndLeft: endLeft }
  }

  let left = 0
  let top = 0
  switch (s.anchor) {
    case 'top-left':
      left = inset(s, 'insetLeft')
      top = inset(s, 'insetTop')
      break
    case 'top-right':
      left = target.w - width - inset(s, 'insetRight')
      top = inset(s, 'insetTop')
      break
    case 'bottom-left':
      left = inset(s, 'insetLeft')
      top = target.h - height - inset(s, 'insetBottom')
      break
    case 'bottom-right':
      left = target.w - width - inset(s, 'insetRight')
      top = target.h - height - inset(s, 'insetBottom')
      break
    case 'center':
      left = Math.round((target.w - width) / 2)
      top = Math.round((target.h - height) / 2)
      break
    case 'custom':
      left = Math.round(s.customX)
      top = Math.round(s.customY)
      break
  }
  return { left, top, width, height }
}

// 画布最大边长（高度/宽度任意一边都不会超过它）
const PREVIEW_MAX_LONG_EDGE = 360
const PREVIEW_MIN_W = 120

export function StickerPreview({ stickers, targetDims, bgUrl, onChange }: Props) {
  const [imgDims, setImgDims] = useState<Map<string, ImageDims>>(new Map())
  const [imgUrls, setImgUrls] = useState<Map<string, string>>(new Map())
  const rootRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [wrapWidth, setWrapWidth] = useState(0)
  const [scale, setScale] = useState(1)
  const [draggingId, setDraggingId] = useState<string | null>(null)

  // 监听包裹容器宽度，使预览画布跟随右栏宽度变化
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const update = (): void => setWrapWidth(el.clientWidth)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // 画布尺寸：基于容器宽度 + 目标比例 + 长边上限算出
  const canvasBox = useMemo(() => {
    const aspect = targetDims.h > 0 ? targetDims.w / targetDims.h : 16 / 9
    // 容器内可用宽度，留 10px 余量给 padding；尚未测量时给个默认
    const avail = wrapWidth > 0 ? Math.max(PREVIEW_MIN_W, wrapWidth - 10) : 240
    let w = Math.min(avail, PREVIEW_MAX_LONG_EDGE)
    let h = w / aspect
    if (h > PREVIEW_MAX_LONG_EDGE) {
      h = PREVIEW_MAX_LONG_EDGE
      w = h * aspect
      if (w > avail) {
        w = avail
        h = w / aspect
      }
    }
    return { w: Math.round(w), h: Math.round(h) }
  }, [targetDims.w, targetDims.h, wrapWidth])

  // 背景图直接由调用方传入 dataURL；为空时画布显示占位

  // 贴图绝对路径 -> base64
  useEffect(() => {
    let cancelled = false
    const tasks = stickers.map(async (s) => {
      if (!s.imagePath || imgUrls.has(s.imagePath)) return
      const data = await window.scissor.readStickerPreview(s.imagePath)
      if (cancelled || !data) return
      setImgUrls((prev) => {
        const n = new Map(prev)
        n.set(s.imagePath, data)
        return n
      })
    })
    void Promise.all(tasks)
    return () => {
      cancelled = true
    }
  }, [stickers, imgUrls])

  function handleImgLoad(path: string, e: React.SyntheticEvent<HTMLImageElement>): void {
    const el = e.currentTarget
    setImgDims((prev) => {
      const n = new Map(prev)
      n.set(path, { w: el.naturalWidth, h: el.naturalHeight })
      return n
    })
  }

  // scale = 预览画布像素 / 目标真实像素
  useEffect(() => {
    if (targetDims.w > 0) setScale(canvasBox.w / targetDims.w)
  }, [canvasBox.w, targetDims.w])

  // 添加第一张贴图时自动滚动到预览面板，让用户立刻看到
  const prevCount = useRef(stickers.length)
  useEffect(() => {
    if (stickers.length > 0 && prevCount.current === 0) {
      rootRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
    prevCount.current = stickers.length
  }, [stickers.length])

  // 拖拽位置：开始记录（鼠标点 + 当前位置 px）
  function handleStickerMouseDown(s: StickerItem, e: React.MouseEvent): void {
    // march-lr 模式下位置由表达式决定，不能拖
    if (s.motion === 'march-lr') return
    e.preventDefault()
    e.stopPropagation()
    const dims = imgDims.get(s.imagePath)
    if (!dims) return
    const placed = placeSticker(s, targetDims, dims)
    if (!placed) return
    const startMouseX = e.clientX
    const startMouseY = e.clientY
    const startLeft = placed.left
    const startTop = placed.top
    const w = placed.width
    const h = placed.height
    setDraggingId(s.id)

    const onMove = (ev: MouseEvent): void => {
      const dxPx = (ev.clientX - startMouseX) / scale
      const dyPx = (ev.clientY - startMouseY) / scale
      const nextX = Math.max(0, Math.min(targetDims.w - w, Math.round(startLeft + dxPx)))
      const nextY = Math.max(0, Math.min(targetDims.h - h, Math.round(startTop + dyPx)))
      onChange(s.id, { anchor: 'custom', customX: nextX, customY: nextY })
    }
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      setDraggingId(null)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const placed = useMemo(() => {
    return stickers.map((s) => {
      const dims = imgDims.get(s.imagePath)
      const p = placeSticker(s, targetDims, dims)
      return { sticker: s, placed: p, url: imgUrls.get(s.imagePath) }
    })
  }, [stickers, imgDims, imgUrls, targetDims])

  return (
    <div className="sticker-preview" ref={rootRef}>
      <div className="sticker-preview-head">
        <strong>贴图位置预览</strong>
        <span className="sticker-preview-hint">
          画布 {targetDims.w}×{targetDims.h} · 拖动贴图调整位置（自动切到「自定义」锚点）
        </span>
      </div>
      <div
        ref={containerRef}
        className="sticker-preview-canvas"
        style={{ width: `${canvasBox.w}px`, height: `${canvasBox.h}px` }}
      >
        {bgUrl ? (
          <img src={bgUrl} alt="" className="sticker-preview-bg" draggable={false} />
        ) : (
          <div className="sticker-preview-bg-empty">（无背景图，仅作位置参考）</div>
        )}

        {/* 隐藏的预加载 img：拿到 naturalWidth/Height 才能算贴图尺寸，且能解释解码失败 */}
        {placed.map(({ sticker, url }) =>
          url && !imgDims.get(sticker.imagePath) ? (
            <img
              key={`probe-${sticker.id}`}
              src={url}
              alt=""
              style={{ position: 'absolute', visibility: 'hidden', width: 0, height: 0 }}
              onLoad={(e) => handleImgLoad(sticker.imagePath, e)}
            />
          ) : null
        )}

        {placed.map(({ sticker, placed: p, url }) => {
          if (!url || !p) return null
          const isMarch = sticker.motion === 'march-lr' && p.marchEndLeft != null
          // march-lr：左侧用 CSS keyframes 动画把贴图从 startLeft 拉到 endLeft，循环 6s
          const baseStyle: React.CSSProperties = {
            top: `${p.top * scale}px`,
            width: `${p.width * scale}px`,
            height: `${p.height * scale}px`,
            opacity: sticker.opacity
          }
          if (isMarch) {
            const startPx = p.left * scale
            const endPx = (p.marchEndLeft as number) * scale
            return (
              <span key={sticker.id} className="sticker-preview-march-track" style={{ pointerEvents: 'none' }}>
                {/* 路径示意线（从起点到终点的虚线） */}
                <span
                  className="sticker-preview-march-path"
                  style={{
                    left: `${startPx + (p.width * scale) / 2}px`,
                    top: `${(p.top + p.height / 2) * scale}px`,
                    width: `${endPx - startPx}px`
                  }}
                />
                <img
                  src={url}
                  draggable={false}
                  className="sticker-preview-item march"
                  style={
                    {
                      ...baseStyle,
                      left: `${startPx}px`,
                      ['--march-from' as string]: `0px`,
                      ['--march-to' as string]: `${endPx - startPx}px`
                    } as React.CSSProperties
                  }
                  title="底部从左到右匀速移动（导出时根据生效时段计算）"
                />
              </span>
            )
          }
          return (
            <img
              key={sticker.id}
              src={url}
              draggable={false}
              className={`sticker-preview-item ${draggingId === sticker.id ? 'dragging' : ''}`}
              style={{
                ...baseStyle,
                left: `${p.left * scale}px`
              }}
              onMouseDown={(e) => handleStickerMouseDown(sticker, e)}
              title={`${sticker.anchor === 'custom' ? '自定义位置' : sticker.anchor} · 拖动调整`}
            />
          )
        })}
      </div>

      {stickers.length > 0 && (
        <div className="sticker-preview-list">
          {stickers.map((s, i) => {
            const p = placed.find((x) => x.sticker.id === s.id)?.placed
            const isMarch = s.motion === 'march-lr'
            return (
              <div key={s.id} className="sticker-preview-row">
                <span className="sticker-preview-row-idx">#{i + 1}</span>
                <span className="sticker-preview-row-anchor">
                  {isMarch ? '底部·走过' : s.anchor}
                </span>
                {p ? (
                  <span className="sticker-preview-row-pos">
                    {isMarch && p.marchEndLeft != null
                      ? `x=${p.left}→${p.marchEndLeft} y=${p.top} · ${p.width}×${p.height}px`
                      : `x=${p.left} y=${p.top} · ${p.width}×${p.height}px`}
                  </span>
                ) : (
                  <span className="sticker-preview-row-pos muted">等图片加载</span>
                )}
                {!isMarch && s.anchor === 'custom' && (
                  <button
                    type="button"
                    className="ghost-btn xs"
                    onClick={() => onChange(s.id, { anchor: 'top-right' })}
                    title="重置回右上角默认位置"
                  >
                    回右上
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
