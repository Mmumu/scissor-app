import { useEffect, useMemo, useRef, useState } from 'react'
import type { AudioMeta, ClipMeta, LibraryIndex } from '../../../../shared/library'
import {
  resolveTargetDims,
  TARGET_LABEL,
  type ClipOverride,
  type MixRenderProgressEvent,
  type MixTimeline,
  type TargetResolution
} from '../../../../shared/mix'
import { DEFAULT_OBFUSCATION, type ObfuscationOptions } from '../../../../shared/obfuscation'
import { TimelineStrip } from './TimelineStrip'
import { TimelinePlayback, type PlaybackSegment } from './TimelinePlayback'
import { ObfuscationOptions as ObfuscationOptionsPanel } from '../ObfuscationOptions'

type Props = {
  index: LibraryIndex
  initialClipIds: string[]
  initialAudioIds: string[]
  luts: { name: string; path: string }[]
  onClose: () => void
  onRefreshLibrary: () => void
}

const TARGET_OPTIONS: TargetResolution[] = ['source', '720p', '1080p', 'vertical-720', 'vertical-1080']

function defaultMixObf(): ObfuscationOptions {
  // 混剪场景默认开几何/颜色/音频/细节，preset 标 "custom"
  const o = structuredClone(DEFAULT_OBFUSCATION)
  o.preset = 'custom'
  o.geometry.enabled = true
  o.geometry.hflip = false
  o.geometry.randomCrop = true
  o.geometry.cropPx = 4
  o.color.enabled = true
  o.color.noise = 1
  o.audio.enabled = true
  o.detail.enabled = true
  o.encode.crf = 23
  return o
}

