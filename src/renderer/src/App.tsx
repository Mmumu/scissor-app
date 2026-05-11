import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DedupeGroup, StickerItem, TransformOptions, VideoInfo } from '../../shared/types'
import { buildCompareRows, md5SameFile, metadataSimilarityPercent } from './video-compare'

const DEFAULT_OPTS: TransformOptions = {
  speed: 1.005,
  hue: 2,
  brightness: 0.02,
  saturation: 1.02,
  noise: 3,
  hflip: false,
  cropPx: 4,
  rotateDeg: 0,
  randomCrop: true,
  unsharp: 0.2,
  pitchRate: 1.03,
  audioEq: true,
  colorMix: true,
  crf: 23,
  bottomCoverRatio: 0,
  bottomCoverType: 'blur',
  stickers: [],
  trimStartSec: 0,
  trimEndSec: 0,
  middleRemoveSec: 0,
  introVideoPath: undefined,
  outroVideoPath: undefined,
  lut3dIntensity: 1.0
}

function basename(p: string) {
  return p.split(/[/\\]/).pop() ?? p
}

function StickerThumb({ filePath }: { filePath: string }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null)
  const [phase, setPhase] = useState<'load' | 'ok' | 'err'>('load')

  useEffect(() => {
    setPhase('load')
    setDataUrl(null)
    let cancelled = false
    window.scissor.readStickerPreview(filePath).then((url) => {
      if (cancelled) return
      if (url) {
        setDataUrl(url)
        setPhase('ok')
      } else {
        setPhase('err')
      }
    })
    return () => {
      cancelled = true
    }
  }, [filePath])

  if (phase === 'load') {
    return <div className="sticker-preview sticker-preview--muted">加载预览…</div>
  }
  if (phase === 'err' || !dataUrl) {
    return <div className="sticker-preview sticker-preview--muted">无法预览</div>
  }
  return <img src={dataUrl} alt="" className="sticker-preview-img" />
}

type Status = 'idle' | 'processing' | 'done' | 'error'

type MainTab = 'transform' | 'compare' | 'dedupe'

