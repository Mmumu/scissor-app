import { useCallback, useEffect, useState } from 'react'
import { DEFAULT_OBFUSCATION, type ObfuscationOptions } from '../../../shared/obfuscation'
import { ObfuscationOptions as ObfuscationOptionsPanel } from './ObfuscationOptions'
import { PreviewPanel } from './PreviewPanel'
import {
  StitchInsertPicker,
  type InsertPosition
} from './StitchInsertPicker'

function basename(p: string): string {
  return p.split(/[/\\]/).pop() ?? p
}

type ProgressInfo = { file: string; time: string; speed: string; raw: string }

function timeStringToSeconds(timeStr: string): number {
  if (!timeStr) return 0
  const parts = timeStr.split(':')
  if (parts.length !== 3) return 0
  return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2])
}

type Props = {
  ffmpegOk: boolean
  luts?: { name: string; path: string }[]
}

export function StitchPanel({ ffmpegOk, luts = [] }: Props) {
  const [mainPaths, setMainPaths] = useState<string[]>([])
  const [insertPath, setInsertPath] = useState<string | null>(null)
  const [insertSizePx, setInsertSizePx] = useState(1)
  const [insertPositions, setInsertPositions] = useState<InsertPosition[]>([
    { side: 'top', offsetPx: 0 },
    { side: 'bottom', offsetPx: 0 }
  ])

  const [obfOpts, setObfOpts] = useState<ObfuscationOptions>(() => ({
    ...DEFAULT_OBFUSCATION,
    geometry: { ...DEFAULT_OBFUSCATION.geometry, rotateJitter: true, randomCrop: true },
    audio: { ...DEFAULT_OBFUSCATION.audio, eqMode: 'random3band', volumeJitter: true },
    speed: { ...DEFAULT_OBFUSCATION.speed, jitter: true },
    trim: { ...DEFAULT_OBFUSCATION.trim, randomStartJitter: true },
    detail: { ...DEFAULT_OBFUSCATION.detail, gblurSigma: 0.3 }
  }))

  const [status, setStatus] = useState<'idle' | 'processing' | 'error'>('idle')
  const [videoDims, setVideoDims] = useState<{ w: number; h: number } | null>(null)
  const [mainFirstFrame, setMainFirstFrame] = useState<string | null>(null)
  const [mainDuration, setMainDuration] = useState<number | null>(null)
  const [processingPath, setProcessingPath] = useState<string | null>(null)
  const [progressInfo, setProgressInfo] = useState<ProgressInfo | null>(null)
  const [errMsg, setErrMsg] = useState('')

  useEffect(() => {
    return window.scissor.onFfmpegProgress((info) => setProgressInfo(info))
  }, [])

  // 选了主视频 → 探维度 + 时长 + 首帧
  useEffect(() => {
    if (mainPaths[0]) {
      window.scissor.getVideoDims(mainPaths[0]).then((r) => {
        if (r.ok && r.w && r.h) setVideoDims({ w: r.w, h: r.h })
        else setVideoDims(null)
      })
      window.scissor.ffprobeDuration(mainPaths[0]).then((r) => {
        if (r.ok && r.durationSec != null) setMainDuration(r.durationSec)
        else setMainDuration(null)
      })
      window.scissor.extractFirstFrame(mainPaths[0]).then((r) => {
        if (r.ok && r.dataUrl) setMainFirstFrame(r.dataUrl)
        else setMainFirstFrame(null)
      })
    } else {
      setVideoDims(null)
      setMainDuration(null)
      setMainFirstFrame(null)
    }
  }, [mainPaths])

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
    }
  }, [status])

  const pickInsertVideo = useCallback(async () => {
    if (status === 'processing') return
    const paths = await window.scissor.pickVideos()
    if (paths && paths.length > 0) setInsertPath(paths[0])
  }, [status])

  const removeMainPath = useCallback(
    (p: string) => {
      if (status === 'processing') return
      setMainPaths((prev) => prev.filter((x) => x !== p))
    },
    [status]
  )

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
        const r = await window.scissor.stitchVideo({
          mainPath: mainPaths[0],
          insertPath,
          outputPath: outDirOrPath!,
          insertSizePx,
          insertPositions,
          obfuscation: obfOpts
        })
        if (!r.ok) throw new Error(r.error || '处理失败')
        setMainPaths([])
      } else {
        const outDir = outDirOrPath!.replace(/[/\\]$/, '')
        const pathsToProcess = [...mainPaths]
        for (const p of pathsToProcess) {
          setProcessingPath(p)
          const ext = p.match(/\.(\w+)$/)?.[1] ?? 'mp4'
          const name = basename(p).replace(/\.\w+$/, '') + '_stitch.' + ext
          const outPath = `${outDir}/${name}`
          const r = await window.scissor.stitchVideo({
            mainPath: p,
            insertPath,
            outputPath: outPath,
            insertSizePx,
            insertPositions,
            obfuscation: obfOpts
          })
          if (!r.ok) throw new Error(r.error || '处理失败')
          setMainPaths((prev) => prev.filter((x) => x !== p))
        }
      }
      setStatus('idle')
      setProcessingPath(null)
    } catch (e: unknown) {
      setStatus('error')
      setProcessingPath(null)
      setErrMsg(e instanceof Error ? e.message : String(e))
    }
  }, [mainPaths, insertPath, insertSizePx, insertPositions, obfOpts])

  return (
    <div className="tab-panel-scroll stitch-scroll">
      <section className="stitch-panel">
        <div className="stitch-head">
          <h2 className="stitch-title">边缘条带混剪（轻度过原创）</h2>
          <p className="stitch-sub">
            在主视频边缘叠加极细的 B 视频条带 + 全局微扰。
            <strong> ⚠ 对抖音/YouTube 的 CNN/embedding 检测帮助有限</strong>，
            强查重平台建议结合多源时间轴混剪。
          </p>
        </div>

        {/* ① 源文件 */}
        <div className="stitch-section">
          <h3 className="stitch-section-title">① 源文件</h3>
          <div className="stitch-sources">
            <div className="stitch-source-card">
              <div className="stitch-source-card-head">
                <span>主视频 A（批量）</span>
                <button
                  type="button"
                  className="dedupe-btn"
                  disabled={!ffmpegOk || status === 'processing'}
                  onClick={pickMainVideos}
                >
                  + 添加
                </button>
              </div>
              {mainPaths.length > 0 && (
                <ul className="source-video-list">
                  {mainPaths.map((p) => {
                    let pct = 0
                    if (processingPath === p && progressInfo && mainDuration) {
                      pct = Math.min(100, Math.round((timeStringToSeconds(progressInfo.time) / mainDuration) * 100))
                    }
                    return (
                      <li key={p} className={processingPath === p ? 'is-processing' : ''}>
                        {processingPath === p && pct > 0 && (
                          <div className="source-video-progress" style={{ width: `${pct}%` }} />
                        )}
                        <div className="source-video-info">
                          <span className="source-video-name">{basename(p)}</span>
                          {processingPath === p && (
                            <span className="source-video-status">
                              {pct}% {progressInfo?.speed ? `· ${progressInfo.speed}` : ''}
                            </span>
                          )}
                        </div>
                        {status !== 'processing' && (
                          <button className="del-btn" onClick={() => removeMainPath(p)} title="移除">
                            ×
                          </button>
                        )}
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>

            <div className="stitch-source-card">
              <div className="stitch-source-card-head">
                <span>插入视频 B</span>
                <button
                  type="button"
                  className="dedupe-btn"
                  disabled={!ffmpegOk || status === 'processing'}
                  onClick={pickInsertVideo}
                >
                  选择
                </button>
              </div>
              {insertPath && (
                <div className="stitch-insert-file">
                  <span className="stitch-insert-file-name">{basename(insertPath)}</span>
                  <button className="del-btn" onClick={() => setInsertPath(null)} title="移除">
                    ×
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ② 条带配置 */}
        <div className="stitch-section">
          <h3 className="stitch-section-title">② 条带插入</h3>
          <StitchInsertPicker
            positions={insertPositions}
            sizePx={insertSizePx}
            videoDims={videoDims}
            disabled={status === 'processing'}
            onChange={({ positions, sizePx }) => {
              setInsertPositions(positions)
              setInsertSizePx(sizePx)
            }}
          />
        </div>

        {/* ③ 扰动 */}
        <div className="stitch-section">
          <h3 className="stitch-section-title">③ 过原创扰动</h3>
          <ObfuscationOptionsPanel
            value={obfOpts}
            onChange={setObfOpts}
            disabled={status === 'processing'}
            luts={luts}
            hide={{ concat: true, trim: false }}
            stickerPreviewContext={
              videoDims
                ? { targetDims: videoDims, bgUrl: mainFirstFrame }
                : undefined
            }
          />
        </div>

        {/* ④ 预览 + 输出 */}
        <div className="stitch-section">
          <h3 className="stitch-section-title">④ 预览 / 输出</h3>
          <PreviewPanel
            mode="stitch"
            mainPath={mainPaths[0] ?? null}
            obfuscation={obfOpts}
            insertPath={insertPath}
            insertSizePx={insertSizePx}
            insertPositions={insertPositions}
            durationSec={mainDuration}
            disabled={status === 'processing'}
          />

          <div className="run-area" style={{ marginTop: 16 }}>
            <button
              type="button"
              className={`run-btn ${status === 'processing' ? 'busy' : ''}`}
              disabled={!ffmpegOk || mainPaths.length === 0 || !insertPath || status === 'processing'}
              onClick={runStitch}
            >
              {status === 'processing' ? (
                <>
                  <span className="spinner" /> 处理中…
                </>
              ) : mainPaths.length > 1 ? (
                '开始批量处理'
              ) : (
                '开始处理'
              )}
            </button>
            {errMsg && <div className="compare-banner err">{errMsg}</div>}
          </div>
        </div>
      </section>
    </div>
  )
}
