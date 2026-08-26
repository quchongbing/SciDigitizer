# SciDigitizer

> Local-first, assisted curve digitization for scientific plots.<br>
> 本地运行的科学曲线智能提取工具。

[中文说明](#中文) · [English](#english)

**[Open SciDigitizer online / 在线使用](https://quchongbing.github.io/SciDigitizer/)** · **[Desktop downloads / 桌面版下载](https://github.com/quchongbing/SciDigitizer/releases)** · **[Installation guide / 安装指南](docs/installation.md)**

![Version](https://img.shields.io/badge/version-0.20.0-1666d8)
![Local](https://img.shields.io/badge/data-local--only-00a9a5)
![Tests](https://img.shields.io/badge/tests-75%20passing-2f8f5b)
![License](https://img.shields.io/badge/license-MIT-f0c040)

SciDigitizer 从 PNG、JPEG 或 WebP 图像中提取曲线数据。通常只需选择曲线颜色；遇到同色分支、交叉或遮挡时，再添加少量引导点。图像和数据始终保留在浏览器本地。

SciDigitizer extracts curve data from PNG, JPEG, and WebP images. Pick a curve color, then add a few guide points only where branches, crossings, or occlusions are ambiguous. Images and data stay in your browser.

这是由 Chongbing Qu（瞿崇兵）创建的个人开源项目，以宽松的 MIT 许可证贡献给所有人：任何人都可以使用、研究、修改、分享或用于商业项目，只需保留版权和许可证声明。

SciDigitizer is a personal open-source project created by Chongbing Qu (瞿崇兵) and shared for everyone under the permissive MIT License. Anyone may use, study, modify, redistribute, or commercialize it while retaining the copyright and license notice.

---

## 中文

### 主要功能

- 自动沿图框外缘建议绘图区，支持照片旋转、两点校水平/垂直和透视矫正。
- 人工坐标标定，支持 Linear、Log10 和 Piecewise 轴；每条已保存曲线独立保留标定，适合 Y 轴平移的叠加图。
- 自动追踪实线、虚线、点划线、点线、噪声线和 marker 中心。
- 亚像素线宽中心校正；用直线、Hermite 和二次趋势恢复遮挡段。
- 引导点始终作为追踪基准；支持多条同色曲线避让。
- 智能复核低置信度、遮挡推断和模型分歧区域。
- 导出 CSV、TXT、项目 JSON 和 Overlay PNG。
- 默认显示英文；GUI 顶部可随时切换 `中文 / EN`，选择会保存在本机。

### 快速开始

- 无需安装：直接打开[在线版](https://quchongbing.github.io/SciDigitizer/)。
- 桌面使用：从 [Releases](https://github.com/quchongbing/SciDigitizer/releases) 下载约 1–1.3 MiB 的对应系统版本，并按照[安装指南](docs/installation.md)操作。

### 最短使用流程

1. 打开图片，确认方向和绘图区。
2. 输入 X/Y 已知刻度值，并点击图中对应刻度完成标定。
3. 点击目标曲线取色，程序会立即追踪。
4. 遮挡处先框选“遮挡 / 图例”以忽略覆盖物，再在前后添加引导点；长遮挡可在预计趋势上再加一点，该点会自动启用局部强约束。
5. 查看“智能复核”，拖动或编辑不准确的数据点。
6. 保存曲线；如下一条曲线使用平移后的 Y 轴，可重新标定，已保存曲线的坐标不会改变。最后导出数据。

“智能复核”表示程序发现低置信度、遮挡推断或多模型分歧，提示人工检查，并不等于结果一定错误。橙心虚线圆圈表示推断点。完全不可见的数据无法从栅格图中确定；程序给出的是受可靠像素和引导点约束的估计。

---

## English

### Highlights

- Suggests the plot area along the visible outer frame and supports rotation, two-point alignment, and perspective correction.
- Manual Linear, Log10, and Piecewise calibration, stored independently for every saved curve—including vertically offset overlays.
- Traces solid, dashed, dash-dot, dotted, noisy lines, and marker centers.
- Refines the subpixel stroke center and recovers occlusions with linear, Hermite, and quadratic models.
- Keeps every guide point as an exact tracing constraint and avoids saved same-color curves.
- Ranks low-confidence, inferred, and model-disagreement regions for review.
- Exports CSV, TXT, project JSON, and overlay PNG files.
- English is the default; switch between `中文 / EN` from the top bar. Your choice is stored locally.

### Quick start

- No installation: open the [browser edition](https://quchongbing.github.io/SciDigitizer/).
- Desktop: download the approximately 1–1.3 MiB package for your system from [Releases](https://github.com/quchongbing/SciDigitizer/releases), then follow the [installation guide](docs/installation.md).

### Short workflow

1. Open an image and confirm its orientation and plot area.
2. Enter known X/Y tick values and click the matching ticks to calibrate the axes.
3. Click a clear part of the target curve to sample its color and trace it.
4. Mask an occlusion or legend first, then add guides on both sides. For a long occlusion, add a guide along the expected trend; it automatically constrains adjacent segments.
5. Use Smart review, then drag or edit inaccurate points.
6. Save the curve. Recalibrate Y for a vertically offset series when needed; saved coordinates remain unchanged. Then export the data.

Smart review means low confidence, occlusion inference, or model disagreement merits inspection; it does not mean the result is necessarily wrong. Orange dashed circles are inferred points. Details hidden in every source pixel cannot be recovered uniquely; the application reports a constrained estimate instead.

---

## Development

```bash
npm run serve
npm run check
npm test
npm run smoke:real
npm run benchmark
```

### 轻量桌面版 / Lightweight desktop builds

SciDigitizer 也可以通过 Neutralinojs 打包成数 MB 的 Windows、macOS 或 Linux 桌面应用，复用系统 WebView 而不内置 Chromium。

普通用户请参阅简明的 [Windows、Linux 与 macOS 安装指南](docs/installation.md)。

SciDigitizer can also be wrapped as a few-megabyte Windows, macOS, or Linux desktop application with Neutralinojs. It reuses the system WebView instead of bundling Chromium. See the concise [Windows, Linux, and macOS installation guide](docs/installation.md). Developers can find the size budget and build commands in [desktop packaging](docs/desktop-packaging.md).

The application has no runtime npm dependencies and requires no backend. Project schema v6 stores per-series calibration, guides, editable points, confidence, occlusion-model weights, uncertainty, and preprocessing records. Older project files remain supported. Uploaded image pixels are not embedded in project JSON.

Maintainers publish an audited source snapshot without private development history. See the [public release workflow](docs/public-release.md).

The tracing engine is best suited to horizontally single-valued line plots. Near-vertical loops, extremely low-resolution images, indistinguishable black-and-white objects, and fully hidden curve details still require manual review or original vector/source data.

## License / 许可证

Copyright © 2026 Chongbing Qu（瞿崇兵）. SciDigitizer—including the retained built-in example—is released under the [MIT License](LICENSE).
