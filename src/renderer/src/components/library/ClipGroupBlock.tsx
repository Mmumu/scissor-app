import { useState, useEffect, useRef } from 'react'
import type { ClipGroup, ClipMeta } from '../../../../shared/library'

type Props = {
  group: ClipGroup
  clips: ClipMeta[]
  /** 来源颜色（继承自所在 import） */
  color: string
  /** 选中的 clipId 集合，用于显示组头的"已选 N / 共 M" */
  selectedSet: ReadonlySet<string>
  /** 「全选/取消全选」按钮：把整组成员一起加入或退出 selectedSet
   *  注意：单个 clip 卡片自身的点击仍然是单选，这两套互不冲突 */
  onToggleGroupSelect: (group: ClipGroup) => void
  /** 「+加」操作：父组件决定是加进时间线还是加进选择 */
  onAddGroup?: (group: ClipGroup) => void
  /** 「+加」按钮显示的文案 */
  addLabel?: string
  /** 解散组（仅删除分组关系，不影响 clip） */
  onDissolve: (group: ClipGroup) => void
  /** 重命名 */
  onRename: (group: ClipGroup, name: string) => void
  /** 更新组描述 */
  onUpdateDescription?: (group: ClipGroup, description: string) => void
  /** 拖拽：父组件决定 dataTransfer 内容（不同场景里 payload 不同） */
  onDragStart?: (e: React.DragEvent, group: ClipGroup) => void
  /** 子节点：clip 卡片列表，由父组件按 props.clips 渲染 */
  children: React.ReactNode
}

export function ClipGroupBlock({
  group,
  clips,
  color,
  selectedSet,
  onToggleGroupSelect,
  onAddGroup,
  addLabel = '+加',
  onDissolve,
  onRename,
  onUpdateDescription,
  onDragStart,
  children
}: Props) {
  const [editingName, setEditingName] = useState(false)
  const [editingDesc, setEditingDesc] = useState(false)
  const [name, setName] = useState(group.name)
  const [description, setDescription] = useState(group.description ?? '')
  const nameInputRef = useRef<HTMLInputElement | null>(null)
  const descInputRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    setName(group.name)
  }, [group.name])

  useEffect(() => {
    setDescription(group.description ?? '')
  }, [group.description])

  useEffect(() => {
    if (editingName) nameInputRef.current?.focus()
  }, [editingName])

  useEffect(() => {
    if (editingDesc) descInputRef.current?.focus()
  }, [editingDesc])

  const totalSec = clips.reduce((a, b) => a + b.durationSec, 0)
  const selectedCount = clips.filter((c) => selectedSet.has(c.id)).length
  const allSelected = selectedCount === clips.length && clips.length > 0
  const partialSelected = selectedCount > 0 && !allSelected

  function commitRename(): void {
    setEditingName(false)
    const trimmed = name.trim()
    if (!trimmed || trimmed === group.name) {
      setName(group.name)
      return
    }
    onRename(group, trimmed)
  }

  function commitDescription(): void {
    setEditingDesc(false)
    const trimmed = description.trim()
    if (trimmed === (group.description ?? '')) {
      setDescription(group.description ?? '')
      return
    }
    onUpdateDescription?.(group, trimmed)
  }

  return (
    <div
      className={`clip-group-block ${allSelected ? 'all-selected' : partialSelected ? 'some-selected' : ''}`}
      style={{ ['--clip-group-color' as string]: color }}
      draggable={onDragStart != null}
      onDragStart={onDragStart ? (e) => onDragStart(e, group) : undefined}
    >
      <div className="clip-group-head">
        <span className="clip-group-bullet" style={{ background: color }} />
        {editingName ? (
          <input
            ref={nameInputRef}
            className="clip-group-name-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename()
              else if (e.key === 'Escape') {
                setName(group.name)
                setEditingName(false)
              }
            }}
          />
        ) : (
          <span
            className="clip-group-name"
            title="双击重命名"
            onDoubleClick={() => setEditingName(true)}
          >
            {group.name}
          </span>
        )}
        <span className="clip-group-stat">
          {clips.length} 段 · {totalSec.toFixed(1)}s
          {selectedCount > 0 && (
            <span className="clip-group-sel"> · 已选 {selectedCount}/{clips.length}</span>
          )}
        </span>
        <div className="clip-group-actions">
          <button
            type="button"
            className="ghost-btn small"
            onClick={(e) => {
              e.stopPropagation()
              onToggleGroupSelect(group)
            }}
            title={allSelected ? '取消整组选中' : '一键选中整组'}
          >
            {allSelected ? '☐ 全' : '☑ 全'}
          </button>
          {onAddGroup && (
            <button
              type="button"
              className="ghost-btn small"
              onClick={(e) => {
                e.stopPropagation()
                onAddGroup(group)
              }}
              title={addLabel}
            >
              {addLabel}
            </button>
          )}
          {onUpdateDescription && (
            <button
              type="button"
              className="ghost-btn small"
              onClick={(e) => {
                e.stopPropagation()
                setEditingDesc(true)
              }}
              title="编辑组描述"
            >
              📝
            </button>
          )}
          <button
            type="button"
            className="ghost-btn small"
            onClick={(e) => {
              e.stopPropagation()
              setEditingName(true)
            }}
            title="重命名"
          >
            ✎
          </button>
          <button
            type="button"
            className="ghost-btn small danger-text"
            onClick={(e) => {
              e.stopPropagation()
              if (confirm(`解散「${group.name}」？组内 ${clips.length} 段视频将变回散段，本身不会被删除。`)) {
                onDissolve(group)
              }
            }}
            title="解散组"
          >
            ✕
          </button>
        </div>
      </div>

      {editingDesc ? (
        <div className="clip-group-desc-edit">
          <textarea
            ref={descInputRef}
            className="clip-group-desc-input"
            value={description}
            placeholder="写组描述，例如：开场镜头 / 产品特写…"
            rows={2}
            maxLength={200}
            onChange={(e) => setDescription(e.target.value)}
            onBlur={commitDescription}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setDescription(group.description ?? '')
                setEditingDesc(false)
              }
            }}
          />
        </div>
      ) : group.description ? (
        <div
          className="clip-group-desc"
          title="点击编辑描述"
          onClick={() => onUpdateDescription && setEditingDesc(true)}
        >
          {group.description}
        </div>
      ) : onUpdateDescription ? (
        <button
          type="button"
          className="clip-group-desc-add"
          onClick={() => setEditingDesc(true)}
        >
          + 添加组描述
        </button>
      ) : null}

      <div className="clip-group-body">{children}</div>
    </div>
  )
}
