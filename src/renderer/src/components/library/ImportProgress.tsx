import type { ImportProgressEvent } from '../../../../shared/library'

export type ProgressItem = {
  sourcePath: string
  importId: string
  phase: ImportProgressEvent['phase']
  /** 当前阶段进度 0~1（仅 cleaning/detecting/segmenting） */
  pct?: number
  /** thumbing 用：i / N */
  current?: number
  total?: number
  error?: string
  done?: boolean
}

type Props = {
  items: ProgressItem[]
  onClose?: () => void
}

const PHASE_LABEL: Record<ImportProgressEvent['phase'], string> = {
  queued: '排队中',
  cleaning: '清洗',
  detecting: '检测镜头',
  segmenting: '切片',
  thumbing: '生成缩略图',
  audio: '抽取音频',
  done: '完成',
  error: '失败',
  duplicate: '重复'
}

/** 阶段在总进度里的权重（粗估，给 overall pct 用） */
const PHASE_WEIGHT: Record<ImportProgressEvent['phase'], { start: number; span: number }> = {
  queued: { start: 0, span: 0.02 },
  detecting: { start: 0.02, span: 0.18 },
  cleaning: { start: 0.2, span: 0.6 },
  segmenting: { start: 0.8, span: 0.1 },
  thumbing: { start: 0.9, span: 0.07 },
  audio: { start: 0.97, span: 0.03 },
  done: { start: 1, span: 0 },
  error: { start: 0, span: 0 },
  duplicate: { start: 0, span: 0 }
}

function overallPct(it: ProgressItem): number {
  if (it.phase === 'done') return 1
  if (it.phase === 'error') return 0
  const w = PHASE_WEIGHT[it.phase]
  let inner = 0
  if (it.phase === 'thumbing' && it.total) {
    inner = Math.min(1, (it.current ?? 0) / it.total)
  } else if (typeof it.pct === 'number') {
    inner = it.pct
  }
  return Math.min(1, w.start + w.span * inner)
}

function basename(p: string): string {
  return p.split(/[/\\]/).pop() ?? p
}

export function ImportProgress({ items, onClose }: Props) {
  if (items.length === 0) return null
  const allDone = items.every((i) => i.done)
  return (
    <div className="import-progress">
      <div className="import-progress-head">
        <strong>导入进度</strong>
        {allDone && onClose && (
          <button type="button" className="ghost-btn small" onClick={onClose}>
            关闭
          </button>
        )}
      </div>
      <ul className="import-progress-list">
        {items.map((it) => {
          const pct = overallPct(it)
          const pctText = it.phase === 'done' ? '✓' : it.phase === 'error' ? '✗' : `${Math.round(pct * 100)}%`
          const detail =
            it.phase === 'thumbing' && it.total
              ? `${it.current}/${it.total}`
              : typeof it.pct === 'number' && it.phase !== 'audio'
                ? `${Math.round(it.pct * 100)}%`
                : undefined
          return (
            <li
              key={it.importId + it.sourcePath}
              className={it.phase === 'error' ? 'err' : it.phase === 'done' ? 'ok' : ''}
            >
              <div className="ip-row">
                <span className="ip-name">{basename(it.sourcePath)}</span>
                <span className="ip-pct">{pctText}</span>
              </div>
              <div className="ip-bar">
                <div
                  className={`ip-bar-fill ${it.phase === 'error' ? 'err' : ''}`}
                  style={{ width: `${pct * 100}%` }}
                />
              </div>
              <div className="ip-phase">
                {PHASE_LABEL[it.phase]}
                {detail ? ` · ${detail}` : ''}
              </div>
              {it.error && <div className="ip-err">{it.error}</div>}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
