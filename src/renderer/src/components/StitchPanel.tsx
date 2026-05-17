import { useCallback, useEffect, useRef, useState } from 'react'
import type { StickerItem } from '../../../shared/types'

// Canvas-based sticker preview — renders a frame matching video aspect ratio with sticker overlaid
function StickerPreview({ sticker, aspectRatio = 9 / 16 }: { sticker: StickerItem; aspectRatio?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [imgEl, setImgEl] = useState<HTMLImageElement | null>(null)
  const [loadState, setLoadState] = useState<'loading' | 'loaded' | 'error'>('loading')

  // Fixed canvas width; height derived from actual aspect ratio
  const CW = 320
  const CH = Math.round(CW / aspectRatio)

  // Load sticker image once per path
  useEffect(() => {
    setImgEl(null)
    setLoadState('loading')
    window.scissor.readStickerPreview(sticker.imagePath).then(b64 => {
      if (!b64) {
        setLoadState('error')
        return
      }
      const img = new Image()
      img.onload = () => { setImgEl(img); setLoadState('loaded') }
      img.onerror = () => setLoadState('error')
      img.src = b64
    })
  }, [sticker.imagePath])

  // Redraw whenever sticker params, image, or aspect ratio change
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const W = canvas.width
    const H = canvas.height

    // Background — simulated video frame with gradient
    const grad = ctx.createLinearGradient(0, 0, W, H)
    grad.addColorStop(0, '#1a1a2e')
    grad.addColorStop(1, '#16213e')
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, W, H)

    // Grid lines
    ctx.strokeStyle = 'rgba(255,255,255,0.05)'
    ctx.lineWidth = 1
    for (let x = 0; x < W; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke() }
    for (let y = 0; y < H; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke() }

    // Ratio label
    const ratioLabel = aspectRatio < 1
      ? `${Math.round(9 / aspectRatio * 9)}:16`
      : `${Math.round(aspectRatio * 9)}:9`
    ctx.fillStyle = 'rgba(255,255,255,0.15)'
    ctx.font = '10px sans-serif'
    ctx.fillText(`预览帧 (${Math.round(W)}x${Math.round(H)})`, 6, 14)

    if (loadState !== 'loaded' || !imgEl) {
      ctx.font = '12px sans-serif'
      ctx.textAlign = 'center'
      if (loadState === 'error') {
        ctx.fillStyle = 'rgba(255,100,100,0.8)'
        ctx.fillText('图片加载失败', W / 2, H / 2 - 8)
        ctx.fillStyle = 'rgba(255,100,100,0.5)'
        ctx.font = '10px sans-serif'
        ctx.fillText('(文件过大或格式不支持)', W / 2, H / 2 + 10)
      } else {
        ctx.fillStyle = 'rgba(255,255,255,0.3)'
        ctx.fillText('加载中…', W / 2, H / 2)
      }
      ctx.textAlign = 'left'
      return
    }

    // Sticker size: widthFrac is relative to video width → canvas W
    const frac = Math.min(0.95, Math.max(0.02, sticker.widthFrac ?? 0.2))
    const sw = Math.round(W * frac)
    const sh = Math.round(sw * (imgEl.naturalHeight / imgEl.naturalWidth))

    // Scale insets: treat inset values as px on a 1080p-wide (or 1080p-tall for portrait) reference
    // Reference width = max(W logical) which maps to video width
    const scaleX = W / 1920
    const scaleY = H / (1920 / aspectRatio)
    const insetT = Math.round((sticker.insetTop ?? 0) * scaleY)
    const insetB = Math.round((sticker.insetBottom ?? 0) * scaleY)
    const insetL = Math.round((sticker.insetLeft ?? 0) * scaleX)
    const insetR = Math.round((sticker.insetRight ?? 0) * scaleX)

    let dx = 0, dy = 0
    switch (sticker.anchor) {
      case 'top-left':     dx = insetL;          dy = insetT;           break
      case 'top-right':    dx = W - sw - insetR; dy = insetT;           break
      case 'bottom-left':  dx = insetL;          dy = H - sh - insetB;  break
      case 'bottom-right': dx = W - sw - insetR; dy = H - sh - insetB;  break
      case 'center':       dx = (W - sw) / 2;    dy = (H - sh) / 2;     break
      case 'custom': {
        dx = Math.round((sticker.customX ?? 0) * scaleX)
        dy = Math.round((sticker.customY ?? 0) * scaleY)
        break
      }
    }

    ctx.globalAlpha = Math.min(1, Math.max(0, sticker.opacity ?? 1))
    ctx.drawImage(imgEl, dx, dy, sw, sh)
    ctx.globalAlpha = 1

    // Dashed border
    ctx.strokeStyle = 'rgba(120,200,255,0.7)'
    ctx.lineWidth = 1
    ctx.setLineDash([3, 3])
    ctx.strokeRect(dx, dy, sw, sh)
    ctx.setLineDash([])

    // Info label
    ctx.fillStyle = 'rgba(120,200,255,0.9)'
    ctx.font = '9px sans-serif'
    ctx.fillText(`${Math.round(frac * 100)}%  α${Math.round((sticker.opacity ?? 1) * 100)}%`, dx + 2, Math.max(dy + sh - 3, dy + 10))
  }, [imgEl, loadState, aspectRatio, CW, CH, sticker.anchor, sticker.widthFrac, sticker.opacity, sticker.insetTop, sticker.insetBottom, sticker.insetLeft, sticker.insetRight, sticker.customX, sticker.customY])

  return (
    <canvas
      ref={canvasRef}
      width={CW}
      height={CH}
      style={{ width: '100%', maxWidth: CW, height: 'auto', borderRadius: 6, marginTop: 8, display: 'block', border: '1px solid rgba(255,255,255,0.08)' }}
    />
  )
}
function basename(p: string) {
  return p.split(/[/\\]/).pop() ?? p
}

