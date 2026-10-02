# Pen and near-vertical curves / Pen 与近垂直曲线

Ordinary curves still start with **Pick target curve**. Pen is optional.
普通曲线仍从“选择目标曲线”开始；Pen 是可选辅助工具。

You may also open the optional assistance section and paint before the first
target pick; that pick retains the prepared Pen. Picking a different target
or starting the next curve clears the previous curve's Pen.
也可先展开可选辅助、画 Pen，再首次选择曲线，笔迹不会被清空。
重新选择另一目标或开始下一条曲线时，仍会清除上一条曲线的 Pen。

Erased pixels stay excluded even when a cut splits a local stroke into separate
parts; they are not treated as an unpainted extension gap. Repaint to restore
those pixels. Clearing or completely erasing the Pen restores unrestricted
plot-area search. A failed retrace blocks export rather than inventing a bridge.
局部笔迹即使被擦断，擦掉的像素也不能成为自动延伸通道；补涂后才能恢复。
清除或完全擦掉 Pen 后恢复全绘图区搜索。重追踪失败时会暂停导出，不会伪造连接。

With Pen active, automatic direction selection compares actual curve pixels
inside the painted route, so an exposed same-colour axis cannot win merely by
spanning the plot. Horizontal and vertical candidates use the same image-distance
scale, not different counts of raster columns/rows. Each direction candidate must pass Pen validation before
selection. Gap connections are checked against Pen before fitting; the complete
underlying path is checked again before sampling, restoration, and export.
使用 Pen 时，自动方向判断会比较笔迹内的真实曲线像素，避免同色坐标轴仅凭跨度大被误选。
横向和纵向候选使用统一的图像距离尺度比较，不再直接比较列数与行数。
各追踪方向的候选路径须先通过 Pen 检查，才能参与选择。缺口连接在拟合前
检查 Pen 范围；采样、恢复和导出前，还会检查完整的原始路径。

## Pen scope / 约束范围

- **Local assistance (optional):** each painted section is constrained, including
  unpainted pixels beside it. Tracing may continue beyond its two end boundaries,
  shown as dashed lines, but cannot bypass the section on a neighbouring curve.
  End directions come from the brush geometry, so vertical strokes and turns do
  not depend on the selected tracing orientation. Near each end, a widening
  tangent entrance prevents immediate jumps to remote parallel ink without
  closing off the rounded brush cap. Farther away, ordinary search resumes.
  Follow the curve when painting
  a turn; a closed stroke has no exit. A single dab has no reliable direction.
  **局部辅助（可选）：**已涂区段只能在 Pen 内搜索，不能从侧面绕到其它曲线；
  允许越过笔迹两端的虚线边界接续。端点方向由笔迹确定，横向、竖向和转弯
  遵守同一范围。端部附近通过逐渐变宽的切向通道接续，避免立即跳到远处的
  平行曲线，也不会把圆头笔迹的合法入口封死；更远处恢复普通搜索。
  转弯处请顺着曲线涂画；闭合笔迹没有出口，单个点涂无法确定方向。
- **Painted area only (default for new curves):** all automatically generated points must stay inside
  the painted area. Paint the full target route, including turns and endpoints.
  **仅在涂画区域提取（新曲线默认）：**所有自动生成的点必须位于涂画区域内。
  请覆盖完整目标路径，包括转弯和端点。
- The scope does not change when the algorithm switches between horizontal,
  vertical and 2D tracing. Manual guide coordinates remain authoritative,
  including guides outside the Pen. Scope is saved with each curve.
  横向、纵向和二维追踪使用相同范围。手工引导点始终保留原坐标，
  包括 Pen 外的引导点；范围设置随每条曲线保存。

Old local-Pen results that bypass the stronger constraints are retained but
marked for retracing on restore; they cannot silently be exported as valid.
Draft restoration revalidates active and saved curves even if an older version
recorded them as current. Discrete marker dabs remain separate during validation.
旧项目里绕过局部 Pen 的数据会保留，但恢复时会标记为需要重新追踪，不能
继续作为有效结果直接导出。不要把“完整涂画”模式用于只画了一小段的笔迹。
恢复草稿时会重新检查当前与已存曲线，即使旧版把它们标记为有效；离散标记点仍按独立点检查。

