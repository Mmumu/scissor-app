import { useCallback } from 'react'
import {
  applyPreset,
  type ObfuscationOptions as Opts,
  type ObfuscationPreset
} from '../../../shared/obfuscation'
import type { StickerItem } from '../../../shared/types'
import { ObfuscationGroup } from './ObfuscationGroup'
import { ObfuscationPresetBar } from './ObfuscationPresetBar'

type Props = {
  value: Opts
  onChange: (next: Opts) => void
  disabled?: boolean
  luts?: { name: string; path: string }[]
  hide?: {
    concat?: boolean
    lut?: boolean
    metadata?: boolean
    trim?: boolean
    cover?: boolean
    stickers?: boolean
  }
  showPresetBar?: boolean
  /** Slot 注入：preset bar 之后、几何之前的额外控件（如 stitch 的条带配置） */
  slotAfterPreset?: React.ReactNode
}

function basename(p: string): string {
  return p.split(/[/\\]/).pop() ?? p
}

function fmtPct(n: number): string {
  return `${n >= 0 ? '+' : ''}${(n * 100).toFixed(1)}%`
}

function intensitySummary(enabled: boolean, level: number, levels: [number, number, number]): string {
  if (!enabled) return '关'
  if (level <= levels[0]) return '关'
  if (level <= levels[1]) return '轻'
  if (level <= levels[2]) return '中'
  return '强'
}

