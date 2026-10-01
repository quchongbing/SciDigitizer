# Pen and near-vertical curves / Pen 与近垂直曲线

Ordinary curves still start with **Pick target curve**. Pen is optional.
普通曲线仍从“选择目标曲线”开始；Pen 是可选辅助工具。

## Pen scope / 约束范围

- **Local assistance (optional):** each painted section is constrained, including
  unpainted pixels beside it. Tracing may continue beyond its two end boundaries,
  shown as dashed lines, but cannot bypass the section on a neighbouring curve.
  End directions come from the brush geometry, so vertical strokes and turns do
  not depend on the selected tracing orientation. Follow the curve when painting
  a turn; a closed stroke has no exit. A single dab has no reliable direction.
  **局部辅助（可选）：**已涂区段只能在 Pen 内搜索，不能从侧面绕到其它曲线；
  允许越过笔迹两端的虚线边界接续。端点方向由笔迹确定，横向、竖向和转弯
  遵守同一范围。转弯处请顺着曲线涂画；闭合笔迹没有出口，单个点涂无法确定方向。
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
旧项目里绕过局部 Pen 的数据会保留，但恢复时会标记为需要重新追踪，不能
继续作为有效结果直接导出。不要把“完整涂画”模式用于只画了一小段的笔迹。

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

Pen and interpolation cannot recover information that is absent from the image;
occluded sections and ambiguous crossings still need review.
Pen 和插值无法恢复图中已经缺失的信息；遮挡段和有歧义的交叉处仍需复核。

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
