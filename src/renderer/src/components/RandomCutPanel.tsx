import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ImportDialog } from './library/ImportDialog'
import { ClipCard } from './library/ClipCard'
import { AudioCard } from './library/AudioCard'
import { ImportProgress, type ProgressItem } from './library/ImportProgress'
import { MixWorkspace } from './mix/MixWorkspace'
import type {
  ImportOptions,
  ImportProgressEvent,
  LibraryIndex,
  LibraryStats
} from '../../../shared/library'

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
  const lastImportOptsRef = useRef<Omit<ImportOptions, 'paths'> | null>(null)

  const reload = useCallback(async () => {
    const [i, s] = await Promise.all([
      window.scissor.library.list(),
      window.scissor.library.stats()
    ])
    setIndex(i)
    setStats(s)
  }, [])

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
      if (ev.phase === 'done' || ev.phase === 'error') {
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
                      label={basename(rec.sourcePath)}
                      count={rec.clipIds.length}
                      active={category === cat}
                      onClick={() => setCategory(cat)}
                      title={rec.sourcePath}
                    />
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
                {selectedClips.size > 0 && (
                  <div className="randomcut-bulk">
                    已选 {selectedClips.size}
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
                  </div>
                )}
              </div>
              {visibleClips.length === 0 ? (
                <div className="randomcut-empty">
                  {index.clips.length === 0 ? '还没有片段，点右上角「导入视频」开始。' : '该分类下没有片段。'}
                </div>
              ) : (
                <div className="clip-grid">
                  {visibleClips.map((c) => (
                    <ClipCard
                      key={c.id}
                      clip={c}
                      importColor={importColors.get(c.importId) ?? '#666'}
                      selected={selectedClips.has(c.id)}
                      onSelect={(s) => {
                        const next = new Set(selectedClips)
                        if (s) next.add(c.id)
                        else next.delete(c.id)
                        setSelectedClips(next)
                      }}
                    />
                  ))}
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
                {selectedAudios.size > 0 && (
                  <div className="randomcut-bulk">
                    已选 {selectedAudios.size}
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
                  </div>
                )}
              </div>
              {visibleAudios.length === 0 ? (
                <div className="randomcut-empty">
                  {index.audios.length === 0
                    ? '还没有音频。视频抽出会自动入库，也可手动添加。'
                    : '该分类下没有音频。'}
                </div>
              ) : (
                <div className="audio-grid">
                  {visibleAudios.map((a) => (
                    <AudioCard
                      key={a.id}
                      audio={a}
                      selected={selectedAudios.has(a.id)}
                      onSelect={(s) => {
                        const next = new Set(selectedAudios)
                        if (s) next.add(a.id)
                        else next.delete(a.id)
                        setSelectedAudios(next)
                      }}
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
    </div>
  )
}

function CategoryRow({
  icon,
  label,
  count,
  active,
  onClick,
  title
}: {
  icon: React.ReactNode
  label: string
  count: number
  active: boolean
  onClick: () => void
  title?: string
}) {
  return (
    <button
      type="button"
      className={`randomcut-cat-row ${active ? 'active' : ''}`}
      onClick={onClick}
      title={title}
    >
      <span className="randomcut-cat-icon">{icon}</span>
      <span className="randomcut-cat-label">{label}</span>
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
