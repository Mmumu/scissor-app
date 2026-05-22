import { useState, type ReactNode } from 'react'

type Props = {
  title: string
  summary?: string
  /** 显示启用/禁用开关；undefined 时不渲染开关 */
  enabled?: boolean
  onToggle?: (next: boolean) => void
  defaultOpen?: boolean
  /** 受控展开（与 defaultOpen 二选一） */
  open?: boolean
  onOpenChange?: (next: boolean) => void
  children: ReactNode
  disabled?: boolean
}

/**
 * 可折叠扰动分组卡片。
 * - 标题左侧：开关（可选）+ 名字
 * - 标题右侧：摘要文字（如「中等」「关」）
 * - 收起时只显示标题；展开时显示子内容
 */
export function ObfuscationGroup({
  title,
  summary,
  enabled,
  onToggle,
  defaultOpen = false,
  open,
  onOpenChange,
  children,
  disabled = false
}: Props) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen)
  const isOpen = open ?? internalOpen
  const setOpen = (v: boolean) => {
    if (onOpenChange) onOpenChange(v)
    else setInternalOpen(v)
  }

  return (
    <div className={`obf-group ${isOpen ? 'open' : ''} ${enabled === false ? 'is-off' : ''}`}>
      <div className="obf-group-head" onClick={() => setOpen(!isOpen)} role="button">
        <span className={`obf-group-caret ${isOpen ? 'open' : ''}`}>▸</span>
        {enabled !== undefined && (
          <button
            type="button"
            className={`obf-toggle ${enabled ? 'on' : ''}`}
            disabled={disabled}
            onClick={(e) => {
              e.stopPropagation()
              onToggle?.(!enabled)
            }}
            title={enabled ? '点击关闭本组' : '点击启用本组'}
          >
            {enabled ? '开' : '关'}
          </button>
        )}
        <span className="obf-group-title">{title}</span>
        {summary && <span className="obf-group-summary">{summary}</span>}
      </div>
      {isOpen && <div className="obf-group-body">{children}</div>}
    </div>
  )
}