export default function App() {
  const [activeTab, setActiveTab] = useState<MainTab>('transform')
  const [ffmpegOk, setFfmpegOk] = useState(false)
  const [ffmpegMsg, setFfmpegMsg] = useState('正在检测 ffmpeg…')

  const [inputPath, setInputPath] = useState<string | null>(null)
  const [opts, setOpts] = useState<TransformOptions>(DEFAULT_OPTS)

  const [status, setStatus] = useState<Status>('idle')
  const [errMsg, setErrMsg] = useState('')
  const [outputPath, setOutputPath] = useState<string | null>(null)

  const [compareA, setCompareA] = useState<string | null>(null)
  const [compareB, setCompareB] = useState<string | null>(null)
  const [compareMd5, setCompareMd5] = useState(false)
  const [compareBusy, setCompareBusy] = useState(false)
  const [compareErr, setCompareErr] = useState('')
  const [comparePair, setComparePair] = useState<[VideoInfo, VideoInfo] | null>(null)

  const compareAnalysis = useMemo(() => {
    if (!comparePair) return null
    const [va, vb] = comparePair
    return {
      score: metadataSimilarityPercent(va, vb),
      rows: buildCompareRows(va, vb),
      md5: md5SameFile(va, vb)
    }
  }, [comparePair])

  const [dragOver, setDragOver] = useState(false)
  const dropRef = useRef<HTMLDivElement>(null)

  const [luts, setLuts] = useState<{name: string, path: string}[]>([])

  useEffect(() => {
    window.scissor.checkFfmpeg().then((r) => {
      setFfmpegOk(r.ok)
      setFfmpegMsg(
        r.ok
          ? `ffmpeg 已就绪 · ${r.ffmpeg}`
          : (r.error ?? 'ffmpeg 不可用，请按提示安装 FFmpeg/ffprobe 或检查应用是否完整。')
      )
    })
    window.scissor.getLuts().then((list) => {
      if (list && list.length > 0) setLuts(list)
    })
  }, [])

  const pickInput = useCallback(async () => {
    const paths = await window.scissor.pickVideos()
    if (paths?.[0]) {
      setInputPath(paths[0])
      setStatus('idle')
      setOutputPath(null)
      setErrMsg('')
    }
  }, [])

  const pickCompareLeft = useCallback(async () => {
    const paths = await window.scissor.pickVideos()
    if (paths?.[0]) {
      setCompareA(paths[0])
      setComparePair(null)
      setCompareErr('')
    }
  }, [])

  const pickCompareRight = useCallback(async () => {
    const paths = await window.scissor.pickVideos()
    if (paths?.[0]) {
      setCompareB(paths[0])
      setComparePair(null)
      setCompareErr('')
    }
  }, [])

  const runCompareVideos = useCallback(async () => {
    if (!compareA || !compareB) return
    setCompareBusy(true)
    setCompareErr('')
    setComparePair(null)
    try {
      const pair = await window.scissor.compareVideos(compareA, compareB, { md5: compareMd5 })
      setComparePair(pair)
    } catch (e) {
      setCompareErr(String(e))
    } finally {
      setCompareBusy(false)
    }
  }, [compareA, compareB, compareMd5])

  const [dedupePaths, setDedupePaths] = useState<string[]>([])
  const [dedupeBusy, setDedupeBusy] = useState(false)
  const [dedupeErr, setDedupeErr] = useState('')
  const [dedupeGroups, setDedupeGroups] = useState<DedupeGroup[] | null>(null)

  const addDedupeVideos = useCallback(async () => {
    const paths = await window.scissor.pickVideos()
    if (!paths?.length) return
    setDedupePaths((prev) => [...new Set([...prev, ...paths])])
    setDedupeGroups(null)
    setDedupeErr('')
  }, [])

  const removeDedupePath = useCallback((p: string) => {
    setDedupePaths((prev) => prev.filter((x) => x !== p))
    setDedupeGroups(null)
  }, [])

  const clearDedupePaths = useCallback(() => {
    setDedupePaths([])
    setDedupeGroups(null)
    setDedupeErr('')
  }, [])

  const runDedupeScan = useCallback(async () => {
    if (dedupePaths.length < 2) {
      setDedupeErr('请至少选择 2 个视频文件')
      return
    }
    setDedupeBusy(true)
    setDedupeErr('')
    setDedupeGroups(null)
    try {
      const r = await window.scissor.dedupeScan(dedupePaths)
      if (r.ok && r.groups) {
        setDedupeGroups(r.groups)
      } else {
        setDedupeErr(r.error ?? '扫描失败')
      }
    } catch (e) {
      setDedupeErr(String(e))
    } finally {
      setDedupeBusy(false)
    }
  }, [dedupePaths])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files[0]
    if (file) {
      const p = (file as unknown as { path: string }).path
      if (p) {
        setInputPath(p)
        setStatus('idle')
        setOutputPath(null)
        setErrMsg('')
      }
    }
  }, [])

  const setOpt = <K extends keyof TransformOptions>(k: K, v: TransformOptions[K]) =>
    setOpts((prev) => ({ ...prev, [k]: v }))

  const addSticker = useCallback(async () => {
    const path = await window.scissor.pickImage()
    if (!path) return
    setOpts((prev) => ({
      ...prev,
      stickers: [
        ...(prev.stickers || []),
        {
          id: Date.now().toString(),
          imagePath: path,
          anchor: 'top-right',
          customX: 0,
          customY: 0,
          insetTop: 20,
          insetRight: 20,
          insetBottom: 20,
          insetLeft: 20,
          widthFrac: 0,
          opacity: 1.0,
          startSec: null,
          endSec: null
        }
      ]
    }))
  }, [])

  const updateSticker = useCallback((id: string, patch: Partial<StickerItem>) => {
    setOpts((prev) => ({
      ...prev,
      stickers: (prev.stickers || []).map((s) => (s.id === id ? { ...s, ...patch } : s))
    }))
  }, [])

  const removeSticker = useCallback((id: string) => {
    setOpts((prev) => ({
      ...prev,
      stickers: (prev.stickers || []).filter((s) => s.id !== id)
    }))
  }, [])

  const pickIntroVideo = useCallback(async () => {
    const paths = await window.scissor.pickVideos()
    if (paths?.[0]) setOpt('introVideoPath', paths[0])
  }, [])

  const pickOutroVideo = useCallback(async () => {
    const paths = await window.scissor.pickVideos()
    if (paths?.[0]) setOpt('outroVideoPath', paths[0])
  }, [])

  const run = useCallback(async () => {
    if (!inputPath) return
    const ext = inputPath.match(/\.(\w+)$/)?.[1] ?? 'mp4'
    const name = basename(inputPath).replace(/\.\w+$/, '') + '_out.' + ext
    const out = await window.scissor.pickSavePath(name)
    if (!out) return

    setStatus('processing')
    setErrMsg('')
    setOutputPath(null)

    const r = await window.scissor.transformVideo(inputPath, out, opts)
    if (r.ok) {
      setStatus('done')
      setOutputPath(out)
    } else {
      setStatus('error')
      setErrMsg(r.error ?? '处理失败')
    }
  }, [inputPath, opts])

  const isReady = ffmpegOk && !!inputPath && status !== 'processing'

  return (
    <div className="app">
      <header className="header">
        <div className="header-inner">
          <div className="logo">
            <span className="logo-icon">✂</span>
            <span className="logo-text">Scissor</span>
            <span className="logo-tag">过原创</span>
          </div>
          <div className={`ffmpeg-badge ${ffmpegOk ? 'ok' : 'err'}`}>
            <span className="dot" />
            {ffmpegOk ? 'ffmpeg ready' : 'ffmpeg missing'}
          </div>
        </div>
      </header>

      <main className="main">
        {!ffmpegOk && (
          <div className="banner err">
            <span>⚠</span> {ffmpegMsg}
          </div>
        )}

        <nav className="main-tabs" role="tablist" aria-label="功能切换">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'transform'}
            className={`main-tab ${activeTab === 'transform' ? 'active' : ''}`}
            onClick={() => setActiveTab('transform')}
          >
            过原创
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'compare'}
            className={`main-tab ${activeTab === 'compare' ? 'active' : ''}`}
            onClick={() => setActiveTab('compare')}
          >
            视频对比
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'dedupe'}
            className={`main-tab ${activeTab === 'dedupe' ? 'active' : ''}`}
            onClick={() => setActiveTab('dedupe')}
          >
            去重
          </button>
        </nav>

        {activeTab === 'transform' && (
          <div className="tab-panel tab-panel--transform">
            <div className="workspace">
          {/* Left: Drop zone */}
          <section className="panel drop-panel">
            <h2 className="panel-title">① 选择源视频</h2>
            <div
              ref={dropRef}
              className={`dropzone ${dragOver ? 'drag-over' : ''} ${inputPath ? 'has-file' : ''}`}
              onClick={pickInput}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
            >
              {inputPath ? (
                <>
                  <div className="file-icon">🎬</div>
                  <div className="file-name">{basename(inputPath)}</div>
                  <div className="file-path">{inputPath}</div>
                  <div className="file-hint">点击或拖入重新选择</div>
                </>
              ) : (
                <>
                  <div className="drop-icon">⬆</div>
                  <div className="drop-label">拖入视频或点击选择</div>
                  <div className="drop-hint">支持 mp4 / mov / mkv / m4v / webm / avi</div>
                </>
              )}
            </div>
          </section>

          {/* Middle: Options */}
          <section className="panel opts-panel">
            <h2 className="panel-title">② 过原创参数</h2>
                  <div className="opts-grid">
                    <div className="opt-row opts-section-head">
                      <span className="opts-section-title">剪辑结构</span>
                      <div className="opt-desc">改时间轴与成片边界，削弱和原片的逐帧对齐（仍无法保证过平台审核）</div>
                    </div>
            
                    <div className="opt-row">
                      <label className="opt-label">
                        <span>去掉片头</span>
                        <span className="opt-val">{opts.trimStartSec.toFixed(1)}s</span>
                      </label>
                      <input
                        type="range"
                        className="slider"
                        min="0"
                        max="30"
                        step="0.5"
                        value={opts.trimStartSec}
                        onChange={(e) => setOpt('trimStartSec', Number(e.target.value))}
                      />
                      <div className="opt-desc">从入点往后裁掉（秒）</div>
                    </div>
            
                    <div className="opt-row">
                      <label className="opt-label">
                        <span>去掉片尾</span>
                        <span className="opt-val">{opts.trimEndSec.toFixed(1)}s</span>
                      </label>
                      <input
                        type="range"
                        className="slider"
                        min="0"
                        max="30"
                        step="0.5"
                        value={opts.trimEndSec}
                        onChange={(e) => setOpt('trimEndSec', Number(e.target.value))}
                      />
                      <div className="opt-desc">从出点往前裁掉（秒）</div>
                    </div>
            
                    <div className="opt-row">
                      <label className="opt-label">
                        <span>中间删除（跳剪）</span>
                        <span className="opt-val">{opts.middleRemoveSec.toFixed(1)}s</span>
                      </label>
                      <input
                        type="range"
                        className="slider"
                        min="0"
                        max="20"
                        step="0.5"
                        value={opts.middleRemoveSec}
                        onChange={(e) => setOpt('middleRemoveSec', Number(e.target.value))}
                      />
                      <div className="opt-desc">
                        在去掉片头尾后的正中间删掉连续一段再拼接；0 = 关闭。无音轨视频勿用此项。
                      </div>
                    </div>
            
                    <div className="opt-row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                      <div className="opt-label" style={{ marginBottom: 8 }}>
                        <span>片头短片（可选）</span>
                      </div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                        <button type="button" className="ghost-btn" onClick={pickIntroVideo}>
                          选择片头视频
                        </button>
                        {opts.introVideoPath && (
                          <>
                            <span className="file-tag">{basename(opts.introVideoPath)}</span>
                            <button
                              type="button"
                              className="ghost-btn"
                              onClick={() => setOpt('introVideoPath', undefined)}
                            >
                              清除
                            </button>
                          </>
                        )}
                      </div>
                      <div className="opt-desc">拼在主成片之前；须含音轨（可用静音轨）。会二次编码整条成片。</div>
                    </div>
            
                    <div className="opt-row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                      <div className="opt-label" style={{ marginBottom: 8 }}>
                        <span>片尾短片（可选）</span>
                      </div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                        <button type="button" className="ghost-btn" onClick={pickOutroVideo}>
                          选择片尾视频
                        </button>
                        {opts.outroVideoPath && (
                          <>
                            <span className="file-tag">{basename(opts.outroVideoPath)}</span>
                            <button
                              type="button"
                              className="ghost-btn"
                              onClick={() => setOpt('outroVideoPath', undefined)}
                            >
                              清除
                            </button>
                          </>
                        )}
                      </div>
                      <div className="opt-desc">拼在主成片之后；同样须含音轨。</div>
                    </div>
            
                    <div className="opt-row">
                      <label className="opt-label">
                        <span>变速</span>
                        <span className="opt-val">{((opts.speed - 1) * 100).toFixed(2)}%</span>
                      </label>
                      <input
                        type="range"
                        className="slider"
                        min="1.001"
                        max="1.020"
                        step="0.001"
                        value={opts.speed}
                        onChange={(e) => setOpt('speed', Number(e.target.value))}
                      />
                      <div className="opt-desc">轻微加速，同步影响视频 + 音频时间戳</div>
                    </div>
            
                    <div className="opt-row">
                      <label className="opt-label">
                        <span>色调偏移</span>
                        <span className="opt-val">{opts.hue}°</span>
                      </label>
                      <input
                        type="range"
                        className="slider"
                        min="-10"
                        max="10"
                        step="0.5"
                        value={opts.hue}
                        onChange={(e) => setOpt('hue', Number(e.target.value))}
                      />
                      <div className="opt-desc">色轮旋转角度，±5° 内人眼基本无感</div>
                    </div>
            
                    <div className="opt-row">
                      <label className="opt-label">
                        <span>亮度</span>
                        <span className="opt-val">
                          {opts.brightness > 0 ? '+' : ''}
                          {(opts.brightness * 100).toFixed(1)}%
                        </span>
                      </label>
                      <input
                        type="range"
                        className="slider"
                        min="-0.05"
                        max="0.05"
                        step="0.005"
                        value={opts.brightness}
                        onChange={(e) => setOpt('brightness', Number(e.target.value))}
                      />
                      <div className="opt-desc">整体亮度微调</div>
                    </div>
            
                    <div className="opt-row">
                      <label className="opt-label">
                        <span>饱和度</span>
                        <span className="opt-val">{((opts.saturation - 1) * 100).toFixed(1)}%</span>
                      </label>
                      <input
                        type="range"
                        className="slider"
                        min="0.92"
                        max="1.10"
                        step="0.01"
                        value={opts.saturation}
                        onChange={(e) => setOpt('saturation', Number(e.target.value))}
                      />
                      <div className="opt-desc">颜色饱和度倍率</div>
                    </div>
            
                    <div className="opt-row">
                      <label className="opt-label">
                        <span>噪点</span>
                        <span className="opt-val">{opts.noise}</span>
                      </label>
                      <input
                        type="range"
                        className="slider"
                        min="0"
                        max="8"
                        step="1"
                        value={opts.noise}
                        onChange={(e) => setOpt('noise', Number(e.target.value))}
                      />
                      <div className="opt-desc">随机噪点强度（0 = 关闭）</div>
                    </div>
            
                    <div className="opt-row">
                      <label className="opt-label">
                        <span>边缘裁切</span>
                        <span className="opt-val">{opts.cropPx}px</span>
                      </label>
                      <input
                        type="range"
                        className="slider"
                        min="0"
                        max="16"
                        step="1"
                        value={opts.cropPx}
                        onChange={(e) => setOpt('cropPx', Number(e.target.value))}
                      />
                      <div className="opt-desc">四边各裁掉 N 像素后重缩回原尺寸</div>
                    </div>
            
                    <div className="opt-row">
                      <label className="opt-label">
                        <span>音频变调</span>
                        <span className="opt-val">
                          {opts.pitchRate >= 1
                            ? `+${((opts.pitchRate - 1) * 100).toFixed(1)}%`
                            : `${((opts.pitchRate - 1) * 100).toFixed(1)}%`}
                        </span>
                      </label>
                      <input
                        type="range"
                        className="slider"
                        min="0.94"
                        max="1.06"
                        step="0.01"
                        value={opts.pitchRate}
                        onChange={(e) => setOpt('pitchRate', Number(e.target.value))}
                      />
                      <div className="opt-desc">
                        asetrate 改变频谱 Chroma 特征，破坏 ACRCloud 级音频指纹。±3% 人耳勉强可感知
                      </div>
                    </div>
            
                    <div className="opt-row">
                      <label className="opt-label toggle-label">
                        <span>水平翻转</span>
                        <button
                          type="button"
                          className={`toggle ${opts.hflip ? 'on' : ''}`}
                          onClick={() => setOpt('hflip', !opts.hflip)}
                        >
                          {opts.hflip ? '开' : '关'}
                        </button>
                      </label>
                      <div className="opt-desc">镜像翻转（适合无字幕 / 无明显方向性内容）</div>
                    </div>

                    <div className="opt-row">
                      <label className="opt-label">
                        <span>微量旋转</span>
                        <span className="opt-val">{opts.rotateDeg}°</span>
                      </label>
                      <input
                        type="range" className="slider"
                        min="-2" max="2" step="0.1"
                        value={opts.rotateDeg}
                        onChange={(e) => setOpt('rotateDeg', Number(e.target.value))}
                      />
                      <div className="opt-desc">最强维度的破坏！画面微小倾斜，令所有坐标偏移</div>
                    </div>

                    <div className="opt-row">
                      <label className="opt-label toggle-label">
                        <span>非对称随机裁剪</span>
                        <button
                          type="button"
                          className={`toggle ${opts.randomCrop ? 'on' : ''}`}
                          onClick={() => setOpt('randomCrop', !opts.randomCrop)}
                        >
                          {opts.randomCrop ? '开' : '关'}
                        </button>
                      </label>
                      <div className="opt-desc">取代上方边缘对称裁切，四边随机切掉不同像素，彻底破坏对齐</div>
                    </div>

                    <div className="opt-row">
                      <label className="opt-label">
                        <span>清晰度(锐化/模糊)</span>
                        <span className="opt-val">{opts.unsharp > 0 ? '+' : ''}{opts.unsharp.toFixed(1)}</span>
                      </label>
                      <input
                        type="range" className="slider"
                        min="-1" max="1" step="0.1"
                        value={opts.unsharp}
                        onChange={(e) => setOpt('unsharp', Number(e.target.value))}
                      />
                      <div className="opt-desc">改变高频细节特征。正数锐化，负数柔化</div>
                    </div>

                    <div className="opt-row">
                      <label className="opt-label toggle-label">
                        <span>RGB独立微调</span>
                        <button
                          type="button"
                          className={`toggle ${opts.colorMix ? 'on' : ''}`}
                          onClick={() => setOpt('colorMix', !opts.colorMix)}
                        >
                          {opts.colorMix ? '开' : '关'}
                        </button>
                      </label>
                      <div className="opt-desc">各色彩通道产生极小的不规则偏移，破坏色彩直方图</div>
                    </div>

                    <div className="opt-row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                        <label className="opt-label" style={{ marginBottom: 0 }}>
                          <span>LUT 电影滤镜</span>
                        </label>
                        <select
                          className="ghost-btn"
                          style={{ padding: '2px 8px', outline: 'none', background: 'var(--bg1)', color: 'var(--fg1)' }}
                          value={opts.lut3dPath || ''}
                          onChange={(e) => setOpt('lut3dPath', e.target.value || undefined)}
                        >
                          <option value="">(无滤镜)</option>
                          {luts.map((l) => (
                            <option key={l.path} value={l.path}>
                              {l.name === 'bw' ? '黑白 (B&W)' :
                               l.name === 'sepia' ? '复古 (Sepia)' :
                               l.name === 'warm' ? '暖色调 (Warm)' :
                               l.name === 'cool' ? '冷色调 (Cool)' :
                               l.name === 'contrast' ? '高对比度 (Contrast)' : l.name}
                            </option>
                          ))}
                        </select>
                      </div>
                      {opts.lut3dPath && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 8 }}>
                          <span style={{ fontSize: 13, color: 'var(--fg2)', whiteSpace: 'nowrap' }}>
                            滤镜强度 {((opts.lut3dIntensity ?? 1.0) * 100).toFixed(0)}%
                          </span>
                          <input
                            type="range"
                            className="slider"
                            min="0"
                            max="1"
                            step="0.05"
                            value={opts.lut3dIntensity ?? 1.0}
                            onChange={(e) => setOpt('lut3dIntensity', Number(e.target.value))}
                          />
                        </div>
                      )}
                      <div className="opt-desc" style={{ marginTop: 8 }}>应用高级 3D LUT 调色。可把 `.cube` 文件放在 resources/luts 目录下扩充</div>
                    </div>

                    <div className="opt-row">
                      <label className="opt-label toggle-label">
                        <span>音频高低频切除</span>
                        <button
                          type="button"
                          className={`toggle ${opts.audioEq ? 'on' : ''}`}
                          onClick={() => setOpt('audioEq', !opts.audioEq)}
                        >
                          {opts.audioEq ? '开' : '关'}
                        </button>
                      </label>
                      <div className="opt-desc">切除 80Hz 以下和 15.5kHz 以上人耳无感频段，破坏频域指纹</div>
                    </div>
            
                    <div className="opt-row">
                      <label className="opt-label">
                        <span>画质 / 压缩率 (CRF)</span>
                        <span className="opt-val">{opts.crf}</span>
                      </label>
                      <input
                        type="range"
                        className="slider"
                        min="18"
                        max="30"
                        step="1"
                        value={opts.crf}
                        onChange={(e) => setOpt('crf', Number(e.target.value))}
                      />
                      <div className="opt-desc">数值越低画质越好体积越大。23 是默认平衡点，大于 25 体积小但有损。</div>
                    </div>
            
                    <div className="opt-row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                        <label className="opt-label" style={{ marginBottom: 0 }}>
                          <span>底部去字幕 (%)</span>
                          <span className="opt-val">{(opts.bottomCoverRatio * 100).toFixed(0)}%</span>
                        </label>
                        <select
                          className="ghost-btn"
                          style={{ padding: '2px 8px', outline: 'none', background: 'var(--bg1)', color: 'var(--fg1)' }}
                          value={opts.bottomCoverType}
                          onChange={(e) =>
                            setOpt('bottomCoverType', e.target.value as TransformOptions['bottomCoverType'])
                          }
                        >
                          <option value="blur">方式: 高斯模糊</option>
                          <option value="black">方式: 纯黑遮挡</option>
                          <option value="crop">方式: 暴力裁剪掉</option>
                        </select>
                      </div>
                      <input
                        type="range"
                        className="slider"
                        min="0"
                        max="0.5"
                        step="0.01"
                        value={opts.bottomCoverRatio}
                        onChange={(e) => setOpt('bottomCoverRatio', Number(e.target.value))}
                      />
                      <div className="opt-desc">由于硬字幕无法完美擦除，请选择一种遮挡方式（0 为不处理）。</div>
                    </div>
                  </div>
            
                  <div className="opts-group" style={{ marginTop: 24 }}>
                    <div className="opt-row" style={{ borderBottom: 'none', paddingBottom: 0 }}>
                      <label className="opt-label" style={{ marginBottom: 0 }}>
                        <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--accent2)' }}>贴图 / 水印遮盖</span>
                        <div style={{ display: 'flex', gap: 8 }}>
                          <button type="button" className="ghost-btn" onClick={addSticker}>
                            + 添加图片
                          </button>
                        </div>
                      </label>
                    </div>
            
                    {(opts.stickers || []).map((s, idx) => (
                      <div key={s.id} className="sticker-card">
                        <div className="sticker-header">
                          <span className="sticker-title">
                            贴纸 #{idx + 1} - {basename(s.imagePath)}
                          </span>
                          <button type="button" className="del-btn" onClick={() => removeSticker(s.id)}>
                            ×
                          </button>
                        </div>
                        <StickerThumb filePath={s.imagePath} />
            
                        <div className="sticker-grid">
                          <label className="s-label">
                            位置
                            <select
                              value={s.anchor}
                              onChange={(e) =>
                                updateSticker(s.id, { anchor: e.target.value as StickerItem['anchor'] })
                              }
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
                            <div className="s-row">
                              <label className="s-label">
                                X{' '}
                                <input
                                  type="number"
                                  value={s.customX}
                                  onChange={(e) => updateSticker(s.id, { customX: Number(e.target.value) })}
                                />
                              </label>
                              <label className="s-label">
                                Y{' '}
                                <input
                                  type="number"
                                  value={s.customY}
                                  onChange={(e) => updateSticker(s.id, { customY: Number(e.target.value) })}
                                />
                              </label>
                            </div>
                          )}
            
                          {(s.anchor === 'top-left' ||
                            s.anchor === 'top-right' ||
                            s.anchor === 'bottom-left' ||
                            s.anchor === 'bottom-right') && (
                            <div className="s-row" style={{ gridColumn: '1 / -1' }}>
                              {(s.anchor === 'top-left' || s.anchor === 'top-right') && (
                                <label className="s-label">
                                  距顶部(px)
                                  <input
                                    type="number"
                                    min={0}
                                    step={1}
                                    value={s.insetTop ?? 20}
                                    onChange={(e) => updateSticker(s.id, { insetTop: Number(e.target.value) })}
                                  />
                                </label>
                              )}
                              {(s.anchor === 'bottom-left' || s.anchor === 'bottom-right') && (
                                <label className="s-label">
                                  距底部(px)
                                  <input
                                    type="number"
                                    min={0}
                                    step={1}
                                    value={s.insetBottom ?? 20}
                                    onChange={(e) =>
                                      updateSticker(s.id, { insetBottom: Number(e.target.value) })
                                    }
                                  />
                                </label>
                              )}
                              {(s.anchor === 'top-left' || s.anchor === 'bottom-left') && (
                                <label className="s-label">
                                  距左侧(px)
                                  <input
                                    type="number"
                                    min={0}
                                    step={1}
                                    value={s.insetLeft ?? 20}
                                    onChange={(e) => updateSticker(s.id, { insetLeft: Number(e.target.value) })}
                                  />
                                </label>
                              )}
                              {(s.anchor === 'top-right' || s.anchor === 'bottom-right') && (
                                <label className="s-label">
                                  距右侧(px)
                                  <input
                                    type="number"
                                    min={0}
                                    step={1}
                                    value={s.insetRight ?? 20}
                                    onChange={(e) =>
                                      updateSticker(s.id, { insetRight: Number(e.target.value) })
                                    }
                                  />
                                </label>
                              )}
                            </div>
                          )}
            
                          <label className="s-label">
                            宽度占画面
                            <input
                              type="range"
                              min={0}
                              max={0.5}
                              step={0.01}
                              value={s.widthFrac}
                              onChange={(e) => updateSticker(s.id, { widthFrac: Number(e.target.value) })}
                            />
                            <span className="opt-val" style={{ marginTop: 4 }}>
                              {s.widthFrac <= 0 ? '原始尺寸' : `${Math.round(s.widthFrac * 100)}%`}
                            </span>
                          </label>
            
                          <label className="s-label">
                            透明度
                            <input
                              type="number"
                              step="0.1"
                              min="0"
                              max="1"
                              value={s.opacity}
                              onChange={(e) => updateSticker(s.id, { opacity: Number(e.target.value) })}
                            />
                          </label>
                        </div>
            
                        <div className="sticker-grid" style={{ marginTop: 8 }}>
                          <label className="s-label">
                            显示时间 (起始秒)
                            <input
                              type="number"
                              step="0.1"
                              placeholder="默认开头"
                              value={s.startSec ?? ''}
                              onChange={(e) =>
                                updateSticker(s.id, {
                                  startSec: e.target.value ? Number(e.target.value) : null
                                })
                              }
                            />
                          </label>
                          <label className="s-label">
                            显示时间 (结束秒)
                            <input
                              type="number"
                              step="0.1"
                              placeholder="默认结尾"
                              value={s.endSec ?? ''}
                              onChange={(e) =>
                                updateSticker(s.id, {
                                  endSec: e.target.value ? Number(e.target.value) : null
                                })
                              }
                            />
                          </label>
                        </div>
                      </div>
                    ))}
                    {!(opts.stickers?.length) && (
                      <div className="opt-desc" style={{ marginTop: 8 }}>
                        可叠加图片遮挡动态水印。支持控制出现时间段。
                      </div>
                    )}
                  </div>
            
                  <button type="button" className="reset-btn" onClick={() => setOpts(DEFAULT_OPTS)}>
                    恢复默认值
                  </button>
          </section>

          {/* Right: Action & result */}
          <section className="panel action-panel">
            <h2 className="panel-title">③ 生成</h2>
            <p className="action-lead">
              主成片经 ffmpeg 一条 filter 链处理（微扰 + 可选贴纸/底栏）；若选了片头或片尾短片，会再与主成片拼接并整条重编码。
            </p>

            <div className="action-area">
              <div className="strategy-cards">
                <div className="s-card">
                  <span className="s-icon">✂️</span>
                  <span>剪辑结构</span>
                  <span className="s-card-hint">片头尾 / 跳剪</span>
                </div>
                <div className="s-card">
                  <span className="s-icon">🔗</span>
                  <span>拼短片</span>
                  <span className="s-card-hint">片头·片尾可选</span>
                </div>
                <div className="s-card">
                  <span className="s-icon">⚡</span>
                  <span>变速·音调</span>
                  <span className="s-card-hint">PTS + 音轨</span>
                </div>
                <div className="s-card">
                  <span className="s-icon">🎨</span>
                  <span>色彩·纹理</span>
                  <span className="s-card-hint">色相·亮度·饱和·噪点</span>
                </div>
                <div className="s-card">
                  <span className="s-icon">↔️</span>
                  <span>翻转·裁边</span>
                  <span className="s-card-hint">微crop再缩放</span>
                </div>
                <div className="s-card">
                  <span className="s-icon">🖼</span>
                  <span>贴纸·底栏</span>
                  <span className="s-card-hint">叠层 + 下沿遮挡</span>
                </div>
                <div className="s-card s-card--wide">
                  <span className="s-icon">🎬</span>
                  <span>再编码</span>
                  <span className="s-card-hint">H.264 libx264 · CRF</span>
                </div>
              </div>

              <button
                id="run-btn"
                type="button"
                className={`run-btn ${status === 'processing' ? 'busy' : ''}`}
                disabled={!isReady}
                onClick={run}
              >
                {status === 'processing' ? (
                  <><span className="spinner" /> 处理中…</>
                ) : '开始生成'}
              </button>

              {status === 'done' && outputPath && (
                <div className="result ok">
                  <div className="result-icon">✅</div>
                  <div className="result-text">
                    <strong>生成成功</strong>
                    <span className="result-path">{outputPath}</span>
                  </div>
                </div>
              )}

              {status === 'error' && (
                <div className="result err">
                  <div className="result-icon">❌</div>
                  <div className="result-text">
                    <strong>处理失败</strong>
                    <span className="result-path">{errMsg}</span>
                  </div>
                </div>
              )}

              <div className="note-box">
                <p>📌 <strong>原理说明</strong>（与当前实现一致）</p>
                <ul>
                  <li>
                    <strong>剪辑</strong>：用 trim / atrim 改入点、出点，或去掉中段再 concat，时间线与原片逐帧对不齐；需要音轨。片头/片尾短片在主编码完成后再 concat，分辨率拉齐、整条重编码。
                  </li>
                  <li>
                    <strong>变速</strong>：视频用 setpts 把 PTS 按 1/速度 缩放，输出时长 ≈ 原时长÷速度；音频用 asetrate（配合音调倍率）+ aresample + atempo，让听感变调后净播放速率仍等于「速度」。
                  </li>
                  <li>
                    <strong>色彩与噪点</strong>：hue、eq、饱和度与 noise 滤镜直接改每帧像素统计，影响 dHash/感知哈希类特征；默认滑块步进保持轻微、人眼不敏感。
                  </li>
                  <li>
                    <strong>几何</strong>：水平翻转、四周微像素裁切再 scale 回偶数分辨率，改变取样网格；底部栏可用裁底、黑条或「原底+高斯条」叠在下方。
                  </li>
                  <li>
                    <strong>贴纸</strong>：仅自定义图；宽度可按主画面宽度比例缩放，锚点+边距定位，enable 表达式控制出现时段，叠在整个处理链之后。
                  </li>
                  <li>
                    <strong>编码</strong>：libx264 CRF 有损重编码，宏块与码流特征与一次编码成片不同。
                  </li>
                  <li>
                    以上为技术手段层面的差异化，<strong>无法保证</strong>任何平台「过原创」审核。顶部「视频对比」「去重」为本地辅助（元数据 / MD5 / 画面与可选 Chromaprint），与导出成片无自动联动。
                  </li>
                </ul>
              </div>
            </div>
          </section>
            </div>
          </div>
        )}

        {activeTab === 'compare' && (
          <div className="tab-panel tab-panel--compare">
            <div className="tab-panel-scroll">
              <section className="compare-panel compare-panel--tab">
          <div className="compare-head">
            <h2 className="compare-title">双视频参数对比</h2>
            <p className="compare-sub">
              基于 ffprobe 元数据估算相似度；与画面是否「同一素材」不是一回事。开启 MD5 可确认是否为同一字节文件（大文件较慢）。
            </p>
          </div>

          <div className="compare-toolbar">
            <div className="compare-slots">
              <button
                type="button"
                className={`compare-slot ${compareA ? 'has' : ''}`}
                disabled={!ffmpegOk}
                onClick={pickCompareLeft}
              >
                <span className="compare-slot-label">视频 A</span>
                <span className="compare-slot-file">{compareA ? basename(compareA) : '点击选择'}</span>
              </button>
              <span className="compare-vs">vs</span>
              <button
                type="button"
                className={`compare-slot ${compareB ? 'has' : ''}`}
                disabled={!ffmpegOk}
                onClick={pickCompareRight}
              >
                <span className="compare-slot-label">视频 B</span>
                <span className="compare-slot-file">{compareB ? basename(compareB) : '点击选择'}</span>
              </button>
            </div>

            <label className="compare-md5">
              <input
                type="checkbox"
                checked={compareMd5}
                onChange={(e) => {
                  setCompareMd5(e.target.checked)
                  setComparePair(null)
                }}
              />
              计算全文 MD5（慢）
            </label>

            <button
              type="button"
              className="compare-run"
              disabled={!ffmpegOk || !compareA || !compareB || compareBusy}
              onClick={runCompareVideos}
            >
              {compareBusy ? '读取中…' : '对比'}
            </button>
          </div>

          {compareErr && (
            <div className="compare-banner err">{compareErr}</div>
          )}

          {compareAnalysis && (
            <div className="compare-results">
              <div className="compare-score-row">
                <div className="compare-score">
                  <span className="compare-score-label">元数据相似度</span>
                  <span className="compare-score-val">{compareAnalysis.score}%</span>
                </div>
                {compareAnalysis.md5 === true && (
                  <div className="compare-badge same">字节级相同（MD5 一致）</div>
                )}
                {compareAnalysis.md5 === false && (
                  <div className="compare-badge diff">MD5 不同（非同一文件拷贝）</div>
                )}
              </div>

              <div className="compare-table-wrap">
                <table className="compare-table">
                  <thead>
                    <tr>
                      <th>维度</th>
                      <th>视频 A</th>
                      <th>视频 B</th>
                      <th>匹配</th>
                    </tr>
                  </thead>
                  <tbody>
                    {compareAnalysis.rows.map((row) => (
                      <tr key={row.label}>
                        <td>{row.label}</td>
                        <td className="mono">{row.valA}</td>
                        <td className="mono">{row.valB}</td>
                        <td className={row.match ? 'ok' : 'no'}>{row.match ? '✓' : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
              </section>
            </div>
          </div>
        )}

        {activeTab === 'dedupe' && (
          <div className="tab-panel tab-panel--dedupe">
            <div className="tab-panel-scroll dedupe-scroll">
              <section className="dedupe-panel">
                <div className="dedupe-head">
                  <h2 className="dedupe-title">本地视频去重</h2>
                  <p className="dedupe-sub">
                    ① 整文件 SHA256 完全相同 → 一组；② 其余两两比对：6 点画面 dHash、可选 Chromaprint 音轨（需安装
                    fpcalc / brew install chromaprint）、ffprobe 元数据强相似（≥90% 且分辨率/编码/时长等硬门槛）。文件多会慢。
                  </p>
                </div>

                <div className="dedupe-toolbar">
                  <button
                    type="button"
                    className="dedupe-btn primary"
                    disabled={!ffmpegOk}
                    onClick={addDedupeVideos}
                  >
                    添加视频
                  </button>
                  <button
                    type="button"
                    className="dedupe-btn"
                    disabled={dedupePaths.length === 0}
                    onClick={clearDedupePaths}
                  >
                    清空列表
                  </button>
                  <button
                    type="button"
                    className="dedupe-btn primary"
                    disabled={!ffmpegOk || dedupePaths.length < 2 || dedupeBusy}
                    onClick={runDedupeScan}
                  >
                    {dedupeBusy ? '扫描中…' : '开始扫描'}
                  </button>
                  <span className="dedupe-count">已选 {dedupePaths.length} 个</span>
                </div>

                {dedupeErr && <div className="compare-banner err">{dedupeErr}</div>}

                {dedupePaths.length > 0 && (
                  <ul className="dedupe-file-list">
                    {dedupePaths.map((p) => (
                      <li key={p} className="dedupe-file-row">
                        <div className="dedupe-file-info">
                          <span className="dedupe-file-name">{basename(p)}</span>
                          <span className="dedupe-file-path">{p}</span>
                        </div>
                        <button type="button" className="dedupe-remove" onClick={() => removeDedupePath(p)}>
                          移除
                        </button>
                      </li>
                    ))}
                  </ul>
                )}

                {dedupeGroups !== null && (
                  <div className="dedupe-results">
                    <h3 className="dedupe-results-title">重复组 · {dedupeGroups.length}</h3>
                    {dedupeGroups.length === 0 ? (
                      <p className="dedupe-empty">未发现重复或近似的文件组。</p>
                    ) : (
                      dedupeGroups.map((g) => (
                        <div key={g.id} className="dedupe-group-card">
                          <div className="dedupe-group-meta">
                            <span className={`dedupe-reason ${g.reason}`}>
                              {g.reason === 'sha256'
                                ? 'SHA256 完全相同'
                                : '近似重复（画面 / 音轨 / 元数据）'}
                            </span>
                            <span className="dedupe-group-id">{g.id}</span>
                          </div>
                          <ul className="dedupe-group-files">
                            {g.files.map((f) => (
                              <li key={f.path}>
                                <span className="dedupe-gname">{basename(f.path)}</span>
                                <span className="dedupe-file-path">{f.path}</span>
                                {f.durationSec != null && (
                                  <span className="dedupe-dur">{f.durationSec.toFixed(1)}s</span>
                                )}
                              </li>
                            ))}
                          </ul>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </section>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}
