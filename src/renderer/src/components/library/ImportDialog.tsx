import { useState } from 'react'
import { DEFAULT_IMPORT_OPTIONS, type ImportOptions } from '../../../../shared/library'

type Props = {
  files: string[]
  onCancel: () => void
  onConfirm: (opts: Omit<ImportOptions, 'paths'>) => void
}

function basename(p: string): string {
  return p.split(/[/\\]/).pop() ?? p
}

export function ImportDialog({ files, onCancel, onConfirm }: Props) {
  const [cleanup, setCleanup] = useState<ImportOptions['cleanup']>(DEFAULT_IMPORT_OPTIONS.cleanup)
  const [sceneThreshold, setSceneThreshold] = useState(DEFAULT_IMPORT_OPTIONS.sceneThreshold)
  const [minSegSec, setMinSegSec] = useState(DEFAULT_IMPORT_OPTIONS.minSegSec)
  const [maxSegSec, setMaxSegSec] = useState(DEFAULT_IMPORT_OPTIONS.maxSegSec)

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>导入到素材池</h3>
          <button type="button" className="del-btn" onClick={onCancel}>
            ×
          </button>
        </div>

        <div className="modal-body">
          <div className="modal-section">
            <div className="modal-section-title">{files.length} 个视频文件</div>
            <ul className="modal-file-list">
              {files.slice(0, 6).map((f) => (
                <li key={f}>{basename(f)}</li>
              ))}
              {files.length > 6 && <li>…还有 {files.length - 6} 个</li>}
            </ul>
          </div>


          <div className="modal-section">
            <div className="modal-section-title">指纹清洗强度</div>
            <div className="modal-radios">
              <label>
                <input
                  type="radio"
                  checked={cleanup === 'metadata-only'}
                  onChange={() => setCleanup('metadata-only')}
                />
                <span>
                  <strong>仅元数据</strong>：剥 metadata，不重编码（最快）
                </span>
              </label>
              <label>
                <input
                  type="radio"
                  checked={cleanup === 'light'}
                  onChange={() => setCleanup('light')}
                />
                <span>
                  <strong>轻度</strong>：剥 metadata + H.264 重编码
                </span>
              </label>
              <label>
                <input
                  type="radio"
                  checked={cleanup === 'standard'}
                  onChange={() => setCleanup('standard')}
                />
                <span>
                  <strong>标准</strong>：剥 metadata + 重编码 + 轻噪点 / 微裁切 / 轻模糊（推荐）
                </span>
              </label>
            </div>
            <div className="modal-hint">
              ⚠ 视频「隐形水印 / 指纹」无法保证 100% 清除，仅能削弱。
            </div>
          </div>

          <div className="modal-section">
            <div className="modal-section-title">镜头切分</div>
            <div className="modal-row">
              <label>
                场景阈值
                <input
                  type="range"
                  min={0.15}
                  max={0.6}
                  step={0.05}
                  value={sceneThreshold}
                  onChange={(e) => setSceneThreshold(Number(e.target.value))}
                />
                <span className="modal-val">{sceneThreshold.toFixed(2)}</span>
              </label>
            </div>
            <div className="modal-row">
              <label>
                最小段
                <input
                  type="number"
                  min={0.3}
                  max={5}
                  step={0.1}
                  value={minSegSec}
                  onChange={(e) => setMinSegSec(Number(e.target.value))}
                />
                <span className="modal-val">秒</span>
              </label>
              <label>
                最大段
                <input
                  type="number"
                  min={2}
                  max={30}
                  step={0.5}
                  value={maxSegSec}
                  onChange={(e) => setMaxSegSec(Number(e.target.value))}
                />
                <span className="modal-val">秒</span>
              </label>
            </div>
            <div className="modal-hint">短于最小段会合并到邻段；长于最大段会强切。</div>
          </div>
        </div>

        <div className="modal-foot">
          <button type="button" className="ghost-btn" onClick={onCancel}>
            取消
          </button>
          <button
            type="button"
            className="primary-btn"
            onClick={() =>
              onConfirm({ audioMode: 'extract', cleanup, sceneThreshold, minSegSec, maxSegSec })
            }
          >
            开始导入
          </button>
        </div>
      </div>
    </div>
  )
}
