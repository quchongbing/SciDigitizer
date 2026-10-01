# Regression checks / 回归检查

Run from the project root / 在项目根目录执行：

```sh
npm run build:file
npm run check
npm test
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
- `smoke:real`: the bundled example's green, orange, blue and red curves through
  the actual computation/output pipeline, including green near-miss clicks and
  per-case geometry/export checks. 内置示例各色曲线的实际处理链检查，
  包括绿色曲线点击偏差和逐案例几何、导出验证。
- `smoke:app`: isolated Chrome browser workflows for HTTP/Worker and `file://`
  modes, including Pen, calibration, editing, draft recovery and export.
  使用独立 Chrome 测试 HTTP/Worker 与 `file://` 的 Pen、标定、编辑、草稿和导出。

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

```sh
node tools/real-pen-smoke.mjs /path/to/regime-diagram.png
```
