# SciDigitizer

> Local-first, assisted curve digitization for scientific plots.<br>
> 本地运行的科学曲线智能提取工具。

[中文说明](#中文) · [English](#english)

**[Open SciDigitizer online / 在线使用](https://quchongbing.github.io/SciDigitizer/)** · **[Desktop downloads / 桌面版下载](https://github.com/quchongbing/SciDigitizer/releases)** · **[Installation guide / 安装指南](docs/installation.md)**

![Version](https://img.shields.io/badge/version-0.20.0--preview.3.22-1666d8)
![Local](https://img.shields.io/badge/data-local--only-00a9a5)
![Tests](https://img.shields.io/badge/tests-184%20passing-2f8f5b)
![License](https://img.shields.io/badge/license-MIT-f0c040)

SciDigitizer 从 PNG、JPEG 或 WebP 图像中提取曲线数据。通常只需选择曲线颜色；遇到同色分支、交叉或遮挡时，再添加少量引导点。图像和数据始终保留在浏览器本地。

SciDigitizer extracts curve data from PNG, JPEG, and WebP images. Pick a curve color, then add a few guide points only where branches, crossings, or occlusions are ambiguous. Images and data stay in your browser.

这是由 Chongbing Qu（瞿崇兵）创建的个人开源项目，以宽松的 MIT 许可证贡献给所有人：任何人都可以使用、研究、修改、分享或用于商业项目，只需保留版权和许可证声明。

SciDigitizer is a personal open-source project created by Chongbing Qu (瞿崇兵) and shared for everyone under the permissive MIT License. Anyone may use, study, modify, redistribute, or commercialize it while retaining the copyright and license notice.

---

## 中文

### 主要功能

- 自动沿图框外缘建议绘图区，支持照片旋转、两点校水平/垂直和透视矫正。
- 可通过文件选择、拖放或直接粘贴截图导入 PNG、JPEG 和 WebP；非图片剪贴板内容不会影响当前项目。
- 人工坐标标定，支持 Linear、Log10 和 Piecewise 轴；默认两点、可选 3–5 点稳健拟合，并可把人工点击微调到刻度中心。每条已保存曲线独立保留标定，适合 Y 轴平移的叠加图。
- 自动追踪实线、虚线、点划线、点线和噪声线；点击一个清晰 marker 时会根据重复形状、间距和路径连续性自动识别整组中心，证据不足则安全回退。
- 自动识别近垂直曲线并切换为纵向追踪，按曲线顺序保留重复 X 值；普通曲线继续使用原有快速横向路径，高级参数中也可手动指定方向。
- 自动识别拓扑清晰的开放式发卡弯、圆环和闭合回线，以二维像素图沿完整曲线排序，并按屏幕弧长输出；重复 X/Y、路径顺序和手工引导点均会保留。证据不足时不会擅自覆盖普通追踪结果。
- 明确选择“二维路径”后，可沿切向连续方向完整遍历“8”字形等欧拉型自交闭环；栅格交叉中心会按需要重复经过，并在质量报告中保留人工复核提示。自交拓扑暂不自动启用。
- 对带额外枝杈的开放二维曲线，两个或更多按目标顺序放置的引导点会选择起止端并串联图路径；没有引导支持的支路不会进入结果。该模式保持显式启用并强制复核。
- 二维圆环或发卡弯被已框定的图例/遮挡切断时，会仅在遮挡框内尝试切向重连；近似等价的连接会被拒绝。补出的点保留推断来源，并让不确定度向遮挡中心增大。
- 明确识别为虚线、点线或点划线的二维闭环/发卡弯，会在至少三个短间隔呈现稳定重复指纹且配对明确时重连；点划线中的短点还会结合相邻线段方向判断。间隔点始终标为推断结果；同色相邻闭环不会被合并，Pen 区域可用于隔离目标，普通实线或任意缺失段不会被自动补造。
- 框选绘图区后会保守发现横向持续的彩色曲线，以小色块提供一键提取入口；短图例色块、灰色网格和已提取颜色会被忽略。
- 在线版和桌面版会在后台 Worker 中完成颜色发现、目标分类与曲线追踪，大图计算时鼠标和标定界面仍可响应；直接双击 `index.html` 时自动使用结果一致的同步回退。
- 全局多候选追踪会保留交叉和重合处的不同路径历史，再利用后续像素或引导点选择整条路径。
- 亚像素线宽中心校正；长遮挡段会比较直线、正则平滑、Hermite 和二次趋势，并显示随无像素支撑距离增长的不确定度。
- 引导点始终作为追踪基准；支持多条同色曲线避让。
- Pen 曲线走廊可局部限定普通追踪；对折返或横竖混合曲线，涂完整路径并添加至少 3 个引导点（顺序不限），可在同色交叉处选择连续二维路径。此类有分支结果会明确要求复核。
- 可按需扫描绘图区内的图例和文字块，以橙色候选框供用户复核；启动时不显示，接受前不会屏蔽像素或改变追踪结果。
- 选中标定点或数据点后，方向键移动 1 px，`Shift` + 方向键微调 0.1 px。
- 智能消歧会定位最值得确认的同色分叉；点击一次正确分支即可加入受保护基准并全局重追踪。
- 导出 CSV、TXT、项目 JSON 和 Overlay PNG。
- 默认显示英文；GUI 顶部可随时切换 `中文 / EN`，选择会保存在本机。

### 快速开始

- 无需安装：直接打开[在线版](https://quchongbing.github.io/SciDigitizer/)。
- 桌面使用：从 [Releases](https://github.com/quchongbing/SciDigitizer/releases) 下载约 1.0–1.4 MiB 的对应系统版本，并按照[安装指南](docs/installation.md)操作。
- 源码离线使用：保留下载或克隆目录的完整结构，直接双击根目录中的 `index.html`；无需启动服务器。

### 最短使用流程

1. 打开、拖入或粘贴图片，确认方向和绘图区。
2. 输入 X/Y 已知刻度值，并点击图中对应刻度完成标定。通常每轴两点即可；需要复核精度时可增加参考点，黄色提示会指出拟合残差或疑似误点。
3. 点击目标曲线取色，程序会立即追踪；也可直接点程序发现的候选色块，从可靠位置一键开始。
4. 需要排除图例或文字时，可在绘图区中点击扫描并复核橙色框；普通图片无需处理。多曲线重合或邻近时，用“Pen 曲线走廊”涂出目标的大致路径，可先画 Pen 再首次选择曲线。若曲线折返、横竖混合或穿过同色线，请涂完整路径，并在交叉和转弯前后添加至少 3 个引导点；添加顺序不限，程序会沿 Pen 路径自动整理。遮挡处可框选“遮挡 / 图例”。
5. 若出现“智能消歧”，点击“定位并确认分支”，再在高亮候选中点击一次正确曲线；其他低置信度区域仍可拖动或编辑。
6. 保存曲线；如下一条曲线使用平移后的 Y 轴，可重新标定，已保存曲线的坐标不会改变。最后导出数据。

“智能消歧”只在程序发现同色候选分支或高风险局部区间时出现。它会避开已有引导点，并选择候选已经足够分开、最适合点击的位置。橙心虚线圆圈表示推断点。完全不可见的数据无法从栅格图中确定；程序给出的是受可靠像素和引导点约束的估计。

---

## English

### Highlights

- Suggests the plot area along the visible outer frame and supports rotation, two-point alignment, and perspective correction.
- Imports PNG, JPEG, and WebP through the file picker, drag and drop, or direct screenshot paste; non-image clipboard content leaves the current project untouched.
- Manual Linear, Log10, and Piecewise calibration with a simple two-point default, optional 3–5 point robust fitting, and local tick-center refinement. Calibration remains independent for every saved curve—including vertically offset overlays.
- Traces solid, dashed, dash-dot, dotted, and noisy lines. One clear marker click can recognize a repeated series from shape, spacing, and path continuity; weak evidence safely falls back.
- Detects near-vertical curves and switches to vertical tracing while retaining repeated X values in curve order. Ordinary curves keep the established fast horizontal path; direction can also be forced under Advanced tracing.
- Detects topologically clear open hairpins, rings, and closed loops, orders the full two-dimensional pixel path, and samples it by screen-space arc length. Repeated X/Y values, path order, and exact manual guides are preserved; weak topology never overrides the ordinary trace automatically.
- When **2D path** is selected explicitly, traverses Eulerian self-intersecting loops such as figure-eights with tangent-continuous junction choices. The raster crossing is revisited when required and remains flagged for review; branched topology is not enabled automatically.
- For open two-dimensional curves with extra spurs, two or more guides placed in target order select the endpoints and route the graph through every guide. Unsupported branches stay out of the result; this mode remains explicit and review-required.
- When a masked legend or occlusion cuts a two-dimensional loop or hairpin, tangent-compatible endpoints can reconnect only through that declared region; near-equivalent matches are rejected. Inferred points retain provenance and uncertainty that increases toward the hidden centre.
- Two-dimensional loops and hairpins explicitly classified as dashed, dotted, or dash-dot reconnect only when at least three short gaps form a stable repeated fingerprint and the pairings are unambiguous; compact dash-dot points also use the direction of adjacent strokes. Gap points remain visibly inferred, nearby same-colour loops are not fused, and a Pen corridor can isolate the intended component. Ordinary solid curves and arbitrary missing spans are never invented.
- Conservatively discovers horizontally persistent coloured curves after plot selection and offers one-click colour chips, while ignoring short legend swatches, gray grids, and colours already extracted.
- Runs colour discovery, target classification, and tracing in a background Worker in the browser and desktop editions so pointer and calibration controls stay responsive on large images; direct `index.html` use falls back to the same deterministic engine synchronously.
- Keeps multiple global path hypotheses through crossings and overlaps, then resolves them with later pixels or guides.
- Refines the subpixel stroke center; long occlusions compare linear, regularized smooth, Hermite, and quadratic models, with uncertainty increasing with unsupported distance.
- Keeps every guide point as an exact tracing constraint and avoids saved same-color curves.
- Uses an optional Pen corridor locally for ordinary traces. For a hairpin or mixed-direction curve, painting the full route and adding at least three guides in any order selects a continuous 2D path through same-colour crossings; branched results remain explicitly review-required.
- Scans for likely in-plot legends or text blocks on demand, not at startup; orange candidates never mask pixels or alter a trace until you accept them.
- Moves selected calibration or data points by 1 px with arrow keys, or 0.1 px with `Shift` + arrow keys.
- Locates the most informative same-color branch ambiguity; one click adds a protected guide and retraces the whole curve globally.
- Exports CSV, TXT, project JSON, and overlay PNG files.
- English is the default; switch between `中文 / EN` from the top bar. Your choice is stored locally.

### Quick start

- No installation: open the [browser edition](https://quchongbing.github.io/SciDigitizer/).
- Desktop: download the approximately 1.0–1.4 MiB package for your system from [Releases](https://github.com/quchongbing/SciDigitizer/releases), then follow the [installation guide](docs/installation.md).
- Offline source copy: keep the downloaded or cloned directory intact and double-click the root `index.html`; no server is required.

### Short workflow

1. Open, drop, or paste an image and confirm its orientation and plot area.
2. Enter known X/Y tick values and click the matching ticks. Two references per axis are normally enough; add references when you want residual checks and misplaced-point warnings.
3. Click a clear part of the target curve to sample its colour and trace it, or use a discovered colour chip to start from a reliable point in one click.
4. To exclude legends or text, request a scan under Plot area and review the orange boxes; ordinary images need no action. For overlapping or nearby curves, paint an approximate Pen corridor; you may paint before the first target pick. For a hairpin, mixed-direction curve, or same-colour crossing, paint the full route and add at least three guides around crossings and turns in any order; the app orders them along the Pen route. For an occlusion, mask the covering object.
5. If Smart disambiguation appears, choose **Locate and confirm branch**, then click the correct highlighted candidate once. Drag or edit any remaining low-confidence points if needed.
6. Save the curve. Recalibrate Y for a vertically offset series when needed; saved coordinates remain unchanged. Then export the data.

Smart disambiguation appears only for competing same-color branches or another high-risk local interval. It avoids existing guides and chooses a place where the alternatives are visually separable. Orange dashed circles are inferred points. Details hidden in every source pixel cannot be recovered uniquely; the application reports a constrained estimate instead.

---

## Development

```bash
npm run serve
npm run check
npm test
npm run smoke:real
npm run benchmark
npm run benchmark:check
```

The deterministic [accuracy benchmark](docs/benchmark-report.md) covers 30 ordinary/stress fixtures plus twelve ordered two-dimensional paths with exact pixel ground truth. CI protects one-click simple-curve accuracy and warmed fast-path latency, as well as coverage, wrong-branch, marker, degraded-raster and patterned parametric topology/provenance, guide retention, plot area, and photographed-geometry metrics.

### 轻量桌面版 / Lightweight desktop builds

SciDigitizer 也可以通过 Neutralinojs 打包成数 MB 的 Windows、macOS 或 Linux 桌面应用，复用系统 WebView 而不内置 Chromium。

普通用户请参阅简明的 [Windows、Linux 与 macOS 安装指南](docs/installation.md)。

SciDigitizer can also be wrapped as a few-megabyte Windows, macOS, or Linux desktop application with Neutralinojs. It reuses the system WebView instead of bundling Chromium. See the concise [Windows, Linux, and macOS installation guide](docs/installation.md). Developers can find the size budget and build commands in [desktop packaging](docs/desktop-packaging.md).

The application has no runtime npm dependencies and requires no backend. Project schema v8 stores per-series calibration—including multi-reference settings—Pen corridors, guides, editable points, confidence, occlusion and calibration uncertainty, and preprocessing records. Older project files remain supported. Uploaded image pixels are not embedded in project JSON.

Maintainers publish an audited source snapshot without private development history. See the [public release workflow](docs/public-release.md).

The tracing engine handles ordinary single-valued curves, near-vertical paths, simple open hairpins, simple closed loops, explicitly selected Eulerian self-intersections, and guide-routed open spurs. Generally multiply connected paths, extremely low-resolution images, indistinguishable black-and-white objects, and fully hidden curve details still require manual review or original vector/source data.

## License / 许可证

Copyright © 2026 Chongbing Qu（瞿崇兵）. SciDigitizer—including the retained built-in example—is released under the [MIT License](LICENSE).