export function ObfuscationOptions({
  value: v,
  onChange,
  disabled = false,
  luts = [],
  hide = {},
  showPresetBar = true,
  slotAfterPreset
}: Props) {
  /** 局部 set helper：仅替换某个分组 */
  const set = useCallback(
    <K extends keyof Opts>(k: K, patch: Partial<Opts[K]> | Opts[K]) => {
      onChange({ ...v, [k]: typeof patch === 'object' && patch !== null && !Array.isArray(patch) ? { ...(v[k] as object), ...(patch as object) } : patch } as Opts)
    },
    [v, onChange]
  )

  const setPreset = useCallback(
    (p: ObfuscationPreset) => {
      if (p === 'custom') {
        onChange({ ...v, preset: 'custom' })
        return
      }
      onChange(applyPreset(p, v))
    },
    [v, onChange]
  )

  // ── 摘要计算 ───────────────────────────────────────
  const geomSummary = !v.geometry.enabled
    ? '关'
    : [
        v.geometry.hflip && '翻转',
        v.geometry.randomCrop ? '随机裁' : v.geometry.cropPx > 0 ? `裁 ${v.geometry.cropPx}px` : null,
        v.geometry.rotateJitter ? '抖动旋转' : v.geometry.rotateDeg ? `旋 ${v.geometry.rotateDeg}°` : null
      ]
        .filter(Boolean)
        .join(' · ') || '微小'

  const colorSummary = !v.color.enabled
    ? '关'
    : `色相 ${v.color.hue}° · 饱和 ${v.color.saturation.toFixed(2)} · 噪点 ${v.color.noise}`

  const detailSummary = !v.detail.enabled
    ? '关'
    : intensitySummary(v.detail.enabled, Math.abs(v.detail.unsharp) + v.detail.gblurSigma, [0.05, 0.3, 0.6])

  const speedSummary = !v.speed.enabled || v.speed.rate === 1
    ? '关'
    : `${fmtPct(v.speed.rate - 1)}${v.speed.jitter ? ' · 抖' : ''}`

  const audioSummary = !v.audio.enabled
    ? '关'
    : `调 ${fmtPct(v.audio.pitchRate - 1)} · ${
        v.audio.eqMode === 'off' ? '无EQ' : v.audio.eqMode === 'cutoff' ? '高低切' : '3段随机EQ'
      }`

  const trimSummary = (() => {
    const parts: string[] = []
    if (v.trim.startSec > 0) parts.push(`头 ${v.trim.startSec.toFixed(1)}s`)
    if (v.trim.endSec > 0) parts.push(`尾 ${v.trim.endSec.toFixed(1)}s`)
    if (v.trim.middleRemoveSec > 0) parts.push(`跳 ${v.trim.middleRemoveSec.toFixed(1)}s`)
    if (v.trim.randomStartJitter) parts.push('抖动')
    return parts.length ? parts.join(' · ') : '关'
  })()

  const coverSummary =
    v.cover.bottomRatio > 0 ? `${Math.round(v.cover.bottomRatio * 100)}% · ${v.cover.bottomType}` : '关'

  const lutSummary = v.lut.path ? `${basename(v.lut.path)} · ${Math.round(v.lut.intensity * 100)}%` : '关'

  const stickerSummary = v.stickers.length > 0 ? `${v.stickers.length} 个` : '关'
  const metaSummary = !v.metadata.strip && !v.metadata.fakeEncoder ? '关' : v.metadata.fakeEncoder ? '清+伪造' : '清'

  // ── 贴纸操作 ───────────────────────────────────────
  const addSticker = async () => {
    const path = await window.scissor.pickImage()
    if (!path) return
    const next: StickerItem = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2),
      imagePath: path,
      anchor: 'top-right',
      customX: 0,
      customY: 0,
      insetTop: 20,
      insetRight: 20,
      insetBottom: 20,
      insetLeft: 20,
      widthFrac: 0.15,
      opacity: 1,
      startSec: null,
      endSec: null
    }
    onChange({ ...v, stickers: [...v.stickers, next] })
  }

  const updateSticker = (id: string, patch: Partial<StickerItem>) => {
    onChange({
      ...v,
      stickers: v.stickers.map((s) => (s.id === id ? { ...s, ...patch } : s))
    })
  }

  const removeSticker = (id: string) => {
    onChange({ ...v, stickers: v.stickers.filter((s) => s.id !== id) })
  }

  const pickIntro = async () => {
    const ps = await window.scissor.pickVideos()
    if (ps?.[0]) onChange({ ...v, concat: { ...v.concat, introPath: ps[0] } })
  }
  const pickOutro = async () => {
    const ps = await window.scissor.pickVideos()
    if (ps?.[0]) onChange({ ...v, concat: { ...v.concat, outroPath: ps[0] } })
  }

  return (
    <div className="obf-root">
      {showPresetBar && (
        <ObfuscationPresetBar value={v.preset} onChange={setPreset} disabled={disabled} />
      )}

      {slotAfterPreset}

      {/* ── 几何 ──────────────────────────────── */}
      <ObfuscationGroup
        title="几何（翻转/旋转/裁切）"
        summary={geomSummary}
        enabled={v.geometry.enabled}
        onToggle={(next) => set('geometry', { enabled: next })}
        disabled={disabled}
        defaultOpen={false}
      >
        <Row label="水平翻转" hint="镜像翻转，有字幕慎用">
          <Toggle
            checked={v.geometry.hflip}
            onChange={(b) => set('geometry', { hflip: b })}
            disabled={disabled}
          />
        </Row>
        <Row label="随机裁切" hint="四边随机裁 2~7px，破坏对齐">
          <Toggle
            checked={v.geometry.randomCrop}
            onChange={(b) => set('geometry', { randomCrop: b })}
            disabled={disabled}
          />
        </Row>
        {!v.geometry.randomCrop && (
          <Row label="对称裁切" valueLabel={`${v.geometry.cropPx}px`}>
            <Slider
              min={0}
              max={16}
              step={1}
              value={v.geometry.cropPx}
              onChange={(n) => set('geometry', { cropPx: n })}
              disabled={disabled}
            />
          </Row>
        )}
        <Row label="旋转抖动" hint="导出时叠加 ±0.3° 随机旋转">
          <Toggle
            checked={v.geometry.rotateJitter}
            onChange={(b) => set('geometry', { rotateJitter: b })}
            disabled={disabled}
          />
        </Row>
        <Row label="固定旋转" valueLabel={`${v.geometry.rotateDeg.toFixed(1)}°`}>
          <Slider
            min={-2}
            max={2}
            step={0.1}
            value={v.geometry.rotateDeg}
            onChange={(n) => set('geometry', { rotateDeg: n })}
            disabled={disabled}
          />
        </Row>
      </ObfuscationGroup>

      {/* ── 色彩 ──────────────────────────────── */}
      <ObfuscationGroup
        title="色彩（色相/饱和/亮度/噪点）"
        summary={colorSummary}
        enabled={v.color.enabled}
        onToggle={(next) => set('color', { enabled: next })}
        disabled={disabled}
      >
        <Row label="色相偏移" valueLabel={`${v.color.hue}°`}>
          <Slider
            min={-10}
            max={10}
            step={0.5}
            value={v.color.hue}
            onChange={(n) => set('color', { hue: n })}
            disabled={disabled}
          />
        </Row>
        <Row label="饱和度" valueLabel={`${((v.color.saturation - 1) * 100).toFixed(0)}%`}>
          <Slider
            min={0.9}
            max={1.1}
            step={0.01}
            value={v.color.saturation}
            onChange={(n) => set('color', { saturation: n })}
            disabled={disabled}
          />
        </Row>
        <Row label="亮度" valueLabel={fmtPct(v.color.brightness)}>
          <Slider
            min={-0.05}
            max={0.05}
            step={0.005}
            value={v.color.brightness}
            onChange={(n) => set('color', { brightness: n })}
            disabled={disabled}
          />
        </Row>
        <Row label="对比度" valueLabel={`${((v.color.contrast - 1) * 100).toFixed(1)}%`}>
          <Slider
            min={0.95}
            max={1.05}
            step={0.005}
            value={v.color.contrast}
            onChange={(n) => set('color', { contrast: n })}
            disabled={disabled}
          />
        </Row>
        <Row label="RGB 通道微调" hint="破坏颜色直方图">
          <Toggle
            checked={v.color.colorMix}
            onChange={(b) => set('color', { colorMix: b })}
            disabled={disabled}
          />
        </Row>
        <Row label="噪点强度" valueLabel={`${v.color.noise}`}>
          <Slider
            min={0}
            max={8}
            step={1}
            value={v.color.noise}
            onChange={(n) => set('color', { noise: n })}
            disabled={disabled}
          />
        </Row>
      </ObfuscationGroup>

      {/* ── 细节 ──────────────────────────────── */}
      <ObfuscationGroup
        title="细节（锐化/模糊）"
        summary={detailSummary}
        enabled={v.detail.enabled}
        onToggle={(next) => set('detail', { enabled: next })}
        disabled={disabled}
      >
        <Row label="锐化/柔化" valueLabel={`${v.detail.unsharp >= 0 ? '+' : ''}${v.detail.unsharp.toFixed(1)}`} hint="正=锐化，负=柔化">
          <Slider
            min={-1}
            max={1}
            step={0.1}
            value={v.detail.unsharp}
            onChange={(n) => set('detail', { unsharp: n })}
            disabled={disabled}
          />
        </Row>
        <Row label="高斯模糊" valueLabel={`σ${v.detail.gblurSigma.toFixed(2)}`} hint=">0 时先模糊再锐化，纹理指纹彻底变">
          <Slider
            min={0}
            max={1}
            step={0.05}
            value={v.detail.gblurSigma}
            onChange={(n) => set('detail', { gblurSigma: n })}
            disabled={disabled}
          />
        </Row>
      </ObfuscationGroup>

      {/* ── LUT ──────────────────────────────── */}
      {!hide.lut && (
        <ObfuscationGroup title="LUT 电影滤镜" summary={lutSummary} disabled={disabled}>
          <Row label="LUT 文件">
            <select
              className="obf-select"
              value={v.lut.path ?? ''}
              onChange={(e) => onChange({ ...v, lut: { ...v.lut, path: e.target.value || undefined } })}
              disabled={disabled}
            >
              <option value="">（无滤镜）</option>
              {luts.map((l) => (
                <option key={l.path} value={l.path}>
                  {l.name}
                </option>
              ))}
            </select>
          </Row>
          {v.lut.path && (
            <Row label="强度" valueLabel={`${Math.round(v.lut.intensity * 100)}%`}>
              <Slider
                min={0}
                max={1}
                step={0.05}
                value={v.lut.intensity}
                onChange={(n) => onChange({ ...v, lut: { ...v.lut, intensity: n } })}
                disabled={disabled}
              />
            </Row>
          )}
        </ObfuscationGroup>
      )}

      {/* ── 变速 ──────────────────────────────── */}
      <ObfuscationGroup
        title="变速"
        summary={speedSummary}
        enabled={v.speed.enabled}
        onToggle={(next) => set('speed', { enabled: next })}
        disabled={disabled}
      >
        <Row label="速度" valueLabel={`${((v.speed.rate - 1) * 100).toFixed(1)}%`} hint="同步改 PTS 和音频 atempo">
          <Slider
            min={0.95}
            max={1.05}
            step={0.001}
            value={v.speed.rate}
            onChange={(n) => set('speed', { rate: n })}
            disabled={disabled}
          />
        </Row>
        <Row label="速度抖动" hint="每次导出在 rate 上再叠 ±2% 随机">
          <Toggle
            checked={v.speed.jitter}
            onChange={(b) => set('speed', { jitter: b })}
            disabled={disabled}
          />
        </Row>
      </ObfuscationGroup>

      {/* ── 音频 ──────────────────────────────── */}
      <ObfuscationGroup
        title="音频"
        summary={audioSummary}
        enabled={v.audio.enabled}
        onToggle={(next) => set('audio', { enabled: next })}
        disabled={disabled}
      >
        <Row label="音调倍率" valueLabel={fmtPct(v.audio.pitchRate - 1)} hint="改变频谱 Chroma，破坏音频指纹">
          <Slider
            min={0.94}
            max={1.06}
            step={0.005}
            value={v.audio.pitchRate}
            onChange={(n) => set('audio', { pitchRate: n })}
            disabled={disabled}
          />
        </Row>
        <Row label="EQ 模式" hint="cutoff=固定高低切；random3band=3 段随机增益">
          <select
            className="obf-select"
            value={v.audio.eqMode}
            onChange={(e) =>
              set('audio', { eqMode: e.target.value as Opts['audio']['eqMode'] })
            }
            disabled={disabled}
          >
            <option value="off">关</option>
            <option value="cutoff">高低切</option>
            <option value="random3band">3 段随机</option>
          </select>
        </Row>
        <Row label="音量抖动" hint="每次导出 1.01~1.04× 随机">
          <Toggle
            checked={v.audio.volumeJitter}
            onChange={(b) => set('audio', { volumeJitter: b })}
            disabled={disabled}
          />
        </Row>
      </ObfuscationGroup>

      {/* ── 时间裁剪 ──────────────────────────────── */}
      {!hide.trim && (
        <ObfuscationGroup title="时间裁剪" summary={trimSummary} disabled={disabled}>
          <Row label="片头" valueLabel={`${v.trim.startSec.toFixed(1)}s`}>
            <Slider
              min={0}
              max={30}
              step={0.5}
              value={v.trim.startSec}
              onChange={(n) => set('trim', { startSec: n })}
              disabled={disabled}
            />
          </Row>
          <Row label="片尾" valueLabel={`${v.trim.endSec.toFixed(1)}s`}>
            <Slider
              min={0}
              max={30}
              step={0.5}
              value={v.trim.endSec}
              onChange={(n) => set('trim', { endSec: n })}
              disabled={disabled}
            />
          </Row>
          <Row label="中段跳剪" valueLabel={`${v.trim.middleRemoveSec.toFixed(1)}s`} hint="在去掉头尾后的中段删一刀">
            <Slider
              min={0}
              max={20}
              step={0.5}
              value={v.trim.middleRemoveSec}
              onChange={(n) => set('trim', { middleRemoveSec: n })}
              disabled={disabled}
            />
          </Row>
          <Row label="入点随机抖动" hint="在片头基础上再叠 0.1~0.5s 随机">
            <Toggle
              checked={v.trim.randomStartJitter}
              onChange={(b) => set('trim', { randomStartJitter: b })}
              disabled={disabled}
            />
          </Row>
        </ObfuscationGroup>
      )}

      {/* ── 底栏 ──────────────────────────────── */}
      {!hide.cover && (
        <ObfuscationGroup title="底部遮挡（去字幕）" summary={coverSummary} disabled={disabled}>
          <Row label="比例" valueLabel={`${Math.round(v.cover.bottomRatio * 100)}%`}>
            <Slider
              min={0}
              max={0.5}
              step={0.01}
              value={v.cover.bottomRatio}
              onChange={(n) => set('cover', { bottomRatio: n })}
              disabled={disabled}
            />
          </Row>
          <Row label="方式">
            <select
              className="obf-select"
              value={v.cover.bottomType}
              onChange={(e) => set('cover', { bottomType: e.target.value as Opts['cover']['bottomType'] })}
              disabled={disabled}
            >
              <option value="blur">高斯模糊</option>
              <option value="black">纯黑遮挡</option>
              <option value="crop">直接裁掉</option>
            </select>
          </Row>
        </ObfuscationGroup>
      )}

      {/* ── 贴纸 ──────────────────────────────── */}
      {!hide.stickers && (
        <ObfuscationGroup title="贴图水印" summary={stickerSummary} disabled={disabled}>
          <div style={{ marginBottom: 8 }}>
            <button type="button" className="ghost-btn" onClick={addSticker} disabled={disabled}>
              + 添加图片
            </button>
          </div>
          {v.stickers.map((s, i) => (
            <div key={s.id} className="obf-sticker-card">
              <div className="obf-sticker-head">
                <span className="obf-sticker-title">
                  #{i + 1} · {basename(s.imagePath)}
                </span>
                <button type="button" className="del-btn" onClick={() => removeSticker(s.id)} disabled={disabled}>
                  ×
                </button>
              </div>
              <div className="obf-sticker-grid">
                <label className="s-label">
                  位置
                  <select
                    value={s.anchor}
                    onChange={(e) => updateSticker(s.id, { anchor: e.target.value as StickerItem['anchor'] })}
                    disabled={disabled}
                  >
                    <option value="top-left">左上</option>
                    <option value="top-right">右上</option>
                    <option value="bottom-left">左下</option>
                    <option value="bottom-right">右下</option>
                    <option value="center">居中</option>
                    <option value="custom">自定义</option>
                  </select>
                </label>
                <label className="s-label">
                  宽度占比
                  <input
                    type="range"
                    min={0}
                    max={0.5}
                    step={0.01}
                    value={s.widthFrac}
                    onChange={(e) => updateSticker(s.id, { widthFrac: Number(e.target.value) })}
                    disabled={disabled}
                  />
                  <span className="opt-val">{s.widthFrac > 0 ? `${Math.round(s.widthFrac * 100)}%` : '原始'}</span>
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
                    disabled={disabled}
                  />
                </label>
                <label className="s-label">
                  起始秒
                  <input
                    type="number"
                    step="0.1"
                    placeholder="开头"
                    value={s.startSec ?? ''}
                    onChange={(e) =>
                      updateSticker(s.id, { startSec: e.target.value ? Number(e.target.value) : null })
                    }
                    disabled={disabled}
                  />
                </label>
                <label className="s-label">
                  结束秒
                  <input
                    type="number"
                    step="0.1"
                    placeholder="结尾"
                    value={s.endSec ?? ''}
                    onChange={(e) =>
                      updateSticker(s.id, { endSec: e.target.value ? Number(e.target.value) : null })
                    }
                    disabled={disabled}
                  />
                </label>
              </div>
            </div>
          ))}
        </ObfuscationGroup>
      )}

      {/* ── 片头/片尾拼接 ──────────────────────────── */}
      {!hide.concat && (
        <ObfuscationGroup
          title="片头/片尾短片"
          summary={
            v.concat.introPath || v.concat.outroPath
              ? [v.concat.introPath && '头', v.concat.outroPath && '尾'].filter(Boolean).join('+')
              : '关'
          }
          disabled={disabled}
        >
          <Row label="片头">
            <div className="obf-file-pick">
              <button type="button" className="ghost-btn" onClick={pickIntro} disabled={disabled}>
                选择
              </button>
              {v.concat.introPath && (
                <>
                  <span className="file-tag">{basename(v.concat.introPath)}</span>
                  <button
                    type="button"
                    className="ghost-btn"
                    onClick={() => onChange({ ...v, concat: { ...v.concat, introPath: undefined } })}
                    disabled={disabled}
                  >
                    清除
                  </button>
                </>
              )}
            </div>
          </Row>
          <Row label="片尾">
            <div className="obf-file-pick">
              <button type="button" className="ghost-btn" onClick={pickOutro} disabled={disabled}>
                选择
              </button>
              {v.concat.outroPath && (
                <>
                  <span className="file-tag">{basename(v.concat.outroPath)}</span>
                  <button
                    type="button"
                    className="ghost-btn"
                    onClick={() => onChange({ ...v, concat: { ...v.concat, outroPath: undefined } })}
                    disabled={disabled}
                  >
                    清除
                  </button>
                </>
              )}
            </div>
          </Row>
        </ObfuscationGroup>
      )}

      {/* ── 元数据 ──────────────────────────────── */}
      {!hide.metadata && (
        <ObfuscationGroup title="元数据" summary={metaSummary} disabled={disabled}>
          <Row label="清空原元数据">
            <Toggle
              checked={v.metadata.strip}
              onChange={(b) => set('metadata', { strip: b })}
              disabled={disabled}
            />
          </Row>
          <Row label="注入伪造编码器/时间">
            <Toggle
              checked={v.metadata.fakeEncoder}
              onChange={(b) => set('metadata', { fakeEncoder: b })}
              disabled={disabled}
            />
          </Row>
        </ObfuscationGroup>
      )}

      {/* ── 编码 ──────────────────────────────── */}
      <ObfuscationGroup title="编码" summary={`CRF ${v.encode.crf}`} disabled={disabled}>
        <Row label="CRF" valueLabel={`${v.encode.crf}`} hint="越低质量越高 / 体积越大；23 为平衡点">
          <Slider
            min={18}
            max={30}
            step={1}
            value={v.encode.crf}
            onChange={(n) => set('encode', { crf: n })}
            disabled={disabled}
          />
        </Row>
      </ObfuscationGroup>
    </div>
  )
}

// ───────────── 小组件 ─────────────────────────────

function Row({
  label,
  hint,
  valueLabel,
  children
}: {
  label: string
  hint?: string
  valueLabel?: string
  children: React.ReactNode
}) {
  return (
    <div className="obf-row">
      <div className="obf-row-label">
        <span>{label}</span>
        {valueLabel != null && <span className="obf-row-val">{valueLabel}</span>}
      </div>
      <div className="obf-row-control">{children}</div>
      {hint && <div className="obf-row-hint">{hint}</div>}
    </div>
  )
}

function Slider({
  min,
  max,
  step,
  value,
  onChange,
  disabled
}: {
  min: number
  max: number
  step: number
  value: number
  onChange: (n: number) => void
  disabled?: boolean
}) {
  return (
    <input
      type="range"
      className="obf-slider"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      disabled={disabled}
    />
  )
}

function Toggle({
  checked,
  onChange,
  disabled
}: {
  checked: boolean
  onChange: (b: boolean) => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      className={`obf-toggle-small ${checked ? 'on' : ''}`}
      onClick={() => onChange(!checked)}
      disabled={disabled}
    >
      {checked ? '开' : '关'}
    </button>
  )
}
