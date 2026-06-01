import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ImportDialog } from './library/ImportDialog'
import { ClipCard } from './library/ClipCard'
import { ClipGroupBlock } from './library/ClipGroupBlock'
import { AudioCard } from './library/AudioCard'
import { ImportProgress, type ProgressItem } from './library/ImportProgress'
import { MixWorkspace } from './mix/MixWorkspace'
import { SourceGroupingModal } from './library/SourceGroupingModal'
import type {
  ClipGroup,
  ImportOptions,
  ImportProgressEvent,
  LibraryIndex,
  LibraryStats
} from '../../../shared/library'
import { buildRenderUnits, evaluateGrouping } from '../utils/clipGroups'

const IMPORT_COLORS = [
  '#f97316',
  '#22c55e',
  '#3b82f6',
  '#a855f7',
  '#ef4444',
  '#14b8a6',
  '#eab308',
  '#ec4899'
]

type Props = {
  ffmpegOk: boolean
  luts: { name: string; path: string }[]
}

/**
 * 左侧分类侧栏的当前选中项。
 *  - all      显示视频 + 音频（按类型分组）
 *  - videos   只显示视频
 *  - audios   只显示音频
 *  - 字符串以 'src:' 开头视为按来源筛选（仅过滤视频）
 */
type Category = 'all' | 'videos' | 'audios' | `src:${string}`

