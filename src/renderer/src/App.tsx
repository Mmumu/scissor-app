import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DedupeGroup, VideoInfo } from '../../shared/types'
import { DEFAULT_OBFUSCATION, type ObfuscationOptions } from '../../shared/obfuscation'
import { buildCompareRows, md5SameFile, metadataSimilarityPercent } from './video-compare'
import { StitchPanel } from './components/StitchPanel'
import { ObfuscationOptions as ObfuscationOptionsPanel } from './components/ObfuscationOptions'
import { PreviewPanel } from './components/PreviewPanel'
import { RandomCutPanel } from './components/RandomCutPanel'

function basename(p: string): string {
  return p.split(/[/\\]/).pop() ?? p
}

type Status = 'idle' | 'processing' | 'done' | 'error'
type MainTab = 'transform' | 'randomcut' | 'compare' | 'dedupe' | 'stitch'

export default function App() {
  const [activeTab, setActiveTab] = useState<MainTab>('transform')
  const [ffmpegOk, setFfmpegOk] = useState(false)
  const [ffmpegMsg, setFfmpegMsg] = useState('正在检测 ffmpeg…')

  const [inputPaths, setInputPaths] = useState<string[]>([])
  const [obfOpts, setObfOpts] = useState<ObfuscationOptions>(DEFAULT_OBFUSCATION)

  const [status, setStatus] = useState<Status>('idle')
  const [processingPath, setProcessingPath] = useState<string | null>(null)
  const [errMsg, setErrMsg] = useState('')

  const [luts, setLuts] = useState<{ name: string; path: string }[]>([])
  const [mainDuration, setMainDuration] = useState<number | null>(null)
  const [mainDims, setMainDims] = useState<{ w: number; h: number } | null>(null)
  const [mainFirstFrame, setMainFirstFrame] = useState<string | null>(null)

  // 比对
  const [compareA, setCompareA] = useState<string | null>(null)
  const [compareB, setCompareB] = useState<string | null>(null)
  const [compareMd5, setCompareMd5] = useState(false)
  const [compareBusy, setCompareBusy] = useState(false)
  const [compareErr, setCompareErr] = useState('')
  const [comparePair, setComparePair] = useState<[VideoInfo, VideoInfo] | null>(null)

  // 去重
  const [dedupePaths, setDedupePaths] = useState<string[]>([])
  const [dedupeBusy, setDedupeBusy] = useState(false)
  const [dedupeErr, setDedupeErr] = useState('')
  const [dedupeGroups, setDedupeGroups] = useState<DedupeGroup[] | null>(null)

  // 拖拽
  const [dragOver, setDragOver] = useState(false)
  const dropRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    window.scissor.checkFfmpeg().then((r) => {
      setFfmpegOk(r.ok)
      setFfmpegMsg(
        r.ok
          ? `ffmpeg 已就绪 · ${r.ffmpeg}`
          : r.error ?? 'ffmpeg 不可用，请按提示安装 FFmpeg/ffprobe 或检查应用是否完整。'
      )
    })
    window.scissor.getLuts().then((list) => {
      if (list && list.length > 0) setLuts(list)
    })
  }, [])

  // 主视频选择 → 探时长用于预览
  useEffect(() => {
    if (inputPaths[0]) {
      window.scissor.ffprobeDuration(inputPaths[0]).then((r) => {
        if (r.ok && r.durationSec != null) setMainDuration(r.durationSec)
        else setMainDuration(null)
      })
      window.scissor.getVideoDims(inputPaths[0]).then((r) => {
        if (r.ok && r.w && r.h) setMainDims({ w: r.w, h: r.h })
        else setMainDims(null)
      })
      window.scissor.extractFirstFrame(inputPaths[0]).then((r) => {
        if (r.ok && r.dataUrl) setMainFirstFrame(r.dataUrl)
        else setMainFirstFrame(null)
      })
    } else {
      setMainDuration(null)
      setMainDims(null)
      setMainFirstFrame(null)
    }
  }, [inputPaths])

  const compareAnalysis = useMemo(() => {
    if (!comparePair) return null
    const [va, vb] = comparePair
    return {
      score: metadataSimilarityPercent(va, vb),
      rows: buildCompareRows(va, vb),
      md5: md5SameFile(va, vb)
    }
  }, [comparePair])

  const pickInput = useCallback(async () => {
    if (status === 'processing') return
    const paths = await window.scissor.pickVideos()
    if (paths && paths.length > 0) {
      setInputPaths((prev) => [...new Set([...prev, ...paths])])
      setStatus('idle')
      setErrMsg('')
    }
  }, [status])

  const removeInputPath = useCallback(
    (p: string) => {
      if (status === 'processing') return
      setInputPaths((prev) => prev.filter((x) => x !== p))
    },
    [status]
  )

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      if (status === 'processing') return
      setDragOver(false)
      const files = Array.from(e.dataTransfer.files)
      const paths = files.map((f) => (f as unknown as { path: string }).path).filter(Boolean)
      if (paths.length > 0) {
        setInputPaths((prev) => [...new Set([...prev, ...paths])])
        setStatus('idle')
        setErrMsg('')
      }
    },
    [status]
  )

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
      if (r.ok && r.groups) setDedupeGroups(r.groups)
      else setDedupeErr(r.error ?? '扫描失败')
    } catch (e) {
      setDedupeErr(String(e))
    } finally {
      setDedupeBusy(false)
    }
  }, [dedupePaths])

  const run = useCallback(async () => {
    if (inputPaths.length === 0) return

    let outDirOrPath: string | undefined
    if (inputPaths.length > 1) {
      outDirOrPath = await window.scissor.pickDirectory()
      if (!outDirOrPath) return
    } else {
      const p = inputPaths[0]
      const ext = p.match(/\.(\w+)$/)?.[1] ?? 'mp4'
      const name = basename(p).replace(/\.\w+$/, '') + '_out.' + ext
      outDirOrPath = await window.scissor.pickSavePath(name)
      if (!outDirOrPath) return
    }

    setStatus('processing')
    setErrMsg('')

    try {
      if (inputPaths.length === 1) {
        setProcessingPath(inputPaths[0])
        const r = await window.scissor.transformVideo(inputPaths[0], outDirOrPath!, obfOpts)
        if (!r.ok) throw new Error(r.error || '处理失败')
        setInputPaths([])
      } else {
        const outDir = outDirOrPath!.replace(/[/\\]$/, '')
        const pathsToProcess = [...inputPaths]
        for (const p of pathsToProcess) {
          setProcessingPath(p)
          const ext = p.match(/\.(\w+)$/)?.[1] ?? 'mp4'
          const name = basename(p).replace(/\.\w+$/, '') + '_out.' + ext
          const outPath = `${outDir}/${name}`
          const r = await window.scissor.transformVideo(p, outPath, obfOpts)
          if (!r.ok) throw new Error(r.error || '处理失败')
          setInputPaths((prev) => prev.filter((x) => x !== p))
        }
      }
      setStatus('idle')
      setProcessingPath(null)
    } catch (e: unknown) {
      setStatus('error')
      setProcessingPath(null)
      setErrMsg(e instanceof Error ? e.message : String(e))
    }
  }, [inputPaths, obfOpts])

  const isReady = ffmpegOk && inputPaths.length > 0

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
          {(
            [
              { id: 'transform' as const, label: '过原创' },
              { id: 'randomcut' as const, label: '随心剪' },
              { id: 'compare' as const, label: '视频对比' },
              { id: 'dedupe' as const, label: '去重' },
              { id: 'stitch' as const, label: '边缘条带混剪' }
            ] as const
          ).map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={activeTab === t.id}
              className={`main-tab ${activeTab === t.id ? 'active' : ''}`}
              onClick={() => setActiveTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>

        {activeTab === 'randomcut' && (
          <div className="tab-panel tab-panel--randomcut">
            <RandomCutPanel ffmpegOk={ffmpegOk} luts={luts} />
          </div>
        )}

        {activeTab === 'transform' && (
          <div className="tab-panel tab-panel--transform">
            <div className="transform-layout">
              {/* 左：源 + 预览 */}
              <section className="panel drop-panel">
                <h2 className="panel-title">① 选择源视频</h2>
                <div
                  ref={dropRef}
                  className={`dropzone ${dragOver ? 'drag-over' : ''} ${
                    inputPaths.length > 0 ? 'has-file' : ''
                  } ${status === 'processing' ? 'disabled' : ''}`}
                  onClick={pickInput}
                  onDragOver={(e) => {
                    e.preventDefault()
                    if (status !== 'processing') setDragOver(true)
                  }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={handleDrop}
                >
                  {inputPaths.length > 0 ? (
                    <>
                      <div className="file-icon">🎬</div>
                      <div className="file-name">已选择 {inputPaths.length} 个视频</div>
                      {status !== 'processing' && <div className="file-hint">点击或拖入继续添加</div>}
                    </>
                  ) : (
                    <>
                      <div className="drop-icon">⬆</div>
                      <div className="drop-label">拖入视频或点击选择(支持多选)</div>
                      <div className="drop-hint">支持 mp4 / mov / mkv / m4v / webm / avi</div>
                    </>
                  )}
                </div>

                {inputPaths.length > 0 && (
                  <ul className="source-video-list">
                    {inputPaths.map((p) => (
                      <li key={p} className={processingPath === p ? 'is-processing' : ''}>
                        <div className="source-video-info">
                          <span className="source-video-name">{basename(p)}</span>
                          {processingPath === p && <span className="source-video-status">处理中…</span>}
                        </div>
                        {status !== 'processing' && (
                          <button
                            className="del-btn"
                            onClick={(e) => {
                              e.stopPropagation()
                              removeInputPath(p)
                            }}
                            title="移除"
                          >
                            ×
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}

                <PreviewPanel
                  mode="transform"
                  mainPath={inputPaths[0] ?? null}
                  obfuscation={obfOpts}
                  durationSec={mainDuration}
                  disabled={status === 'processing'}
                />
              </section>

              {/* 右：扰动配置 + 运行 */}
              <section className="panel opts-panel">
                <div className="opts-panel-head">
                  <h2 className="panel-title">② 过原创参数</h2>
                  <button
                    type="button"
                    className="reset-btn"
                    onClick={() => setObfOpts(DEFAULT_OBFUSCATION)}
                    disabled={status === 'processing'}
                  >
                    恢复默认
                  </button>
                </div>

                <ObfuscationOptionsPanel
                  value={obfOpts}
                  onChange={setObfOpts}
                  disabled={status === 'processing'}
                  luts={luts}
                  stickerPreviewContext={
                    mainDims
                      ? { targetDims: mainDims, bgUrl: mainFirstFrame }
                      : undefined
                  }
                />

                <div className="run-area">
                  <button
                    id="run-btn"
                    type="button"
                    className={`run-btn ${status === 'processing' ? 'busy' : ''}`}
                    disabled={!isReady || status === 'processing'}
                    onClick={run}
                  >
                    {status === 'processing' ? (
                      <>
                        <span className="spinner" /> 正在处理中…
                      </>
                    ) : inputPaths.length > 1 ? (
                      '开始批量处理'
                    ) : (
                      '开始处理'
                    )}
                  </button>

                  {errMsg && (
                    <div className="result err">
                      <div className="result-icon">❌</div>
                      <div className="result-text">
                        <strong>提交任务失败</strong>
                        <span className="result-path">{errMsg}</span>
                      </div>
                    </div>
                  )}
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
                      <span className="compare-slot-file">
                        {compareA ? basename(compareA) : '点击选择'}
                      </span>
                    </button>
                    <span className="compare-vs">vs</span>
                    <button
                      type="button"
                      className={`compare-slot ${compareB ? 'has' : ''}`}
                      disabled={!ffmpegOk}
                      onClick={pickCompareRight}
                    >
                      <span className="compare-slot-label">视频 B</span>
                      <span className="compare-slot-file">
                        {compareB ? basename(compareB) : '点击选择'}
                      </span>
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

                {compareErr && <div className="compare-banner err">{compareErr}</div>}

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
                  <button type="button" className="dedupe-btn primary" disabled={!ffmpegOk} onClick={addDedupeVideos}>
                    添加视频
                  </button>
                  <button type="button" className="dedupe-btn" disabled={dedupePaths.length === 0} onClick={clearDedupePaths}>
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
                              {g.reason === 'sha256' ? 'SHA256 完全相同' : '近似重复（画面 / 音轨 / 元数据）'}
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

        {activeTab === 'stitch' && (
          <div className="tab-panel tab-panel--stitch">
            <StitchPanel ffmpegOk={ffmpegOk} luts={luts} />
          </div>
        )}
      </main>
    </div>
  )
}
