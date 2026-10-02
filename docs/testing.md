# Regression checks / 回归检查

Run from the project root / 在项目根目录执行：

```sh
npm run build:file
npm run check
npm test
npm run test:pen
npm run benchmark:check
npm run smoke:real
npm run smoke:app
```

- `test`: isolated algorithm/state tests, plus self-authored grey-curve fixtures
  that exercise automatic colour selection, tracing, sampling and export.
  Includes nearby dark grids, low contrast, antialiasing and shaded backgrounds.
  算法与状态测试，以及自有灰度曲线的取色、追踪、采样、导出整链测试；
  覆盖邻近黑网格、低对比、抗锯齿和底色变化。
- `benchmark:check`: deterministic accuracy regression gates; does not update
  the baseline. 合成精度回归检查，不修改基线。
- `test:pen`: 2,100 deterministic cases covering mirrored/rotated curves,
  narrow and wide brushes, local/strict scope, sparse/dense output, one-pixel
  eraser cuts, same-colour crossings and inclined/near-vertical dashed lines.
  Checks guide retention, restoration and export as well as extraction.
  No third-party images or generated files are needed.
  2,100 组确定性案例，覆盖镜像/旋转、不同笔宽、局部/完整约束、不同点数、
  单像素擦除缺口、同色交叉和倾斜/近垂直虚线，同时检查引导点保留、恢复与导出；
  不依赖外部图片，也不生成测试文件。
- `smoke:real`: the bundled example's green, orange, blue and red curves through
  the actual computation/output pipeline, including green near-miss clicks and
  per-case geometry/export checks. 内置示例各色曲线的实际处理链检查，
  包括绿色曲线点击偏差和逐案例几何、导出验证。
- `smoke:app`: isolated Chrome browser workflows for HTTP/Worker and `file://`
  modes, including Pen, calibration, editing, draft recovery and export.
  使用独立 Chrome 测试 HTTP/Worker 与 `file://` 的 Pen、标定、编辑、草稿和导出。
  Includes actual mouse-painted local Pen on the example's blue dashed curve
  at 12/24 px, marker-count reduction with locked guides, and revalidation of
  both legacy and newer drafts; old validity flags are not trusted.
  包括用鼠标涂画示例蓝色虚线的 12/24 px 局部 Pen、减少标记点时保留引导点，
  以及新旧草稿重新校验（不直接信任已保存的“有效”标记）。

Browser checks require Node.js 22+, Python 3 and installed Chrome/Chromium.
They use temporary browser storage and automatically allocated ports; the
normal browser and development server are not reused. See
`node tools/run-app-smoke.mjs --help` for executable overrides and timeout settings.
浏览器检查需要 Node.js 22+、Python 3 和已安装的 Chrome/Chromium；
使用临时配置及自动分配端口，不复用日常浏览器或开发服务。

CI and release workflows run these gates before packaging. Browser tests do
not establish native Windows/macOS/Linux desktop compatibility; desktop builds
still require platform-specific launch/import/export verification.
CI 和发布流程在打包前执行这些检查；浏览器测试不等于各平台桌面兼容性验证，
桌面安装包仍需在对应系统检查启动、导入与导出。

The external regime-diagram regression remains optional; its image is not
distributed in this repository. 外部相图测试仍为可选，仓库不收录该图片：
It checks 28 combinations of 12/24/40 px Pen widths or guides alone, local/strict
scope, two colour thresholds and reversed guide order, plus rejection of an
incomplete strict corridor. It asserts vertical-tail coverage and rejects the
competing black diagonal and plot frame.
检查 28 组不同笔宽（12/24/40 px）或仅引导点、局部/完整约束、颜色阈值及
反向引导点顺序的组合，另检查完整约束下不完整笔迹的拒绝行为；验证竖直尾段
覆盖，并排除另一条黑色斜线与坐标框。

```sh
node tools/real-pen-smoke.mjs /path/to/regime-diagram.png
```
