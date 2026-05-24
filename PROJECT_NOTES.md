# Scissor App — 项目速记（给后续协作/迭代用）

这是一个基于 **Electron + Vite + React** 的本地视频处理工具，目标是：

- **视频去重/相似检测**（sha256、感知哈希、可选 chromaprint）
- **视频对比**（ffprobe 元数据对比，可选整文件 MD5）
- **视频“微扰/变换导出”**（轻量变速、色彩/噪点/裁切/旋转、贴纸叠加、底部遮挡、LUT、片头片尾拼接、跳剪等）
- **拼接/插入条带（stitch）**：把插入视频按边缘条带方式叠加到主视频，并可做一系列“混淆”参数（含 metadata 清理等）

## 运行与构建

- 开发：`npm run dev`
- 构建：`npm run build`（产物在 `out/`）
- 预览：`npm run preview`
- 打包：
  - mac：`npm run dist:mac`
  - win：`npm run dist:win`（会先跑 `scripts/ensure-win-binaries.cjs`，确保 `resources/win/ffmpeg.exe`/`ffprobe.exe` 齐全）

## 目录结构（关键路径）

- `src/main/`：Electron 主进程 + ffmpeg/ffprobe 调用逻辑
  - `src/main/index.ts`：IPC handlers（文件选择、ffmpeg 检测、compare/dedupe/transform/stitch 等）
  - `src/main/ffmpeg-utils.ts`：二进制探测、ffprobe 信息/时长/分辨率、感知哈希抽帧、transformVideo 等（核心）
  - `src/main/dedupe.ts`：去重聚类（sha256 桶 + 感知哈希 + chromaprint + 元数据）
  - `src/main/stitch.ts`：条带插入/拼接与混淆选项实现
  - `src/main/export-timeline.ts`：基于 filter_complex 的按片段导出
- `src/preload/index.ts`：通过 `contextBridge` 暴露 `window.scissor.*` API 给渲染进程
- `src/renderer/`：React UI
  - `src/renderer/src/App.tsx`：主界面（transform/compare/dedupe/stitch tabs）
  - `src/renderer/src/components/StitchPanel.tsx`：stitch UI + 进度显示 + 贴纸预览
- `src/shared/`：共享类型与对比/相似度逻辑
  - `src/shared/types.ts`：IPC/业务用到的主要类型（TransformOptions、StickerItem 等）
  - `src/shared/metadata-similarity.ts`：元数据相似度与 dedupe 阈值逻辑

## ffmpeg / ffprobe 二进制策略（重要）

主进程使用 `resolveBinariesSync()`：

1. 优先使用 npm 依赖的 `ffmpeg-static` + `ffprobe-static`
2. packaged 场景下，会尝试从 `extraResources`（如 `resources/win`）读取
3. 都不行再回退到系统 PATH/常见安装路径探测

因此：

- 开发模式通常不需要系统安装 ffmpeg（依赖静态包即可）
- **chromaprint 指纹（可选）需要系统有 `fpcalc`**（例如 macOS：`brew install chromaprint`），缺失时会自动降级为 `null`

## IPC（渲染层可用 API）

见 `src/preload/index.ts`，核心包括：

- `pickVideos` / `pickImage` / `pickSavePath` / `pickDirectory`
- `checkFfmpeg` / `getLuts`
- `compareVideos`（可选 md5）
- `dedupeScan`
- `transformVideo`
- `stitchVideo` + `onFfmpegProgress`（从 stderr 解析 time/speed）

## 资源文件

- `resources/luts/*.cube`：LUT 预设（`getLuts` 暴露给 UI）
- `resources/win/ffmpeg.exe` + `resources/win/ffprobe.exe`：用于 Windows 打包（开发时不依赖这里）

