import type { ReferenceSegment } from '../../../../shared/mix'

type Props = {
  segments: ReferenceSegment[]
  refDurationSec: number
  /** 当前我方时间线总时长，用来在 UI 上提供对比文字 */
  myDurationSec: number
  /** 用户可以点击某段 → 触发跳转参考视频回放（可选） */
  onJump?: (sec: number) => void
}

/**
 * 参考视频的节奏轨道，铺成 100% 宽度（等比铺到当前时间线宽度上看的是密度）。
 * 每段一个色块；色块上方有 cut marker（短竖线）。
 */
export function ReferenceRhythmTrack({
  segments,
  refDurationSec,
  myDurationSec,
  onJump
}: Props) {
  if (segments.length === 0 || refDurationSec <= 0) return null

  const refTotal = segments.reduce((a, s) => a + s.dur, 0) || refDurationSec
  const diff = myDurationSec - refTotal

  return (
    <div className="ref-rhythm">
      <div className="ref-rhythm-head">
        <span className="ref-rhythm-label">参考节奏</span>
        <span className="ref-rhythm-stats">
          {segments.length} 段 · {refTotal.toFixed(1)}s
          {myDurationSec > 0 && (
            <span
              className={`ref-rhythm-diff ${
                Math.abs(diff) < 0.5 ? 'match' : diff > 0 ? 'over' : 'under'
              }`}
            >
              {' '}
              vs 我 {myDurationSec.toFixed(1)}s ({diff >= 0 ? '+' : ''}
              {diff.toFixed(1)}s)
            </span>
          )}
        </span>
      </div>
      <div className="ref-rhythm-track">
        {segments.map((s, i) => {
          const widthPct = (s.dur / refTotal) * 100
          const leftPct = (s.start / refTotal) * 100
          return (
            <button
              key={i}
              type="button"
              className="ref-rhythm-seg"
              style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
              onClick={() => onJump?.(s.start)}
              title={`#${i + 1} · ${s.start.toFixed(2)}s ~ ${s.end.toFixed(2)}s · ${s.dur.toFixed(2)}s`}
            >
              <span className="ref-rhythm-seg-num">{i + 1}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