type ProgressInfo = { file: string; time: string; speed: string; raw: string }
type InsertSide = 'top' | 'bottom' | 'left' | 'right'
type InsertPosition = { side: InsertSide; offsetPx: number }

function timeStringToSeconds(timeStr: string) {
  if (!timeStr) return 0
  const parts = timeStr.split(':')
  if (parts.length !== 3) return 0
  return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2])
}

export function StitchPanel({ ffmpegOk }: { ffmpegOk: boolean }) {
  const [mainPaths, setMainPaths] = useState<string[]>([])
  const [insertPath, setInsertPath] = useState<string | null>(null)
  
  const [insertSizePx, setInsertSizePx] = useState(1)
  const [insertPositions, setInsertPositions] = useState<InsertPosition[]>([
    { side: 'top', offsetPx: 0 },
    { side: 'bottom', offsetPx: 0 }
  ])

  const toggleSide = (side: InsertSide) => {
    setInsertPositions(prev => {
      const exists = prev.find(p => p.side === side)
      if (exists) {
        // Don't allow deselecting all
        if (prev.length <= 1) return prev
        return prev.filter(p => p.side !== side)
      }
      // When adding left/right, remove top/bottom (different axis) and vice versa
      const isVertical = side === 'top' || side === 'bottom'
      const filtered = prev.filter(p => {
        const pIsVertical = p.side === 'top' || p.side === 'bottom'
        return pIsVertical === isVertical
      })
      return [...filtered, { side, offsetPx: 0 }]
    })
  }

  const setOffsetPx = (side: InsertSide, val: number) => {
    setInsertPositions(prev => prev.map(p => p.side === side ? { ...p, offsetPx: val } : p))
  }

  const [status, setStatus] = useState<'idle' | 'processing' | 'done' | 'error'>('idle')
  const [videoDims, setVideoDims] = useState<{ w: number; h: number } | null>(null)
  
  // Advanced obfuscation options
  const [optFlip, setOptFlip] = useState(false)
  const [optColorNoise, setOptColorNoise] = useState(true)
  const [optAudioObf, setOptAudioObf] = useState(true)
  const [optSpeedJitter, setOptSpeedJitter] = useState(true)
  const [optTrimStart, setOptTrimStart] = useState(true)
  const [optHueSat, setOptHueSat] = useState(true)
  const [optCleanMeta, setOptCleanMeta] = useState(true)
  const [optBlurSharpen, setOptBlurSharpen] = useState(true)
  const [optAudioEQ, setOptAudioEQ] = useState(true)
  const [stickers, setStickers] = useState<StickerItem[]>([])
  const [bottomCoverRatio, setBottomCoverRatio] = useState(0)
  const [bottomCoverType, setBottomCoverType] = useState<'blur' | 'black' | 'crop'>('blur')
  const [processingPath, setProcessingPath] = useState<string | null>(null)
  const [currentDuration, setCurrentDuration] = useState<number>(0)
  const [progressInfo, setProgressInfo] = useState<ProgressInfo | null>(null)
  const [errMsg, setErrMsg] = useState('')

  useEffect(() => {
    return window.scissor.onFfmpegProgress((info) => {
      setProgressInfo(info)
    })
  }, [])

  const pickMainVideos = useCallback(async () => {
    if (status === 'processing') return
    const paths = await window.scissor.pickVideos()
    if (paths && paths.length > 0) {
      setMainPaths((prev) => {
        const next = [...new Set([...prev, ...paths])]
        if (next.length > 50) {
          setErrMsg('提示：主视频最多支持同时添加 50 个，已自动截断超出的文件。')
          return next.slice(0, 50)
        }
        return next
      })
      // Read dims from the first selected video for preview
      if (!videoDims) {
        const d = await window.scissor.getVideoDims(paths[0])
        if (d.ok && d.w && d.h) setVideoDims({ w: d.w, h: d.h })
      }
    }
  }, [status, videoDims])

  const pickInsertVideo = useCallback(async () => {
    if (status === 'processing') return
    const paths = await window.scissor.pickVideos()
    if (paths && paths.length > 0) {
      setInsertPath(paths[0])
    }
  }, [status])

  const removeMainPath = useCallback((p: string) => {
    if (status === 'processing') return
    setMainPaths((prev) => prev.filter((x) => x !== p))
  }, [status])

  const addSticker = async () => {
    const p = await window.scissor.pickImage()
    if (!p) return
    setStickers((prev) => [
      ...prev,
      {
        id: Math.random().toString(36).slice(2),
        imagePath: p,
        anchor: 'bottom-right',
        customX: 0,
        customY: 0,
        insetTop: 0,
        insetRight: 0,
        insetBottom: 0,
        insetLeft: 0,
        opacity: 1,
        widthFrac: 0.2,
        startSec: null,
        endSec: null
      }
    ])
  }

  const updateSticker = (id: string, patch: Partial<StickerItem>) => {
    setStickers((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)))
  }

  const removeSticker = (id: string) => {
    setStickers((prev) => prev.filter((s) => s.id !== id))
  }

  const runStitch = useCallback(async () => {
    if (mainPaths.length === 0 || !insertPath) return

    let outDirOrPath: string | undefined
    if (mainPaths.length > 1) {
      outDirOrPath = await window.scissor.pickDirectory()
      if (!outDirOrPath) return
    } else {
      const p = mainPaths[0]
      const ext = p.match(/\.(\w+)$/)?.[1] ?? 'mp4'
      const name = basename(p).replace(/\.\w+$/, '') + '_stitch.' + ext
      outDirOrPath = await window.scissor.pickSavePath(name)
      if (!outDirOrPath) return
    }

    setStatus('processing')
    setErrMsg('')
    setProgressInfo(null)

    try {
      if (mainPaths.length === 1) {
        setProcessingPath(mainPaths[0])
        const d = await window.scissor.ffprobeDuration(mainPaths[0])
        setCurrentDuration(d.durationSec || 0)
        const obfOpts = { flip: optFlip, colorNoise: optColorNoise, audioObf: optAudioObf, speedJitter: optSpeedJitter, trimStart: optTrimStart, hueSat: optHueSat, cleanMeta: optCleanMeta, blurSharpen: optBlurSharpen, audioEQ: optAudioEQ, bottomCoverRatio, bottomCoverType, stickers }
        const r = await window.scissor.stitchVideo(mainPaths[0], insertPath, outDirOrPath!, insertSizePx, insertPositions, obfOpts)
        if (!r.ok) throw new Error(r.error || '处理失败')
        setMainPaths([])
      } else {
        const outDir = outDirOrPath!.replace(/[/\\]$/, '')
        const pathsToProcess = [...mainPaths]
        for (const p of pathsToProcess) {
          setProcessingPath(p)
          const d = await window.scissor.ffprobeDuration(p)
          setCurrentDuration(d.durationSec || 0)
          const ext = p.match(/\.(\w+)$/)?.[1] ?? 'mp4'
          const name = basename(p).replace(/\.\w+$/, '') + '_stitch.' + ext
          const outPath = `${outDir}/${name}`
          const obfOpts = { flip: optFlip, colorNoise: optColorNoise, audioObf: optAudioObf, speedJitter: optSpeedJitter, trimStart: optTrimStart, hueSat: optHueSat, cleanMeta: optCleanMeta, blurSharpen: optBlurSharpen, audioEQ: optAudioEQ, bottomCoverRatio, bottomCoverType, stickers }
          const r = await window.scissor.stitchVideo(p, insertPath, outPath, insertSizePx, insertPositions, obfOpts)
          if (!r.ok) throw new Error(r.error || '处理失败')
          setMainPaths((prev) => prev.filter((x) => x !== p))
        }
      }
      setStatus('idle')
      setProcessingPath(null)
    } catch (e: any) {
      setStatus('error')
      setProcessingPath(null)
      setErrMsg(e.message || String(e))
    }
  }, [mainPaths, insertPath, insertSizePx, insertPositions, optFlip, optColorNoise, optAudioObf, optSpeedJitter, optTrimStart, optHueSat, optCleanMeta, optBlurSharpen, optAudioEQ, bottomCoverRatio, bottomCoverType, stickers])

  return (
    <div className="tab-panel-scroll dedupe-scroll">
      <section className="dedupe-panel">
        <div className="dedupe-head">
          <h2 className="dedupe-title">分割混剪 (无损过原创)</h2>
          <p className="dedupe-sub">
            用一段细微的「插入视频」替换主视频中间的同等像素画面。
            原比例无损裁剪上下（或左右）两端，中间无缝拼接视频 B，可改变画面全局特征过查重。
          </p>
        </div>

        <div className="dedupe-toolbar" style={{ display: 'flex', gap: '16px', alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: '300px', background: 'var(--bg1)', padding: '16px', borderRadius: '8px' }}>
            <h3 style={{ fontSize: '14px', marginBottom: '12px', color: 'var(--fg1)' }}>1. 视频 A (主视频, 支持批量)</h3>
            <button
              type="button"
              className="dedupe-btn"
              disabled={!ffmpegOk || status === 'processing'}
              onClick={pickMainVideos}
            >
              添加主视频
            </button>
            {mainPaths.length > 0 && (
              <ul className="source-video-list" style={{ marginTop: '12px', listStyle: 'none', padding: 0, maxHeight: '200px', overflowY: 'auto' }}>
                {mainPaths.map(p => {
                  let pct = 0
                  if (processingPath === p && progressInfo && currentDuration > 0) {
                    pct = Math.min(100, Math.round((timeStringToSeconds(progressInfo.time) / currentDuration) * 100))
                  }
                  return (
                  <li key={p} style={{ 
                    display: 'flex', 
                    alignItems: 'center', 
                    justifyContent: 'space-between',
                    padding: '6px 8px',
                    marginBottom: '6px',
                    background: processingPath === p ? 'rgba(0,255,100,0.1)' : 'var(--bg2)',
                    borderRadius: '4px',
                    position: 'relative',
                    overflow: 'hidden'
                  }}>
                    {processingPath === p && pct > 0 && (
                      <div style={{
                        position: 'absolute', left: 0, top: 0, bottom: 0,
                        width: `${pct}%`, background: 'rgba(0,255,100,0.15)',
                        transition: 'width 0.3s ease', zIndex: 0
                      }} />
                    )}
                    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, marginRight: '8px', zIndex: 1 }}>
                      <span style={{ fontSize: '12px', color: 'var(--fg1)', whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>
                        {basename(p)}
                      </span>
                      {processingPath === p && progressInfo && (() => {
                          const processedSec = timeStringToSeconds(progressInfo.time)
                          const speedNum = parseFloat(progressInfo.speed)
                          let remainText = ''
                          if (currentDuration > 0 && !isNaN(speedNum) && speedNum > 0 && processedSec < currentDuration) {
                            const remainSec = Math.ceil((currentDuration - processedSec) / speedNum)
                            if (remainSec < 60) remainText = `剩余约 ${remainSec}s`
                            else remainText = `剩余约 ${Math.ceil(remainSec / 60)}min`
                          }
                          return (
                            <span style={{ fontSize: '11px', color: 'var(--accent1)', marginTop: '2px' }}>
                              进度: {pct}%{remainText ? ` · ${remainText}` : ''}
                            </span>
                          )
                        })()}
                      {processingPath === p && !progressInfo && (
                        <span style={{ fontSize: '11px', color: 'var(--accent1)', marginTop: '2px' }}>处理中...</span>
                      )}
                    </div>
                    {status !== 'processing' && (
                      <button className="del-btn" onClick={() => removeMainPath(p)} title="移除" style={{ flexShrink: 0, zIndex: 1 }}>×</button>
                    )}
                  </li>
                )})}
              </ul>
            )}
          </div>

          <div style={{ flex: 1, minWidth: '300px', background: 'var(--bg1)', padding: '16px', borderRadius: '8px' }}>
            <h3 style={{ fontSize: '14px', marginBottom: '12px', color: 'var(--fg1)' }}>2. 视频 B (细条插入)</h3>
            <button
              type="button"
              className="dedupe-btn"
              disabled={!ffmpegOk || status === 'processing'}
              onClick={pickInsertVideo}
            >
              选择插入视频
            </button>
            {insertPath && (
              <div style={{ marginTop: '12px', padding: '6px 8px', background: 'var(--bg2)', borderRadius: '4px', fontSize: '12px', color: 'var(--fg1)', wordBreak: 'break-all' }}>
                {basename(insertPath)}
              </div>
            )}
          </div>
        </div>

        <div style={{ marginTop: '20px', padding: '16px', background: 'var(--bg1)', borderRadius: '8px' }}>
          <h3 style={{ fontSize: '14px', marginBottom: '12px', color: 'var(--fg1)' }}>🔥 深度去重选项 (对抗查重算法)</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '13px', color: 'var(--fg2)' }}>
              <input type="checkbox" checked={optColorNoise} onChange={e => setOptColorNoise(e.target.checked)} disabled={status === 'processing'} />
              <span><strong>画面色彩微调:</strong> 随机裁剪/旋转/RGB偏移/亮度对比度/动态噪点，彻底改变全局 pHash 指纹。</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '13px', color: 'var(--fg2)' }}>
              <input type="checkbox" checked={optHueSat} onChange={e => setOptHueSat(e.target.checked)} disabled={status === 'processing'} />
              <span><strong>色调/饱和度偏移:</strong> 随机偏移色调 ±5°、饱和度 ±5%，颜色直方图指纹完全不同，肉眼无感。</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '13px', color: 'var(--fg2)' }}>
              <input type="checkbox" checked={optAudioObf} onChange={e => setOptAudioObf(e.target.checked)} disabled={status === 'processing'} />
              <span><strong>音频深度混淆:</strong> 随机变调 0.8~2.5%、微调音量和高通截止频率，摧毁音频声纹和频谱指纹。</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '13px', color: 'var(--fg2)' }}>
              <input type="checkbox" checked={optSpeedJitter} onChange={e => setOptSpeedJitter(e.target.checked)} disabled={status === 'processing'} />
              <span><strong>全局变速微调:</strong> 音视频同步随机在 0.97×~1.03× 范围内微调速度，时间轴指纹完全失效。</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '13px', color: 'var(--fg2)' }}>
              <input type="checkbox" checked={optTrimStart} onChange={e => setOptTrimStart(e.target.checked)} disabled={status === 'processing'} />
              <span><strong>首段随机裁剪:</strong> 随机裁去开头 0.1~0.5 秒，让时间对齐匹配彻底失效。</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '13px', color: 'var(--fg2)' }}>
              <input type="checkbox" checked={optFlip} onChange={e => setOptFlip(e.target.checked)} disabled={status === 'processing'} />
              <span><strong>画面水平镜像:</strong> (选填) 左右翻转，废掉 OCR 文字识别和视觉特征点匹配。有字幕慎用。</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '13px', color: 'var(--fg2)' }}>
              <input type="checkbox" checked={optBlurSharpen} onChange={e => setOptBlurSharpen(e.target.checked)} disabled={status === 'processing'} />
              <span><strong>虚化再锐化:</strong> 微弱高斯模糊 (σ=0.2~0.5) 后再锐化，改变像素级纹理指纹，不影响主观清晰度。</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '13px', color: 'var(--fg2)' }}>
              <input type="checkbox" checked={optAudioEQ} onChange={e => setOptAudioEQ(e.target.checked)} disabled={status === 'processing'} />
              <span><strong>随机音频 EQ:</strong> 在低/中/高三个随机频段各引入 ±1.5dB 微小增益，频谱指纹完全不同。</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '13px', color: 'var(--fg2)' }}>
              <input type="checkbox" checked={optCleanMeta} onChange={e => setOptCleanMeta(e.target.checked)} disabled={status === 'processing'} />
              <span><strong>元数据清洗:</strong> 清除所有文件元数据并注入随机伪造的编码器信息和录制时间。</span>
            </label>
          </div>
        </div>

        <div className="opts-grid" style={{ marginTop: '20px' }}>
          <div className="opt-row">
            <label className="opt-label">底部遮挡比例 (0~50%)</label>
            <input 
              type="range" min="0" max="50" step="1" 
              value={bottomCoverRatio * 100} 
              onChange={e => setBottomCoverRatio(Number(e.target.value) / 100)} 
              disabled={status === 'processing'}
              style={{ flex: 1 }} 
            />
            <span style={{ fontSize: '13px', color: 'var(--fg2)', width: '40px', textAlign: 'right' }}>
              {Math.round(bottomCoverRatio * 100)}%
            </span>
          </div>

          <div className="opt-row">
            <label className="opt-label">遮挡方式</label>
            <select 
              className="opt-select"
              value={bottomCoverType} 
              onChange={e => setBottomCoverType(e.target.value as 'blur' | 'black' | 'crop')} 
              disabled={status === 'processing'}
              style={{ flex: 1 }}
            >
              <option value="blur">模糊 (推荐，保留氛围)</option>
              <option value="black">纯黑边</option>
              <option value="crop">直接裁剪 (改变视频比例)</option>
            </select>
          </div>
        </div>

        <div className="opts-group" style={{ marginTop: '20px', padding: '16px', background: 'var(--bg1)', borderRadius: '8px' }}>
          <div className="opt-row" style={{ borderBottom: 'none', paddingBottom: 0 }}>
            <label className="opt-label" style={{ marginBottom: 0 }}>
              <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--accent2)' }}>贴图 / 水印遮盖</span>
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="button" className="ghost-btn" onClick={addSticker} disabled={status === 'processing'}>
                  + 添加图片
                </button>
              </div>
            </label>
          </div>
  
          {(stickers || []).map((s, idx) => (
            <div key={s.id} className="sticker-card" style={{ marginTop: '12px' }}>
              <div className="sticker-header">
                <span className="sticker-title" style={{ fontSize: 13, color: 'var(--fg1)' }}>
                  贴纸 #{idx + 1} - {basename(s.imagePath)}
                </span>
                <button type="button" className="del-btn" onClick={() => removeSticker(s.id)} disabled={status === 'processing'}>
                  ×
                </button>
              </div>
              <StickerPreview sticker={s} aspectRatio={videoDims ? videoDims.w / videoDims.h : 9 / 16} />
  
              <div className="sticker-grid" style={{ marginTop: '8px' }}>
                <label className="s-label" style={{ fontSize: 12 }}>
                  位置
                  <select
                    value={s.anchor}
                    onChange={(e) =>
                      updateSticker(s.id, { anchor: e.target.value as StickerItem['anchor'] })
                    }
                    disabled={status === 'processing'}
                    style={{ marginLeft: 8 }}
                  >
                    <option value="top-left">左上角</option>
                    <option value="top-right">右上角</option>
                    <option value="bottom-left">左下角</option>
                    <option value="bottom-right">右下角</option>
                    <option value="center">居中</option>
                    <option value="custom">自定义 XY</option>
                  </select>
                </label>
  
                {s.anchor === 'custom' && (
                  <div className="s-row" style={{ marginTop: 4 }}>
                    <label className="s-label" style={{ fontSize: 12 }}>
                      X{' '}
                      <input
                        type="number"
                        value={s.customX}
                        onChange={(e) => updateSticker(s.id, { customX: Number(e.target.value) })}
                        disabled={status === 'processing'}
                        style={{ width: 60 }}
                      />
                    </label>
                    <label className="s-label" style={{ fontSize: 12, marginLeft: 8 }}>
                      Y{' '}
                      <input
                        type="number"
                        value={s.customY}
                        onChange={(e) => updateSticker(s.id, { customY: Number(e.target.value) })}
                        disabled={status === 'processing'}
                        style={{ width: 60 }}
                      />
                    </label>
                  </div>
                )}
  
                {(s.anchor === 'top-left' ||
                  s.anchor === 'top-right' ||
                  s.anchor === 'bottom-left' ||
                  s.anchor === 'bottom-right') && (
                  <div className="s-row" style={{ gridColumn: '1 / -1', marginTop: 4 }}>
                    {(s.anchor === 'top-left' || s.anchor === 'top-right') && (
                      <label className="s-label" style={{ fontSize: 12 }}>
                        距顶部(px)
                        <input
                          type="number"
                          min={0}
                          step={1}
                          value={s.insetTop ?? 0}
                          onChange={(e) => updateSticker(s.id, { insetTop: Number(e.target.value) })}
                          disabled={status === 'processing'}
                          style={{ marginLeft: 4, width: 60 }}
                        />
                      </label>
                    )}
                    {(s.anchor === 'bottom-left' || s.anchor === 'bottom-right') && (
                      <label className="s-label" style={{ fontSize: 12 }}>
                        距底部(px)
                        <input
                          type="number"
                          min={0}
                          step={1}
                          value={s.insetBottom ?? 0}
                          onChange={(e) => updateSticker(s.id, { insetBottom: Number(e.target.value) })}
                          disabled={status === 'processing'}
                          style={{ marginLeft: 4, width: 60 }}
                        />
                      </label>
                    )}
                    {(s.anchor === 'top-left' || s.anchor === 'bottom-left') && (
                      <label className="s-label" style={{ fontSize: 12, marginLeft: 8 }}>
                        距左侧(px)
                        <input
                          type="number"
                          min={0}
                          step={1}
                          value={s.insetLeft ?? 0}
                          onChange={(e) => updateSticker(s.id, { insetLeft: Number(e.target.value) })}
                          disabled={status === 'processing'}
                          style={{ marginLeft: 4, width: 60 }}
                        />
                      </label>
                    )}
                    {(s.anchor === 'top-right' || s.anchor === 'bottom-right') && (
                      <label className="s-label" style={{ fontSize: 12, marginLeft: 8 }}>
                        距右侧(px)
                        <input
                          type="number"
                          min={0}
                          step={1}
                          value={s.insetRight ?? 0}
                          onChange={(e) => updateSticker(s.id, { insetRight: Number(e.target.value) })}
                          disabled={status === 'processing'}
                          style={{ marginLeft: 4, width: 60 }}
                        />
                      </label>
                    )}
                  </div>
                )}
  
                <div className="s-row" style={{ marginTop: 8 }}>
                  <label className="s-label" style={{ fontSize: 12 }}>
                    缩放占比
                    <input
                      type="range"
                      min={0.02}
                      max={0.95}
                      step={0.01}
                      value={s.widthFrac ?? 0.2}
                      onChange={(e) => updateSticker(s.id, { widthFrac: Number(e.target.value) })}
                      disabled={status === 'processing'}
                      style={{ marginLeft: 8 }}
                    />
                  </label>
                  <label className="s-label" style={{ fontSize: 12, marginLeft: 8 }}>
                    透明度
                    <input
                      type="range"
                      min={0.1}
                      max={1.0}
                      step={0.05}
                      value={s.opacity ?? 1.0}
                      onChange={(e) => updateSticker(s.id, { opacity: Number(e.target.value) })}
                      disabled={status === 'processing'}
                      style={{ marginLeft: 8 }}
                    />
                  </label>
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="opts-grid" style={{ marginTop: '20px' }}>
          <div className="opt-row">
            <label className="opt-label">
              <span>插入位置</span>
            </label>
            <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', marginTop: '8px' }}>
              {(['top', 'bottom', 'left', 'right'] as const).map(side => {
                const labels: Record<string, string> = { top: '顶部', bottom: '底部', left: '左侧', right: '右侧' }
                const pos = insertPositions.find(p => p.side === side)
                const checked = !!pos
                // Disable cross-axis sides
                const hasVertical = insertPositions.some(p => p.side === 'top' || p.side === 'bottom')
                const hasHorizontal = insertPositions.some(p => p.side === 'left' || p.side === 'right')
                const isVerticalSide = side === 'top' || side === 'bottom'
                const disabled = status === 'processing' || (!checked && (isVerticalSide ? hasHorizontal : hasVertical))
                return (
                  <div key={side} style={{ display: 'flex', flexDirection: 'column', gap: '6px', minWidth: '80px' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: disabled ? 'not-allowed' : 'pointer', fontSize: '13px', color: disabled ? 'var(--fg3, #555)' : 'var(--fg1)', opacity: disabled ? 0.5 : 1 }}>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={disabled}
                        onChange={() => toggleSide(side)}
                      />
                      {labels[side]}
                    </label>
                    {checked && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '4px', paddingLeft: '20px' }}>
                        <input
                          type="number"
                          min={0}
                          step={1}
                          value={pos!.offsetPx}
                          onChange={e => setOffsetPx(side, Math.max(0, Number(e.target.value)))}
                          disabled={status === 'processing'}
                          style={{ width: '56px', fontSize: '12px', padding: '2px 4px', background: 'var(--bg2)', border: '1px solid var(--border, #333)', borderRadius: '4px', color: 'var(--fg1)' }}
                        />
                        <span style={{ fontSize: '11px', color: 'var(--fg2)' }}>px</span>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
            <div className="opt-desc" style={{ marginTop: '6px' }}>
              选择要插入像素条的位置，可同时选上下或同时选左右。offset=0 表示贴边插入。
            </div>
          </div>

          <div className="opt-row">
            <label className="opt-label">
              <span>插入像素大小</span>
              <span className="opt-val">{insertSizePx}px</span>
            </label>
            <input
              type="range"
              className="slider"
              min="1"
              max="20"
              step="1"
              value={insertSizePx}
              onChange={(e) => setInsertSizePx(Number(e.target.value))}
              disabled={status === 'processing'}
            />
            <div className="opt-desc">插入视频占据的像素宽度/高度（如 1px，越小越不明显）</div>
          </div>
          

        </div>

        <div className="dedupe-toolbar" style={{ marginTop: '20px' }}>
          <button
            type="button"
            className="dedupe-btn primary"
            disabled={!ffmpegOk || mainPaths.length === 0 || !insertPath || status === 'processing'}
            onClick={runStitch}
          >
            {status === 'processing' ? '处理中…' : '开始处理'}
          </button>
        </div>

        {errMsg && <div className="compare-banner err" style={{ marginTop: '16px' }}>{errMsg}</div>}
      </section>
    </div>
  )
}