export function RandomCutPanel({ ffmpegOk, luts }: Props) {
  const [index, setIndex] = useState<LibraryIndex | null>(null)
  const [stats, setStats] = useState<LibraryStats | null>(null)
  const [pickedFiles, setPickedFiles] = useState<string[] | null>(null)
  const [progressItems, setProgressItems] = useState<ProgressItem[]>([])
  const [selectedClips, setSelectedClips] = useState<Set<string>>(new Set())
  const [selectedAudios, setSelectedAudios] = useState<Set<string>>(new Set())
  const [category, setCategory] = useState<Category>('all')
  const [pendingDup, setPendingDup] = useState<{
    sourcePath: string
    sourceHash: string
    existingImportId: string
  } | null>(null)
  const [mixOpen, setMixOpen] = useState(false)
  const [sourceGroupingImportId, setSourceGroupingImportId] = useState<string | null>(null)
  const [sourceGroupingInitialMode, setSourceGroupingInitialMode] = useState<'group' | 'cut'>('group')
  const [manualCutSourceSelectorOpen, setManualCutSourceSelectorOpen] = useState(false)
  const [pendingGroupDesc, setPendingGroupDesc] = useState('')
  const lastImportOptsRef = useRef<Omit<ImportOptions, 'paths'> | null>(null)
  // shift+click 的锚点：记录最近一次普通点击在 visibleClips/visibleAudios 列表里的下标
  const clipAnchorRef = useRef<number | null>(null)
  const audioAnchorRef = useRef<number | null>(null)

  const reload = useCallback(async () => {
    const [i, s] = await Promise.all([
      window.scissor.library.list(),
      window.scissor.library.stats()
    ])
    setIndex(i)
    setStats(s)
  }, [])

  // 切换分类时锚点失效，先重置
  useEffect(() => {
    clipAnchorRef.current = null
    audioAnchorRef.current = null
  }, [category])

  // Cmd/Ctrl+A 全选当前可见、Esc 清空当前选择（混剪台开启时不抢键盘）
  useEffect(() => {
    if (mixOpen) return
    function onKey(e: KeyboardEvent): void {
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if ((e.metaKey || e.ctrlKey) && e.code === 'KeyA') {
        if (category === 'audios') {
          e.preventDefault()
          selectAllVisibleAudios()
        } else {
          e.preventDefault()
          selectAllVisibleClips()
        }
      } else if (e.code === 'Escape') {
        if (selectedClips.size > 0 || selectedAudios.size > 0) {
          setSelectedClips(new Set())
          setSelectedAudios(new Set())
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category, mixOpen, selectedClips.size, selectedAudios.size])

  useEffect(() => {
    reload()
    const off = window.scissor.library.onImportProgress((ev: ImportProgressEvent) => {
      if (ev.phase === 'duplicate') {
        setPendingDup({
          sourcePath: ev.sourcePath,
          sourceHash: ev.sourceHash,
          existingImportId: ev.existingImportId
        })
        return
      }
      setProgressItems((prev) => {
        const idx = prev.findIndex(
          (p) => p.sourcePath === ev.sourcePath && (p.importId === ev.importId || p.importId === '')
        )
        const item: ProgressItem = {
          sourcePath: ev.sourcePath,
          importId: ev.importId || (idx >= 0 ? prev[idx].importId : ''),
          phase: ev.phase,
          pct: 'pct' in ev ? ev.pct : undefined,
          current: ev.phase === 'thumbing' ? ev.current : undefined,
          total: ev.phase === 'thumbing' ? ev.total : undefined,
          error: ev.phase === 'error' ? ev.error : undefined,
          done: ev.phase === 'done' || ev.phase === 'error'
        }
        if (idx >= 0) {
          const next = prev.slice()
          next[idx] = { ...next[idx], ...item }
          return next
        }
        return [...prev, item]
      })
      if (ev.phase === 'done') {
        reload()
        if (ev.importId) setSourceGroupingImportId(ev.importId)
      } else if (ev.phase === 'error') {
        reload()
      }
    })
    return off
  }, [reload])

  const importColors = useMemo(() => {
    const m = new Map<string, string>()
    if (!index) return m
    index.imports.forEach((r, i) => m.set(r.id, IMPORT_COLORS[i % IMPORT_COLORS.length]))
    return m
  }, [index])

  async function handlePickVideos(): Promise<void> {
    const paths = await window.scissor.pickVideos()
    if (!paths || paths.length === 0) return
    setPickedFiles(paths)
  }

  async function handlePickVideosForManualCut(): Promise<void> {
    const paths = await window.scissor.pickVideos()
    if (!paths || paths.length === 0) return
    setManualCutSourceSelectorOpen(false)
    setSourceGroupingInitialMode('cut')
    // 采用免镜头切片配置快速导入占位，极速秒级入库
    await window.scissor.library.importVideos({
      paths: [paths[0]],
      audioMode: 'extract',
      cleanup: 'metadata-only',
      sceneThreshold: 1.0,
      minSegSec: 0.1,
      maxSegSec: 999999
    })
  }

  async function handleImport(opts: Omit<ImportOptions, 'paths'>): Promise<void> {
    if (!pickedFiles) return
    lastImportOptsRef.current = opts
    setPickedFiles(null)
    await window.scissor.library.importVideos({ paths: pickedFiles, ...opts })
  }

  async function handleAddAudio(): Promise<void> {
    const path = await window.scissor.library.pickAudioFile()
    if (!path) return
    const r = await window.scissor.library.importAudio(path)
    if (!r.ok) {
      alert('音频导入失败：' + (r.error ?? '未知'))
      return
    }
    reload()
  }

  async function handleDeleteSelectedClips(): Promise<void> {
    if (selectedClips.size === 0) return
    if (!confirm(`删除 ${selectedClips.size} 个视频片段？此操作不可撤销。`)) return
    await window.scissor.library.deleteClips(Array.from(selectedClips))
    setSelectedClips(new Set())
    reload()
  }

  async function handleDeleteImport(importId: string): Promise<void> {
    if (!index) return
    const rec = index.imports.find((r) => r.id === importId)
    if (!rec) return
    if (!confirm(`删除该次导入及其 ${rec.clipIds.length} 个片段？`)) return
    await window.scissor.library.deleteImport(importId)
    if (category === `src:${importId}`) setCategory('all')
    reload()
  }

  async function handleConfirmDup(policy: 'skip' | 'reimport-replace' | 'reimport-add'): Promise<void> {
    if (!pendingDup) return
    const dup = pendingDup
    setPendingDup(null)
    if (policy === 'skip') return
    const opts = lastImportOptsRef.current
    if (!opts) return
    await window.scissor.library.importVideos({
      paths: [dup.sourcePath],
      ...opts,
      duplicatePolicy: policy
    })
  }

  if (!index) {
    return <div style={{ padding: 24 }}>加载素材池中…</div>
  }

  const visibleClips =
    category === 'audios'
      ? []
      : category.startsWith('src:')
        ? index.clips.filter((c) => c.importId === category.slice(4))
        : index.clips
  const visibleAudios = category === 'videos' || category.startsWith('src:') ? [] : index.audios

  function handleClipClick(idx: number, e: React.MouseEvent): void {
    const clip = visibleClips[idx]
    if (!clip) return
    if (e.shiftKey && clipAnchorRef.current != null) {
      const anchor = clipAnchorRef.current
      // 锚点超出当前可见范围（切换分类后旧索引无效），降级为普通点击
      if (anchor < 0 || anchor >= visibleClips.length) {
        clipAnchorRef.current = idx
        toggleClip(clip.id)
        return
      }
      const start = Math.min(anchor, idx)
      const end = Math.max(anchor, idx)
      const targetSelected = selectedClips.has(clip.id)
      // 若目标已选 → 整段反选；若目标未选 → 整段选上
      setSelectedClips((prev) => {
        const next = new Set(prev)
        for (let i = start; i <= end; i++) {
          const id = visibleClips[i].id
          if (targetSelected) next.delete(id)
          else next.add(id)
        }
        return next
      })
      return
    }
    clipAnchorRef.current = idx
    toggleClip(clip.id)
  }

  function toggleClip(id: string): void {
    setSelectedClips((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function handleAudioClick(idx: number, e: React.MouseEvent): void {
    const a = visibleAudios[idx]
    if (!a) return
    if (e.shiftKey && audioAnchorRef.current != null) {
      const anchor = audioAnchorRef.current
      if (anchor < 0 || anchor >= visibleAudios.length) {
        audioAnchorRef.current = idx
        toggleAudio(a.id)
        return
      }
      const start = Math.min(anchor, idx)
      const end = Math.max(anchor, idx)
      const targetSelected = selectedAudios.has(a.id)
      setSelectedAudios((prev) => {
        const next = new Set(prev)
        for (let i = start; i <= end; i++) {
          const id = visibleAudios[i].id
          if (targetSelected) next.delete(id)
          else next.add(id)
        }
        return next
      })
      return
    }
    audioAnchorRef.current = idx
    toggleAudio(a.id)
  }

  function toggleAudio(id: string): void {
    setSelectedAudios((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function selectAllVisibleClips(): void {
    setSelectedClips((prev) => {
      const next = new Set(prev)
      visibleClips.forEach((c) => next.add(c.id))
      return next
    })
  }
  function clearVisibleClipSelection(): void {
    setSelectedClips((prev) => {
      if (visibleClips.length === 0) return prev
      const visIds = new Set(visibleClips.map((c) => c.id))
      const next = new Set<string>()
      prev.forEach((id) => {
        if (!visIds.has(id)) next.add(id)
      })
      return next
    })
  }
  function invertVisibleClipSelection(): void {
    setSelectedClips((prev) => {
      const next = new Set(prev)
      visibleClips.forEach((c) => {
        if (next.has(c.id)) next.delete(c.id)
        else next.add(c.id)
      })
      return next
    })
  }
  function selectAllVisibleAudios(): void {
    setSelectedAudios((prev) => {
      const next = new Set(prev)
      visibleAudios.forEach((a) => next.add(a.id))
      return next
    })
  }
  function clearVisibleAudioSelection(): void {
    setSelectedAudios((prev) => {
      if (visibleAudios.length === 0) return prev
      const visIds = new Set(visibleAudios.map((a) => a.id))
      const next = new Set<string>()
      prev.forEach((id) => {
        if (!visIds.has(id)) next.add(id)
      })
      return next
    })
  }

  const visibleClipsAllSelected =
    visibleClips.length > 0 && visibleClips.every((c) => selectedClips.has(c.id))
  const visibleClipsSelectedCount = visibleClips.filter((c) => selectedClips.has(c.id)).length
  const visibleAudiosAllSelected =
    visibleAudios.length > 0 && visibleAudios.every((a) => selectedAudios.has(a.id))

  const groupingEval = evaluateGrouping(index, selectedClips)
  const renderUnits = buildRenderUnits(visibleClips, index.clipGroups)

  async function handleCreateGroup(): Promise<void> {
    if (!groupingEval.canGroup || !groupingEval.importId || !groupingEval.orderedIds) {
      alert('当前选择不满足成组条件：' + (groupingEval.reason ?? '未知原因'))
      return
    }
    const api = window.scissor?.library?.createGroup
    if (typeof api !== 'function') {
      alert(
        '成组接口未加载（可能是 dev 模式下 preload 未刷新）。\n请在终端 Ctrl+C 停掉 pnpm run dev，再重新启动一次。'
      )
      return
    }
    try {
      const r = await api({
        importId: groupingEval.importId,
        clipIds: groupingEval.orderedIds,
        description: pendingGroupDesc.trim() || undefined
      })
      if (!r.ok) {
        alert('成组失败：' + (r as { error?: string }).error)
        return
      }
      setSelectedClips(new Set())
      setPendingGroupDesc('')
      reload()
    } catch (e) {
      console.error('[createGroup] failed:', e)
      alert('成组失败：' + (e instanceof Error ? e.message : String(e)))
    }
  }

  async function handleDissolveGroup(g: ClipGroup): Promise<void> {
    await window.scissor.library.deleteGroup(g.id)
    reload()
  }

  async function handleRenameGroup(g: ClipGroup, name: string): Promise<void> {
    await window.scissor.library.renameGroup(g.id, name)
    reload()
  }

  async function handleRenameClip(clip: ClipMeta, name: string): Promise<void> {
    if (window.scissor.library.renameClip) {
      await window.scissor.library.renameClip(clip.id, name)
      reload()
    } else {
      console.warn('renameClip not available in preload')
    }
  }

  async function handleUpdateGroupDesc(g: ClipGroup, description: string): Promise<void> {
    await window.scissor.library.updateGroup(g.id, { description })
    reload()
  }

  function handleToggleGroupSelect(g: ClipGroup): void {
    setSelectedClips((prev) => {
      const next = new Set(prev)
      const allIn = g.clipIds.every((id) => next.has(id))
      if (allIn) {
        g.clipIds.forEach((id) => next.delete(id))
      } else {
        g.clipIds.forEach((id) => next.add(id))
      }
      return next
    })
  }

  return (
    <div className="randomcut-root">
      <div className="randomcut-head">
        <div className="randomcut-title">
          <h2>随心剪</h2>
          <span className="randomcut-sub">
            库中
            <strong> {stats?.clipCount ?? 0} </strong>段视频 /
            <strong> {stats?.audioCount ?? 0} </strong>个音频 · 占用
            <strong> {fmtBytes(stats?.bytesUsed ?? 0)}</strong>
          </span>
        </div>
        <div className="randomcut-actions">
          <button type="button" className="primary-btn" onClick={handlePickVideos} disabled={!ffmpegOk}>
            + 导入视频
          </button>
          <button type="button" className="ghost-btn px-12" onClick={() => setManualCutSourceSelectorOpen(true)} disabled={!ffmpegOk} title="逐帧手动精确切片与剪辑视频">
            ✂ 手动精确切片
          </button>
          <button type="button" className="ghost-btn" onClick={handleAddAudio} disabled={!ffmpegOk}>
            + 添加音频
          </button>
        </div>
      </div>

      <div className="randomcut-body-wrap">
        {/* 左：分类侧栏 */}
        <aside className="randomcut-aside">
          <div className="randomcut-aside-section">
            <div className="randomcut-aside-title">素材</div>
            <CategoryRow
              icon="◎"
              label="全部"
              count={index.clips.length + index.audios.length}
              active={category === 'all'}
              onClick={() => setCategory('all')}
            />
            <CategoryRow
              icon="▶"
              label="视频片段"
              count={index.clips.length}
              active={category === 'videos'}
              onClick={() => setCategory('videos')}
            />
            <CategoryRow
              icon="♪"
              label="音频"
              count={index.audios.length}
              active={category === 'audios'}
              onClick={() => setCategory('audios')}
            />
          </div>

          {index.imports.length > 0 && (
            <div className="randomcut-aside-section">
              <div className="randomcut-aside-title">按来源</div>
              {index.imports.map((rec) => {
                const cat: Category = `src:${rec.id}`
                return (
                  <div key={rec.id} className="randomcut-aside-source">
                    <CategoryRow
                      icon={
                        <span
                          className="source-dot"
                          style={{ background: importColors.get(rec.id), marginRight: 0 }}
                        />
                      }
                      label={rec.name || basename(rec.sourcePath)}
                      count={rec.clipIds.length}
                      active={category === cat}
                      onClick={() => setCategory(cat)}
                      title={rec.name ? `${rec.name} (${rec.sourcePath})` : rec.sourcePath}
                      onRename={async (newName) => {
                        if (window.scissor.library.renameImport) {
                          await window.scissor.library.renameImport(rec.id, newName)
                          reload()
                        } else {
                          console.warn('renameImport not available')
                        }
                      }}
                    />
                    <button
                      type="button"
                      className="randomcut-aside-icon-btn"
                      onClick={(e) => {
                        e.stopPropagation()
                        setSourceGroupingInitialMode('group')
                        setSourceGroupingImportId(rec.id)
                      }}
                      title="对照原视频成组 / 手动精准切片"
                    >
                      🎬
                    </button>
                    <button
                      type="button"
                      className="randomcut-aside-x"
                      onClick={(e) => {
                        e.stopPropagation()
                        handleDeleteImport(rec.id)
                      }}
                      title="删除该批"
                    >
                      ×
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </aside>

        {/* 右：内容区 */}
        <main className="randomcut-main">
          {/* 视频区 */}
          {(category === 'all' || category === 'videos' || category.startsWith('src:')) && (
            <div className="randomcut-section">
              <div className="randomcut-section-head">
                <h3>
                  视频片段 <span className="muted">({visibleClips.length})</span>
                </h3>
                <span className="randomcut-tip">
                  提示：按住 <kbd>Shift</kbd> 点击两个卡片可批量选中 / 取消（也支持 <kbd>⌘A</kbd> 全选、<kbd>Esc</kbd> 清空）
                </span>
                <div className="randomcut-bulk">
                  {visibleClips.length > 0 && (
                    <>
                      <button
                        type="button"
                        className="ghost-btn small"
                        onClick={
                          visibleClipsAllSelected
                            ? clearVisibleClipSelection
                            : selectAllVisibleClips
                        }
                      >
                        {visibleClipsAllSelected ? '取消全选' : '全选'}
                      </button>
                      <button
                        type="button"
                        className="ghost-btn small"
                        onClick={invertVisibleClipSelection}
                      >
                        反选
                      </button>
                    </>
                  )}
                  {selectedClips.size > 0 && (
                    <>
                      <span className="randomcut-bulk-stat">
                        已选 <strong>{selectedClips.size}</strong>
                        {visibleClipsSelectedCount !== selectedClips.size && (
                          <span className="muted"> （此视图 {visibleClipsSelectedCount}）</span>
                        )}
                      </span>
                      <button
                        type="button"
                        className="ghost-btn small"
                        onClick={handleCreateGroup}
                        disabled={!groupingEval.canGroup}
                        title={groupingEval.canGroup ? '把所选连续片段成一组' : groupingEval.reason}
                      >
                        + 成组
                      </button>
                      {!groupingEval.canGroup && selectedClips.size >= 1 && (
                        <span className="randomcut-group-hint" title={groupingEval.reason}>
                          ⚠ {groupingEval.reason}
                        </span>
                      )}
                      {groupingEval.canGroup && (
                        <span className="randomcut-group-hint ok">
                          ✓ 可成 1 组{selectedClips.size === 1 ? '（单段）' : ''}
                        </span>
                      )}
                      {groupingEval.canGroup && (
                        <input
                          type="text"
                          className="randomcut-group-desc-input"
                          placeholder="组描述（可选）"
                          value={pendingGroupDesc}
                          onChange={(e) => setPendingGroupDesc(e.target.value)}
                          maxLength={200}
                        />
                      )}
                      <button
                        type="button"
                        className="ghost-btn small"
                        onClick={() => setSelectedClips(new Set())}
                      >
                        清空
                      </button>
                      <button
                        type="button"
                        className="danger-btn small"
                        onClick={handleDeleteSelectedClips}
                      >
                        删除
                      </button>
                    </>
                  )}
                </div>
              </div>
              {visibleClips.length === 0 ? (
                <div className="randomcut-empty">
                  {index.clips.length === 0 ? '还没有片段，点右上角「导入视频」开始。' : '该分类下没有片段。'}
                </div>
              ) : (
                <div className="clip-grid">
                  {(() => {
                    // visibleClips 在 renderUnits 里已经按顺序铺平；下标用 visibleClips 算（保持 shift+click 锚点）
                    const idxOfId = new Map(visibleClips.map((c, i) => [c.id, i] as const))
                    return renderUnits.map((u) => {
                      if (u.kind === 'clip') {
                        const i = idxOfId.get(u.clip.id) ?? 0
                        return (
                          <ClipCard
                            key={u.clip.id}
                            clip={u.clip}
                            importColor={importColors.get(u.clip.importId) ?? '#666'}
                            selected={selectedClips.has(u.clip.id)}
                            onSelect={(e) => handleClipClick(i, e)}
                            onRename={handleRenameClip}
                          />
                        )
                      }
                      const color = importColors.get(u.group.importId) ?? '#666'
                      return (
                        <ClipGroupBlock
                          key={u.group.id}
                          group={u.group}
                          clips={u.clips}
                          color={color}
                          selectedSet={selectedClips}
                          onToggleGroupSelect={handleToggleGroupSelect}
                          onDissolve={handleDissolveGroup}
                          onRename={handleRenameGroup}
                          onUpdateDescription={handleUpdateGroupDesc}
                        >
                          {u.clips.map((c) => {
                            const i = idxOfId.get(c.id) ?? 0
                            return (
                              <ClipCard
                                key={c.id}
                                clip={c}
                                importColor={color}
                                selected={selectedClips.has(c.id)}
                                onSelect={(e) => handleClipClick(i, e)}
                                onRename={handleRenameClip}
                              />
                            )
                          })}
                        </ClipGroupBlock>
                      )
                    })
                  })()}
                </div>
              )}
            </div>
          )}

          {/* 音频区 */}
          {(category === 'all' || category === 'audios') && (
            <div className="randomcut-section">
              <div className="randomcut-section-head">
                <h3>
                  音频 <span className="muted">({visibleAudios.length})</span>
                </h3>
                <div className="randomcut-bulk">
                  {visibleAudios.length > 0 && (
                    <button
                      type="button"
                      className="ghost-btn small"
                      onClick={
                        visibleAudiosAllSelected
                          ? clearVisibleAudioSelection
                          : selectAllVisibleAudios
                      }
                    >
                      {visibleAudiosAllSelected ? '取消全选' : '全选'}
                    </button>
                  )}
                  {selectedAudios.size > 0 && (
                    <>
                      <span className="randomcut-bulk-stat">
                        已选 <strong>{selectedAudios.size}</strong>
                      </span>
                      <button
                        type="button"
                        className="ghost-btn small"
                        onClick={() => setSelectedAudios(new Set())}
                      >
                        清空
                      </button>
                      <button
                        type="button"
                        className="danger-btn small"
                        onClick={async () => {
                          if (!confirm(`删除 ${selectedAudios.size} 个音频？`)) return
                          await window.scissor.library.deleteAudios(Array.from(selectedAudios))
                          setSelectedAudios(new Set())
                          reload()
                        }}
                      >
                        删除
                      </button>
                    </>
                  )}
                </div>
              </div>
              {visibleAudios.length === 0 ? (
                <div className="randomcut-empty">
                  {index.audios.length === 0
                    ? '还没有音频。视频抽出会自动入库，也可手动添加。'
                    : '该分类下没有音频。'}
                </div>
              ) : (
                <div className="audio-grid">
                  {visibleAudios.map((a, idx) => (
                    <AudioCard
                      key={a.id}
                      audio={a}
                      selected={selectedAudios.has(a.id)}
                      onSelect={(e) => handleAudioClick(idx, e)}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </main>
      </div>

      {pickedFiles && (
        <ImportDialog
          files={pickedFiles}
          onCancel={() => setPickedFiles(null)}
          onConfirm={handleImport}
        />
      )}

      {pendingDup && (
        <div className="modal-overlay" onClick={() => handleConfirmDup('skip')}>
          <div className="modal-card small" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>检测到重复文件</h3>
            </div>
            <div className="modal-body">
              <p>{basename(pendingDup.sourcePath)} 已在素材池中。</p>
              <p>
                哈希：<code>{pendingDup.sourceHash}</code>
              </p>
              <p>要怎么处理？</p>
            </div>
            <div className="modal-foot">
              <button type="button" className="ghost-btn" onClick={() => handleConfirmDup('skip')}>
                跳过
              </button>
              <button type="button" className="ghost-btn" onClick={() => handleConfirmDup('reimport-add')}>
                再来一份
              </button>
              <button
                type="button"
                className="primary-btn"
                onClick={() => handleConfirmDup('reimport-replace')}
              >
                替换原有
              </button>
            </div>
          </div>
        </div>
      )}

      <ImportProgress items={progressItems} onClose={() => setProgressItems([])} />

      {(selectedClips.size > 0 || selectedAudios.size > 0) && (
        <div className="randomcut-actionbar">
          <div className="randomcut-actionbar-info">
            <strong>已选 {selectedClips.size}</strong> 段视频
            {selectedAudios.size > 0 ? (
              <>
                {' '}
                · <strong>{selectedAudios.size}</strong> 个音频
              </>
            ) : null}
            <span className="randomcut-actionbar-hint">
              · 估算时长{' '}
              {index.clips
                .filter((c) => selectedClips.has(c.id))
                .reduce((a, b) => a + b.durationSec, 0)
                .toFixed(1)}
              s
            </span>
          </div>
          <div className="randomcut-actionbar-buttons">
            <button
              type="button"
              className="ghost-btn"
              onClick={() => {
                setSelectedClips(new Set())
                setSelectedAudios(new Set())
              }}
            >
              清空选择
            </button>
            <button
              type="button"
              className="primary-btn"
              disabled={selectedClips.size === 0}
              onClick={() => setMixOpen(true)}
            >
              开始混剪 →
            </button>
          </div>
        </div>
      )}

      {mixOpen && (
        <MixWorkspace
          index={index}
          initialClipIds={Array.from(selectedClips)}
          initialAudioIds={Array.from(selectedAudios)}
          luts={luts}
          onClose={() => setMixOpen(false)}
          onRefreshLibrary={reload}
        />
      )}

      {sourceGroupingImportId &&
        (() => {
          const rec = index.imports.find((r) => r.id === sourceGroupingImportId)
          if (!rec) {
            // 来源被删了：直接关
            setSourceGroupingImportId(null)
            return null
          }
          return (
            <SourceGroupingModal
              index={index}
              importRec={rec}
              importColor={importColors.get(rec.id) ?? '#666'}
              onClose={() => setSourceGroupingImportId(null)}
              onCreated={reload}
              initialMode={sourceGroupingInitialMode}
            />
          )
        })()}

      {manualCutSourceSelectorOpen && (
        <div className="modal-overlay" onClick={() => setManualCutSourceSelectorOpen(false)}>
          <div className="modal-card manual-cut-selector-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>✂ 手动精准切片与视频剪辑</h3>
              <button type="button" className="del-btn" onClick={() => setManualCutSourceSelectorOpen(false)}>×</button>
            </div>
            
            <div className="modal-body">
              {/* 本地新视频 */}
              <div className="modal-section">
                <div className="modal-section-title">导入本地视频文件</div>
                <div 
                  className="manual-cut-import-dropbox"
                  onClick={handlePickVideosForManualCut}
                >
                  <span className="plus-icon">＋</span>
                  <strong>选择本地视频文件</strong>
                  <span className="desc">极速秒级加载，以帧级精度手动分割并提取你需要的黄金片段</span>
                </div>
              </div>

              {/* 已导入视频 */}
              <div className="modal-section">
                <div className="modal-section-title">或者从素材池中选择已导入的视频 ({index.imports.length})</div>
                {index.imports.length === 0 ? (
                  <div className="manual-cut-selector-empty">
                    当前素材池暂无已导入的原视频。请在上方导入本地视频文件。
                  </div>
                ) : (
                  <div className="manual-cut-sources-list">
                    {index.imports.map((rec) => (
                      <div key={rec.id} className="manual-cut-source-row">
                        <div className="manual-cut-source-info">
                          <span className="source-dot" style={{ background: importColors.get(rec.id) }} />
                          <span className="name" title={rec.name ? `${rec.name} (${rec.sourcePath})` : rec.sourcePath}>{rec.name || basename(rec.sourcePath)}</span>
                          <span className="time">{rec.clipIds.length}段已切 · {new Date(rec.importedAt).toLocaleDateString()}</span>
                        </div>
                        <button
                          type="button"
                          className="primary-btn small"
                          onClick={() => {
                            setManualCutSourceSelectorOpen(false)
                            setSourceGroupingInitialMode('cut')
                            setSourceGroupingImportId(rec.id)
                          }}
                        >
                          开始切片 ✂
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
            
            <div className="modal-foot">
              <button type="button" className="ghost-btn" onClick={() => setManualCutSourceSelectorOpen(false)}>取消</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function CategoryRow({
  icon,
  label,
  count,
  active,
  onClick,
  title,
  onRename
}: {
  icon: React.ReactNode
  label: string
  count: number
  active: boolean
  onClick: () => void
  title?: string
  onRename?: (newName: string) => void
}) {
  const [isEditing, setIsEditing] = useState(false)
  const [editName, setEditName] = useState(label)

  return (
    <button
      type="button"
      className={`randomcut-cat-row ${active ? 'active' : ''}`}
      onClick={onClick}
      title={title}
      onDoubleClick={(e) => {
        if (onRename) {
          e.stopPropagation()
          setIsEditing(true)
          setEditName(label)
        }
      }}
    >
      <span className="randomcut-cat-icon">{icon}</span>
      {isEditing ? (
        <input
          className="randomcut-cat-name-input"
          autoFocus
          value={editName}
          onChange={(e) => setEditName(e.target.value)}
          onBlur={() => {
            setIsEditing(false)
            if (editName !== label) {
              onRename?.(editName)
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.currentTarget.blur()
            } else if (e.key === 'Escape') {
              setEditName(label)
              setIsEditing(false)
            }
          }}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <span className="randomcut-cat-label">{label}</span>
      )}
      <span className="randomcut-cat-count">{count}</span>
    </button>
  )
}

function fmtBytes(n: number): string {
  if (n < 1024) return n + ' B'
  if (n < 1024 ** 2) return (n / 1024).toFixed(1) + ' KB'
  if (n < 1024 ** 3) return (n / 1024 ** 2).toFixed(1) + ' MB'
  return (n / 1024 ** 3).toFixed(2) + ' GB'
}

function basename(p: string): string {
  return p.split(/[/\\]/).pop() ?? p
}
