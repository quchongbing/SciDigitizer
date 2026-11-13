# Regression checks / 回归检查

Run from the project root / 在项目根目录执行：

```sh
npm run build:file
npm run check
npm test
npm run test:scatter
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
- `test:scatter`: 60 deterministic separated-marker cases: filled/hollow circles,
  crosses, pluses and stars; irregular series, clouds with repeated x values,
  vertical columns and dense clouds at two resolutions. Checks one-to-one centre
  matching, missed/extra points, calibration and export without interpolation.
  These cases also run in `npm test`. Touching symbols and hidden coincident
  records are not certified; screenshots cannot reveal hidden multiplicity.
  60 组可分离散点测试，覆盖实心/空心圆、叉号、十字、星形点，不规则序列、同 x
  多点、竖直点列和密集点云；检查中心位置、漏点、误检、标定及不插值导出。
  同时纳入 `npm test`；粘连符号和完全重叠点的原始数量不在保证范围内。
  In the UI, choose Scatter / marker centers, then pick one clear symbol;
  guides are optional. 在界面选择“散点 / marker 中心”，点击一个清晰标记即可，
  无需先添加曲线引导点。
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
  Also picks the red solid line once, then paints its full route at 12/24/40 px
  in both Pen scopes. Checks full coverage, branch identity, estimate labels
  and export availability without adding endpoint guides.
  另检查红色实线单点选择后，以 12/24/40 px 笔宽涂完整路径，两种 Pen 范围均
  验证覆盖、分支身份、估计标记和导出可用性，不补端点引导点。
  Blue solid/dashed checks use automatic line-type selection, one target click,
  both scopes, and 12/24 px brushes painted before/after the click. A partial
  strict stroke excluding the click must retain the previous 100 points and
  density, report the scope mismatch, and recover when the route is completed.
  蓝色实线/虚线检查使用自动线型、一个目标点、两种范围及 12/24 px 笔宽，
  覆盖先涂画或先选点的操作。完整约束下笔迹不含目标点时，应保留上次 100 点
  及采样数量、提示范围不匹配，并在补涂完整路径后恢复。
  Late blue-solid repair tests paint only the hidden right tail at 12/24/40 px
  using the new local default, leaving the original left click outside the
  paint. They check full coverage, unchanged visible left pixels and guides,
  estimate metadata, and export. The strict warning's local-retry button is
  tested separately; saved strict scopes still remain strict on restore.
  右侧局部修补测试使用默认局部辅助，以 12/24/40 px 笔宽只涂蓝色实线遮挡尾段，
  不覆盖左侧原选点；验证完整覆盖、左侧观测与引导点不变、估计标记及导出。
  另检查完整约束失败后的局部重试按钮；恢复旧项目时仍保留已存的完整约束。
  Unit checks also reject distant/side entries and explicit entrance erasures,
  in both horizontal and vertical frames. Hidden-point checks validate the
  painted trajectory and labels, not the unknowable location of hidden ink.
  单元测试还检查横向/纵向的远距离、侧向和擦除入口均不可伪造连接。
  遮挡点检查验证的是涂画路径与标记，不等同于验证原图不可见的真实曲线位置。
  Also checks a 32-point cloud with four y values at each x through manual
  marker selection, optional guides, calibration and CSV/TXT export.
  另检查 32 点散点云（每个 x 对应四个 y）的取色、可选引导、标定和 CSV/TXT 导出。
  Recalibration checks cover live coordinates, log axes, moved reference ticks,
  explicit updates to one/all saved curves, independent overlay calibrations,
  invalid endpoints, undo/redo and project round-trips without moving data points.
  重新标定检查覆盖实时坐标、对数轴、刻度位置修正、单条/全部已存曲线更新、
  平移曲线的独立标定、非法端点、撤销/重做和项目恢复，并确认数据点位置不变。

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

Three further scientific screenshots can be checked locally without adding
them to the repository. Checks eight panels and seven selected extraction
cases, not every scientific data point or dense merged symbol.
另外三张科研截图可在本地检查，无需收录进仓库；验证八个面板及七组指定提取案例，
不等于验证全部原始数据点或密集粘连符号：

```sh
node tools/research-image-smoke.mjs dispersion.png four-panels.png three-panels.png
```
