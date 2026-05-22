import { PRESET_META, type ObfuscationPreset } from '../../../shared/obfuscation'

type Props = {
  value: ObfuscationPreset
  onChange: (next: ObfuscationPreset) => void
  disabled?: boolean
}

const ORDER: ObfuscationPreset[] = ['custom', 'douyin', 'xiaohongshu', 'bilibili', 'youtube']

export function ObfuscationPresetBar({ value, onChange, disabled = false }: Props) {
  return (
    <div className="obf-preset-bar">
      <div className="obf-preset-label">预设</div>
      <div className="obf-preset-pills">
        {ORDER.map((p) => {
          const m = PRESET_META[p]
          return (
            <button
              key={p}
              type="button"
              className={`obf-preset-pill ${value === p ? 'active' : ''}`}
              title={m.hint}
              disabled={disabled}
              onClick={() => onChange(p)}
            >
              {m.label}
            </button>
          )
        })}
      </div>
      <div className="obf-preset-hint">{PRESET_META[value].hint}</div>
    </div>
  )
}