export function MixWorkspace({
  index,
  initialClipIds,
  initialAudioIds,
  luts,
  onClose,
  onRefreshLibrary
}: Props) {
  const [clipIds, setClipIds] = useState<string[]>(initialClipIds)
  const [audioIds, setAudioIds] = useState<string[]>(initialAudioIds)
  const [audioMode, setAudioMode] = useState<MixTimeline['audioMode']>(
    initialAudioIds.length > 0 ? 'replace' : 'embed'
  )
  const [audioLoop, setAudioLoop] = useState(true)
  const [target, setTarget] = useState<TargetResolution>('source')
  const [obf, setObf] = useState<ObfuscationOptions>(defaultMixObf())
  const [renderBusy, setRenderBusy] = useState(false)
  const [renderProgress, setRenderProgress] = useState<MixRenderProgressEvent | null>(null)
  const [renderDone, setRenderDone] = useState<{ outputPath: string } | null>(null)
  const [asideTab, setAsideTab] = useState<'clips' | 'audio'>('clips')
  const [timelineSel, setTimelineSel] = useState<Set<number>>(new Set())
  const [clipOverrides, setClipOverrides] = useState<Record<number, ClipOverride>>({})
  const [stickerBgUrl, setStickerBgUrl] = useState<string | null>(null)

  const clipMap = useMemo(() => new Map(index.clips.map((c) => [c.id, c])), [index.clips])
  const audioMap = useMemo(() => new Map(index.audios.map((a) => [a.id, a])), [index.audios])
  const orderedClips = useMemo(
    () => clipIds.map((id) => clipMap.get(id)).filter(Boolean) as ClipMeta[],
    [clipIds, clipMap]
  )
  const orderedAudios = useMemo(
    () => audioIds.map((id) => audioMap.get(id)).filter(Boolean) as AudioMeta[],
    [audioIds, audioMap]
  )
  const importColors = useMemo(() => {
    const m = new Map<string, string>()
    const palette = ['#f97316', '#22c55e', '#3b82f6', '#a855f7', '#ef4444', '#14b8a6', '#eab308', '#ec4899']
    index.imports.forEach((r, i) => m.set(r.id, palette[i % palette.length]))
    return m
  }, [index.imports])

  const totalDur = orderedClips.reduce((a, c) => a + c.durationSec, 0)
  const firstDims =
    orderedClips[0] ? { w: orderedClips[0].width, h: orderedClips[0].height } : { w: 1280, h: 720 }
  const targetDims = resolveTargetDims(target, firstDims)

  /** 从 clips + overrides 生成 PlaybackSegment[] */
  const playbackSegments: PlaybackSegment[] = useMemo(() =>
    orderedClips.map((clip, i) => {
      const ov = clipOverrides[i]
      return {
        clip,
        startSec: ov?.startSec ?? 0,
        durationSec: ov?.durationSec ?? clip.durationSec
      }
    }),
    [orderedClips, clipOverrides]
  )

  // 加载首张缩略图作为贴图预览背景
  useEffect(() => {
    const first = orderedClips[0]
    if (!first) { setStickerBgUrl(null); return }
    let cancelled = false
    window.scissor.library.readAsBase64(first.thumbRel).then((r) => {
      if (cancelled) return
      if (r.ok && r.base64) setStickerBgUrl(`data:${r.mime};base64,${r.base64}`)
    })
    return () => { cancelled = true }
  }, [orderedClips[0]?.thumbRel])

  // mix progress
  useEffect(() => {
    const off = window.scissor.mix.onProgress((ev) => {
      setRenderProgress(ev)
      if (ev.phase === 'done') {
        setRenderDone({ outputPath: ev.outputPath })
        setRenderBusy(false)
        onRefreshLibrary()
      } else if (ev.phase === 'error') {
        setRenderBusy(false)
      }
    })
    return off
  }, [onRefreshLibrary])



  function buildTimeline(): MixTimeline {
    return {
      clipIds,
      clipOverrides: Object.keys(clipOverrides).length > 0 ? clipOverrides : undefined,
      audioMode,
      audioIds,
      audioLoop,
      target,
      obfuscation: obf
    }
  }

  function handleShuffle(): void {
    const a = clipIds.slice()
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[a[i], a[j]] = [a[j], a[i]]
    }
    setClipIds(a)
  }

  function handleRemoveClip(id: string): void {
    setClipIds((prev) => prev.filter((x) => x !== id))
  }

  function handleAddMoreClips(ids: string[]): void {
    setClipIds((prev) => [...prev, ...ids.filter((x) => !prev.includes(x))])
  }


  async function handleRender(): Promise<void> {
    if (clipIds.length === 0) return
    const out = await window.scissor.mix.pickOutputPath(
      `mix_${Date.now().toString(36)}.mp4`
    )
    if (!out) return
    setRenderBusy(true)
    setRenderProgress({ phase: 'preparing' })
    setRenderDone(null)
    const r = await window.scissor.mix.render({
      timeline: buildTimeline(),
      outputPath: out
    })
    if (!r.ok) {
      setRenderProgress({ phase: 'error', error: r.error ?? '生成失败' })
      setRenderBusy(false)
    }
  }

  return (
    <div className="mix-workspace">
      <div className="mix-workspace-head">
        <button type="button" className="ghost-btn" onClick={onClose}>
          ← 返回素材池
        </button>
        <h2>混剪台</h2>
        <div className="mix-workspace-head-right">
          <span className="mix-workspace-stats">
            {clipIds.length} 段 · {totalDur.toFixed(1)}s · 目标 {targetDims.w}×{targetDims.h}
          </span>
        </div>
      </div>

      <div className="mix-workspace-body">
        {/* 左：视频片段 / 音频 Tab 切换 */}
        <aside className="mix-aside">
          <div className="mix-aside-tabs">
            <button
              type="button"
              className={`mix-aside-tab ${asideTab === 'clips' ? 'active' : ''}`}
              onClick={() => setAsideTab('clips')}
            >
              视频片段
              <span className="mix-aside-tab-meta">
                {clipIds.length}/{index.clips.length}
              </span>
            </button>
            <button
              type="button"
              className={`mix-aside-tab ${asideTab === 'audio' ? 'active' : ''}`}
              onClick={() => setAsideTab('audio')}
            >
              音频
              <span className="mix-aside-tab-meta">
                {audioIds.length}/{index.audios.length}
              </span>
            </button>
          </div>

          {asideTab === 'clips' ? (
            index.clips.length === 0 ? (
              <div className="mix-aside-empty">无视频片段</div>
            ) : (
              index.imports.map((rec) => {
                const color = importColors.get(rec.id) ?? '#666'
                const clipsInImport = index.clips.filter((c) => c.importId === rec.id)
                if (clipsInImport.length === 0) return null
                const usedCount = clipsInImport.filter((c) => clipIds.includes(c.id)).length
                return (
                  <CollapsibleSection
                    key={rec.id}
                    title={
                      <span className="mix-aside-group-title">
                        <span className="source-dot" style={{ background: color }} />
                        {basename(rec.sourcePath)}
                      </span>
                    }
                    meta={`${usedCount}/${clipsInImport.length}`}
                  >
                    {clipsInImport.map((c) => {
                      const used = clipIds.includes(c.id)
                      return (
                        <AsideClipRow
                          key={c.id}
                          clip={c}
                          used={used}
                          color={color}
                          onAdd={() => {
                            if (!used) setClipIds((prev) => [...prev, c.id])
                          }}
                        />
                      )
                    })}
                  </CollapsibleSection>
                )
              })
            )
          ) : index.audios.length === 0 ? (
            <div className="mix-aside-empty">无音频</div>
          ) : (
            index.audios.map((a) => {
              const used = audioIds.includes(a.id)
              return (
                <div
                  key={a.id}
                  className={`mix-aside-audio-row ${used ? 'used' : ''}`}
                  onClick={() => {
                    if (used) setAudioIds((prev) => prev.filter((x) => x !== a.id))
                    else setAudioIds((prev) => [...prev, a.id])
                  }}
                >
                  <span className="mix-aside-audio-label">{a.label}</span>
                  <span className="mix-aside-audio-dur">{a.durationSec.toFixed(1)}s</span>
                  <span className="mix-aside-audio-flag">{used ? '✓' : '+'}</span>
                </div>
              )
            })
          )}
        </aside>

        <div className="mix-resizer" />

        {/* 中：时间线 + 预览 */}
        <main className="mix-main">
          <div className="mix-main-toolbar">
            <button
              type="button"
              className="ghost-btn small"
              onClick={handleShuffle}
              disabled={clipIds.length < 2}
            >
              🔀 随机洗牌
            </button>
            <button
              type="button"
              className="ghost-btn small"
              onClick={() =>
                handleAddMoreClips(
                  index.clips.map((c) => c.id).filter((id) => !clipIds.includes(id))
                )
              }
              disabled={index.clips.length === clipIds.length}
            >
              + 全部加入
            </button>
            <button
              type="button"
              className="ghost-btn small"
              onClick={() => setClipIds([])}
              disabled={clipIds.length === 0}
            >
              清空
            </button>
            <div className="mix-main-toolbar-spacer" />
            <label className="mix-target-select">
              输出
              <select value={target} onChange={(e) => setTarget(e.target.value as TargetResolution)}>
                {TARGET_OPTIONS.map((t) => (
                  <option key={t} value={t}>
                    {TARGET_LABEL[t]}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <TimelineStrip
            clips={orderedClips}
            importColors={importColors}
            overrides={clipOverrides}
            clipGroups={index.clipGroups}
            selectedIndices={timelineSel}
            onSelectionChange={setTimelineSel}
            onReorder={(ids, nextSel) => {
              setClipIds(ids)
              setClipOverrides({}) // 重排后 override 下标失效，清空
              if (nextSel) setTimelineSel(nextSel)
            }}
            onBulkRemove={(indices) => {
              setClipIds((prev) => prev.filter((_, i) => !indices.has(i)))
              setClipOverrides({})
              setTimelineSel(new Set())
            }}
          />

          {/* 音频策略 */}
          <div className="mix-audio-strategy">
            <div className="mix-audio-strategy-title">音频策略</div>
            <div className="mix-audio-modes">
              <label className={audioMode === 'embed' ? 'active' : ''}>
                <input
                  type="radio"
                  checked={audioMode === 'embed'}
                  onChange={() => setAudioMode('embed')}
                />
                跟随片段（需所有段都有音轨）
              </label>
              <label className={audioMode === 'replace' ? 'active' : ''}>
                <input
                  type="radio"
                  checked={audioMode === 'replace'}
                  onChange={() => setAudioMode('replace')}
                />
                替换为：
                <span className="mix-audio-replace-list">
                  {orderedAudios.length === 0
                    ? '切换到「音频池」标签选择'
                    : orderedAudios.map((a) => a.label).join(' + ')}
                </span>
              </label>
              <label className={audioMode === 'silent' ? 'active' : ''}>
                <input
                  type="radio"
                  checked={audioMode === 'silent'}
                  onChange={() => setAudioMode('silent')}
                />
                静音
              </label>
            </div>
            {audioMode === 'replace' && (
              <label className="mix-audio-loop">
                <input
                  type="checkbox"
                  checked={audioLoop}
                  onChange={(e) => setAudioLoop(e.target.checked)}
                />
                音频比视频短时循环
              </label>
            )}
            {audioMode === 'replace' && (() => {
              const audioDur = orderedAudios.reduce((a, x) => a + x.durationSec, 0)
              const diff = audioDur - totalDur
              const maxDur = Math.max(totalDur, audioDur, 0.01)
              const videoPct = (totalDur / maxDur) * 100
              const audioPct = (audioDur / maxDur) * 100
              return (
                <div className="mix-audio-compare">
                  <div className="mix-audio-compare-row">
                    <span className="mix-audio-compare-label">🎬 视频</span>
                    <div className="mix-audio-compare-bar">
                      <div
                        className="mix-audio-compare-fill video"
                        style={{ width: `${videoPct}%` }}
                      />
                    </div>
                    <span className="mix-audio-compare-val">{totalDur.toFixed(1)}s</span>
                  </div>
                  <div className="mix-audio-compare-row">
                    <span className="mix-audio-compare-label">♪ 音频</span>
                    <div className="mix-audio-compare-bar">
                      <div
                        className="mix-audio-compare-fill audio"
                        style={{ width: `${audioPct}%` }}
                      />
                    </div>
                    <span className="mix-audio-compare-val">{audioDur.toFixed(1)}s</span>
                  </div>
                  <div className="mix-audio-compare-diff">
                    {audioDur === 0
                      ? '← 切到「音频」标签选择音频'
                      : Math.abs(diff) < 0.1
                        ? '✓ 时长刚好匹配'
                        : diff > 0
                          ? `音频多 ${diff.toFixed(1)}s（${audioLoop ? '将截断' : '尾部会被截断'}）`
                          : `音频短 ${(-diff).toFixed(1)}s（${audioLoop ? '将循环补齐' : '尾部将无声'}）`}
                  </div>
                </div>
              )
            })()}
          </div>

          {/* 试听（内联播放片段+音频，无需重新编码） */}
          <TimelinePlayback
            segments={playbackSegments}
            audioMode={audioMode}
            audios={orderedAudios}
            audioLoop={audioLoop}
            importColors={importColors}
          />
        </main>

        <div className="mix-resizer" />

        {/* 右：过原创参数 */}
        <aside className="mix-options">
          <h4>过原创参数</h4>
          <ObfuscationOptionsPanel
            value={obf}
            onChange={setObf}
            luts={luts}
            hide={{ concat: true, trim: true }}
            showPresetBar
            stickerPreviewContext={{ targetDims, bgUrl: stickerBgUrl }}
          />
        </aside>
      </div>

      {/* 底部生成栏 */}
      <div className="mix-workspace-foot">
        {renderProgress && (
          <div className="mix-render-progress">
            <span className="mix-render-phase">
              {renderProgress.phase === 'preparing' && '准备中'}
              {renderProgress.phase === 'concat' && `拼接 ${Math.round((renderProgress.pct ?? 0) * 100)}%`}
              {renderProgress.phase === 'audio' && '音频合成'}
              {renderProgress.phase === 'obfuscation' &&
                `过原创 ${Math.round((renderProgress.pct ?? 0) * 100)}%`}
              {renderProgress.phase === 'done' && (
                <>已输出到 <code>{renderDone?.outputPath}</code></>
              )}
              {renderProgress.phase === 'error' && (
                <span className="mix-render-err">失败：{renderProgress.error}</span>
              )}
            </span>
            {(renderProgress.phase === 'concat' || renderProgress.phase === 'obfuscation') && (
              <div className="mix-render-bar">
                <div
                  className="mix-render-bar-fill"
                  style={{ width: `${(renderProgress.pct ?? 0) * 100}%` }}
                />
              </div>
            )}
          </div>
        )}
        <button
          type="button"
          className="primary-btn big"
          onClick={handleRender}
          disabled={renderBusy || clipIds.length === 0}
        >
          {renderBusy ? '生成中…' : '导出 MP4 →'}
        </button>
      </div>
    </div>
  )
}

function CollapsibleSection({
  title,
  meta,
  defaultOpen = true,
  children
}: {
  title: React.ReactNode
  meta?: string
  defaultOpen?: boolean
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className={`mix-collapsible ${open ? 'open' : ''}`}>
      <button type="button" className="mix-collapsible-head" onClick={() => setOpen((v) => !v)}>
        <span className="mix-collapsible-arrow">{open ? '▾' : '▸'}</span>
        <span className="mix-collapsible-title">{title}</span>
        {meta != null && <span className="mix-collapsible-meta">{meta}</span>}
      </button>
      {open && <div className="mix-collapsible-body">{children}</div>}
    </div>
  )
}

function basename(p: string): string {
  return p.split(/[/\\]/).pop() ?? p
}

function AsideClipRow({
  clip,
  used,
  color,
  onAdd
}: {
  clip: ClipMeta
  used: boolean
  color: string
  onAdd: () => void
}) {
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
      className={`mix-aside-clip ${used ? 'used' : ''}`}
      onClick={() => {
        if (!used) onAdd()
      }}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      title={used ? '已在时间线' : '点击加入时间线'}
    >
      <div className="mix-aside-clip-thumb">
        {hovering && videoUrl ? (
          <video src={videoUrl} autoPlay muted loop playsInline />
        ) : thumb ? (
          <img src={thumb} alt="" draggable={false} />
        ) : (
          <div className="mix-aside-clip-loading">…</div>
        )}
        <span className="mix-aside-clip-badge mix-aside-clip-index" style={{ background: color }}>
          #{clip.index + 1}
        </span>
        <span className="mix-aside-clip-badge mix-aside-clip-dur">{clip.durationSec.toFixed(1)}s</span>
        {used && <span className="mix-aside-clip-check">✓</span>}
      </div>
      <div className="mix-aside-clip-foot">
        <span className="mix-aside-clip-flag">{used ? '已加' : '点击加入'}</span>
      </div>
    </div>
  )
}