## Vertical segments / 垂直段

Guides may share an X or Y coordinate. For a curve that turns from horizontal
to vertical and crosses other lines, paint the full route and place guides
on both sides of the crossing and turn. Try 2D tracing if Auto cannot resolve it.
The UI identifies settings that do not apply to 2D tracing.

引导点可以具有相同的 X 或 Y。对于横向转垂直、又与其他线交叉的曲线，
建议涂画完整路径，并在交叉和转弯两侧补引导点。自动模式无法判断时可尝试
二维追踪；界面会说明哪些参数不适用于二维模式。

## Failed tracing / 追踪失败

An incompatible Pen or guide configuration retains the previous coordinates,
but hides obsolete circles and blocks editing/export. A persistent warning above
the canvas identifies the failure; strict-Pen conflicts name guides outside the
painted area. Extend the painted route, adjust a guide,
or undo the change, then retry. Small raster-edge corrections are marked as
inferred, not observed. Changing point count or export density retains guides
and validates the resulting points against that curve's Pen.

Pen 或引导点约束冲突时，会保留上一次坐标，但隐藏失效的圆点并暂停编辑和导出。
画布上方会持续显示失败原因；严格 Pen 模式会指出未被涂画覆盖的引导点编号。
请补涂路径、调整引导点，或撤销修改后重试。少量像素边缘修正会标为推断点，
不会冒充直接观测。修改点数及导出密度时，也会保留引导点并检查该曲线的 Pen。

Continuous paths are checked cell by cell, independently of output point count;
even a one-pixel eraser cut cannot be skipped by sparse sampling. Sparse output
circles are not connected: when dense source geometry is available, that route
is checked instead of straight chords between the circles. Separate markers
are not treated as a connected curve.

连续曲线会逐格检查，不依赖输出点数；稀疏采样也不能跳过一个像素的擦除缺口。
输出圆点不是连线：有完整原始路径时检查该路径，而不是圆点间的直线弦。
离散标记点不会被当作连续曲线连接。

Reducing marker count only selects existing measurements, never interpolates
new markers. All manual guides are retained, even when they outnumber the
requested count; the count field then shows the actual number.
For discrete markers, a guide retains the selected measured centre, which may
differ slightly from the click; continuous-line guides keep exact coordinates.
减少标记点数量只会选取已有观测，不会插值生成新标记。手工引导点始终保留，
即使其数量超过所填点数；点数输入框会显示实际保留的数量。
离散标记保留引导点选中的实测中心，该中心可能与点击位置略有差别；连续曲线则严格保留引导坐标。

Pen and interpolation cannot recover information that is absent from the image;
occluded sections and ambiguous crossings still need review.
Pen 和插值无法恢复图中已经缺失的信息；遮挡段和有歧义的交叉处仍需复核。
If a wide Pen contains two same-colour curves, both remain eligible; narrow the
stroke or add guides on both sides of the ambiguous section. Local assistance
does not identify the target outside the painted sections by itself.
宽 Pen 若同时包含两条同色曲线，两条都可能被识别；请缩窄笔迹，或在歧义区段
两侧添加引导点。局部辅助本身不会确定未涂区域的目标身份。

Dark neutral targets use both hue and luminance, so shaded grey-blue regions
are not mistaken for black ink. Mixed-direction guides can trigger 2D tracing
without a Pen. Local Pen entries may reconnect an unambiguous gap of at most
6 px using only allowed pixels; those added points are marked inferred.

深色目标同时比较色相与亮度，避免把灰蓝底色当成黑线。混合方向的引导点即使
没有 Pen 也可触发二维追踪。局部 Pen 接口处最多 6 px 的无歧义短断口可在允许
区域内连接，补出的点会标为推断点，不会跨过擦除的孔洞。

Optional regression for the externally supplied 1243 × 811 regime diagram
(image not included) / 原始相图的可选本地回归测试（不收录原图）：

```sh
node tools/real-pen-smoke.mjs /path/to/regime-diagram.png
```
